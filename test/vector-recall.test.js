import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { deriveState } from '../src/derive.js';
import { prepareRecallVector } from '../src/host.js';
import { buildIndex } from '../src/indexer.js';
import { pinnedIds } from '../src/l0.js';
import { recall, vectorAdjustedBase } from '../src/recall.js';
import { readReceipts } from '../src/recall-log.js';

const NOW = Date.parse('2026-11-04T12:00:00+08:00');

function event(id, text, extra = {}) {
  return {
    id,
    ts: new Date(NOW).toISOString(),
    kind: 'note',
    text,
    sess: 'vector-test',
    weight: 3,
    ...extra,
  };
}

function prepared(events) {
  const state = deriveState(events);
  return { state, index: buildIndex(state) };
}

function vec(cosById, extra = {}) {
  return { cosById, floor: 0.5, beta: 0.5, ...extra };
}

test('向量融合公式按 floor、beta 与 B_q 计算并裁剪 s', () => {
  assert.deepEqual(
    vectorAdjustedBase(1, 0.75, { floor: 0.5, beta: 0.5, queryBase: 3 }),
    { base: 1.5, s: 0.5 },
  );
  assert.deepEqual(
    vectorAdjustedBase(1, 0.1, { floor: 0.5, beta: 0.5, queryBase: 3 }),
    { base: 1, s: 0 },
  );
  assert.deepEqual(
    vectorAdjustedBase(1, 2, { floor: 0.5, beta: 0.5, queryBase: 3 }),
    { base: 2, s: 1 },
  );
});

test('字面候选不足两条时最多放两条纯向量结果并加 [相近] 前缀', () => {
  const events = Array.from({ length: 5 }, (_, index) => (
    event(`m_vec${index}`, `完全不同的正文 ${index}`)
  ));
  const { state, index } = prepared(events);
  const cosById = Object.fromEntries(events.map((item, position) => [item.id, 0.99 - position * 0.01]));
  const result = recall(state, index, '银河检索词', {
    now: NOW,
    limit: 4,
    vec: vec(cosById),
  });

  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((item) => item.text.startsWith('[相近] ')));
});

test('字面候选至少两条时纯向量结果最多一条，回执记录 vec_quota 与向量字段', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-vector-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [
    event('m_lex1', '星河协议字面命中一'),
    event('m_lex2', '星河协议字面命中二'),
    event('m_vec1', '无关正文甲'),
    event('m_vec2', '无关正文乙'),
    event('m_vec3', '无关正文丙'),
  ];
  const { state, index } = prepared(events);
  let receipt;
  const result = recall(state, index, '星河协议', {
    now: NOW,
    limit: 4,
    log: root,
    onReceipt: (full) => { receipt = full; },
    vec: vec({ m_lex1: 0.7, m_lex2: 0.7, m_vec1: 0.99, m_vec2: 0.98, m_vec3: 0.97 }),
  });
  const similar = result.items.filter((item) => item.text.startsWith('[相近] '));
  // 向量分量只在内存回执里；落盘版只留前 5 名的 id/score/why/base。
  assert.equal(readReceipts(root, { limit: 1 })[0].receipt_id, result.receipt_id);
  const quota = receipt.candidates.filter((candidate) => candidate.why === 'vec_quota');

  assert.equal(similar.length, 1);
  assert.ok(quota.length >= 1);
  assert.ok(receipt.candidates.every((candidate) => (
    Object.hasOwn(candidate, 'cos')
    && Object.hasOwn(candidate, 's')
    && Object.hasOwn(candidate, 'vecOnly')
  )));
});

test('只靠向量命中的 L0 条目会跳过', () => {
  const rules = Array.from({ length: 6 }, (_, index) => (
    event(`m_rule${index}`, `常驻红线 ${index}`, { kind: 'rule', weight: 5 })
  ));
  const other = event('m_other', '普通无关正文');
  const { state, index } = prepared([...rules, other]);
  const resident = pinnedIds(state, { now: new Date(NOW), health: {} });
  const pinned = [...resident][0];
  const result = recall(state, index, '银河检索词', {
    now: NOW,
    vec: vec({ [pinned]: 0.999, [other.id]: 0.99 }),
  });

  assert.equal(result.items.some((item) => item.id === pinned), false);
  assert.equal(result.items.some((item) => item.id === other.id), true);
});

test('向量关闭时召回结果与无 opts.vec 的字面结果逐字节一致', () => {
  const { state, index } = prepared([
    event('m_a', '星河协议当前状态'),
    event('m_b', '另一条普通记录'),
  ]);
  const baseline = recall(state, index, '星河协议', { now: NOW });
  const disabled = recall(state, index, '星河协议', { now: NOW, vec: undefined });
  assert.equal(JSON.stringify(disabled), JSON.stringify(baseline));
});

test('索引过期立即降级并记 health，后台重建不阻塞当前轮', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-vector-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let scheduled = 0;
  const config = resolveConfig({
    root,
    globalRoot: path.join(root, 'global'),
    vector: { enabled: true },
    vectorRuntime: {
      inspectVecIndex: async () => ({ status: 'stale' }),
      scheduleVecIndexBuild: () => {
        scheduled += 1;
        return new Promise(() => {});
      },
      client: { encode: async () => assert.fail('stale index must not encode'), disabledReason: null },
    },
  });
  const result = await prepareRecallVector(config, '星河协议');
  const health = JSON.parse(fs.readFileSync(path.join(root, 'health.json'), 'utf8'));

  assert.equal(result, null);
  assert.equal(scheduled, 1);
  assert.equal(health.vec_index_stale, true);
});

test('模型缺失降级为 null 并把原因写进 health', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-vector-disabled-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = resolveConfig({
    root,
    globalRoot: path.join(root, 'global'),
    vector: { enabled: true },
    vectorRuntime: {
      inspectVecIndex: async () => ({
        status: 'current',
        index: { metadata: { cosineFloorP90: 0.5 } },
      }),
      client: {
        encode: async () => null,
        disabledReason: 'model missing',
      },
    },
  });
  const result = await prepareRecallVector(config, '星河协议');
  const health = JSON.parse(fs.readFileSync(path.join(root, 'health.json'), 'utf8'));

  assert.equal(result, null);
  assert.equal(health.vector_disabled, 'model missing');
});
