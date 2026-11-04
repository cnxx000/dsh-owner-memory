import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { memAudit } from '../src/audit.js';
import { resolveConfig } from '../src/config.js';
import { deriveState } from '../src/derive.js';
import { buildIndex } from '../src/indexer.js';
import { recall, RECALL_WHY } from '../src/recall.js';
import { appendReceipt, readReceipts } from '../src/recall-log.js';
import { readJson } from '../src/storage/files.js';
import { memFact } from '../src/tools/mem_fact.js';
import { memNote } from '../src/tools/mem_note.js';

const NOW = Date.parse('2026-11-02T12:00:00+08:00');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return resolveConfig({ workspace: root });
}

function event(id, kind, text, extra = {}) {
  return {
    id,
    ts: extra.ts ?? new Date(NOW - Number(id.replace(/\D/gu, '') || 0) * 1000).toISOString(),
    kind,
    text,
    sess: 'audit-test',
    weight: 5,
    ...extra,
  };
}

function prepared(events) {
  const state = deriveState(events);
  return { state, index: buildIndex(state) };
}

test('A20：召回回执的每条未入选候选都有枚举原因码', async (t) => {
  const config = workspace(t);
  const events = [
    event('m_1', 'note', `目标查询${'很长正文'.repeat(20)}`),
    event('m_2', 'note', '目标查询短条'),
    event('m_3', 'note', '目标查询第三条'),
    event('m_4', 'note', '目标分支', {
      weight: 1,
      ts: '2020-01-01T00:00:00.000Z',
    }),
    event('m_5', 'note', '完全无关的内容'),
    event('m_6', 'fact', '目标查询旧事实', { key: '审计.目标' }),
    event('m_7', 'fact', '新事实没有查询词', { key: '审计.目标' }),
  ];
  const { state, index } = prepared(events);
  const result = recall(state, index, '目标查询', {
    limit: 2,
    maxChars: 25,
    now: NOW,
    log: config.localRoot,
  });
  const receipt = await memAudit(config, { what: 'recall', receipt_id: result.receipt_id });
  const allowed = new Set(Object.values(RECALL_WHY));

  assert.ok(receipt.candidates.length >= events.length);
  for (const candidate of receipt.candidates.filter((item) => !item.picked)) {
    assert.ok(candidate.why);
    assert.ok(allowed.has(candidate.why), `未知原因码：${candidate.why}`);
  }
  const reasons = new Set(receipt.candidates.map((item) => item.why).filter(Boolean));
  for (const expected of [
    RECALL_WHY.BELOW_THRESHOLD,
    RECALL_WHY.STATUS_PENALTY,
    RECALL_WHY.OVER_LIMIT,
    RECALL_WHY.OVER_CHARS,
    RECALL_WHY.NO_MATCH,
  ]) {
    assert.ok(reasons.has(expected), `缺少原因码：${expected}`);
  }
});

test('§9.1 原因码逐条可产生', async (t) => {
  const config = workspace(t);
  const budgetFixture = prepared([
    event('m_1', 'note', `目标查询${'很长正文'.repeat(20)}`),
    event('m_2', 'note', '目标查询短条'),
    event('m_3', 'note', '目标查询第三条'),
    event('m_4', 'note', '目标分支', { weight: 1, ts: '2020-01-01T00:00:00.000Z' }),
    event('m_5', 'note', '完全无关的内容'),
    event('m_6', 'fact', '目标查询旧事实', { key: '审计.目标' }),
    event('m_7', 'fact', '新事实没有查询词', { key: '审计.目标' }),
  ]);
  recall(budgetFixture.state, budgetFixture.index, '目标查询', {
    limit: 2,
    maxChars: 25,
    now: NOW,
    log: config.localRoot,
  });

  const baseEvents = [
    event('m_11', 'note', '目标查询普通记录'),
    event('m_12', 'fact', '目标查询事实记录', { key: '审计.筛选' }),
    event('m_13', 'rule', '目标查询前必须确认', { weight: 1 }),
  ];
  const basic = prepared(baseEvents);
  recall(basic.state, basic.index, '目标查询', {
    kinds: ['fact'],
    since: '2026-11-02T00:00:00.000Z',
    now: NOW,
    log: config.localRoot,
  });
  recall(basic.state, basic.index, '目标查询', {
    since: '2027-01-01T00:00:00.000Z',
    now: NOW,
    log: config.localRoot,
  });

  const seatEvents = [];
  for (let index = 1; index <= 7; index += 1) {
    seatEvents.push(event(`m_2${index}`, 'rule', `常驻红线 ${index}：提交前确认。`, {
      weight: index <= 6 ? 5 : 4,
    }));
  }
  seatEvents.push(event('m_28', 'rule', '星云配置 maxChars 修改前必须备份。', { weight: 1 }));
  for (let index = 1; index <= 5; index += 1) {
    seatEvents.push(event(
      `m_3${index}`,
      'note',
      `星云配置 maxChars 修改细节 ${'maxChars '.repeat(index)}`,
      { weight: 5 },
    ));
  }
  const seatFixture = prepared(seatEvents);
  recall(seatFixture.state, seatFixture.index, '星云配置 maxChars', {
    limit: 4,
    now: NOW,
    log: config.localRoot,
  });

  const vectorFixture = prepared([
    event('m_v1', 'note', '无关向量记录一'),
    event('m_v2', 'note', '无关向量记录二'),
    event('m_v3', 'note', '无关向量记录三'),
  ]);
  recall(vectorFixture.state, vectorFixture.index, '银河检索词', {
    limit: 4,
    now: NOW,
    log: config.localRoot,
    vec: {
      cosById: { m_v1: 0.99, m_v2: 0.98, m_v3: 0.97 },
      floor: 0.5,
      beta: 0.5,
    },
  });

  const reasons = new Set(readReceipts(config.localRoot)
    .flatMap((receipt) => receipt.candidates)
    .map((candidate) => candidate.why)
    .filter(Boolean));
  assert.deepEqual(
    [...Object.values(RECALL_WHY)].sort(),
    [...reasons].filter((reason) => Object.values(RECALL_WHY).includes(reason)).sort(),
  );
});

test('recall-log 每次追加后只保留最新 200 条', (t) => {
  const config = workspace(t);
  for (let index = 1; index <= 220; index += 1) {
    appendReceipt(config.localRoot, {
      receipt_id: `r_${index}`,
      ts: new Date(NOW + index).toISOString(),
      query: `q${index}`,
      grams: [],
      picked: [],
      chars: 0,
      candidates: [],
    });
  }
  const lines = fs.readFileSync(path.join(config.localRoot, 'recall-log.jsonl'), 'utf8')
    .split(/\r?\n/u).filter(Boolean);
  const receipts = readReceipts(config.localRoot);
  assert.equal(lines.length, 200);
  assert.equal(receipts.length, 200);
  assert.equal(receipts[0].receipt_id, 'r_220');
  assert.equal(receipts.at(-1).receipt_id, 'r_21');
});

test('health 返回六张清单并复用 suspectedShouldBeFact', async (t) => {
  const config = workspace(t);
  const first = await memFact(config, {
    key: '主人.编辑器偏好',
    text: '主人先前偏好编辑器 A。',
  }, { sessionId: 'audit-health-1' });
  await memFact(config, {
    key: '主人.编辑器偏好',
    text: '主人当前偏好编辑器 B。',
  }, { sessionId: 'audit-health-2' });
  const suspect = await memNote(config, {
    kind: 'note',
    text: '需要复查编辑器偏好这项记录。',
  }, { sessionId: 'audit-health-note' });

  const stateFile = path.join(config.localRoot, 'state.json');
  const state = readJson(stateFile);
  state.status[first.id] = { status: 'active' };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const eventsBefore = fs.readFileSync(path.join(config.localRoot, 'events.jsonl'), 'utf8');
  const healthFile = path.join(config.localRoot, 'health.json');
  const storedHealth = readJson(healthFile);
  storedHealth.injection_missing = true;
  storedHealth.injection = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    `${process.pid}:agent-${index}`,
    {
      personaHash: `hash-${index}`,
      verdict: index === 1 ? 'missing' : 'ok',
      reason: index === 1 ? 'not_registered' : 'cached',
      ts: new Date(NOW + index).toISOString(),
      pid: process.pid,
    },
  ]));
  fs.writeFileSync(healthFile, `${JSON.stringify(storedHealth, null, 2)}\n`);
  const health = await memAudit(config, { what: 'health', now: NOW });

  assert.deepEqual(Object.keys(health), [
    'contradictions',
    'fading',
    'almost_solid',
    'superseded',
    'suspected_should_be_fact',
    'injection',
    'metrics',
  ]);
  assert.equal(health.contradictions.length, 1);
  assert.ok(health.suspected_should_be_fact.includes(suspect.id));
  assert.equal(typeof health.metrics.rules_overflow, 'boolean');
  assert.equal(typeof health.metrics.injection_missing, 'boolean');
  assert.equal(health.injection.length, 5);
  assert.equal(health.injection[0].verdict, 'missing');
  assert.equal(health.injection[0].reason, 'not_registered');
  assert.equal(health.injection[0].ts, new Date(NOW + 1).toISOString());
  assert.equal(fs.readFileSync(path.join(config.localRoot, 'events.jsonl'), 'utf8'), eventsBefore);

  const key = await memAudit(config, { what: 'key', key: '主人.编辑器偏好' });
  const id = await memAudit(config, { what: 'id', id: first.id });
  const status = await memAudit(config, { what: 'status' });
  assert.equal(key.items.length, 2);
  assert.equal(id.items[0].id, first.id);
  assert.equal(status.enabled, true);

  // 旧 health.json 没有 injection 对象时仍返回空明细。
  const legacy = readJson(healthFile);
  delete legacy.injection;
  fs.writeFileSync(healthFile, `${JSON.stringify(legacy, null, 2)}\n`);
  assert.deepEqual((await memAudit(config, { what: 'health', now: NOW })).injection, []);
});

test('H1：health 统计 active 条目的 src=user 占比', async (t) => {
  const config = workspace(t);
  await memNote(config, {
    kind: 'note',
    text: '这是一条由 agent 写入的观察记录。',
  }, { sessionId: 'audit-src-agent' });

  const before = await memAudit(config, { what: 'health', now: NOW });
  assert.equal(before.metrics.src_user_ratio, 0);
  assert.equal(before.metrics.src_user_count, 0);
  assert.equal(before.metrics.src_total_count, 1);

  await memNote(config, {
    kind: 'note',
    text: '这是一条由用户明确提供的观察记录。',
    src: 'user',
  }, { sessionId: 'audit-src-user' });

  const after = await memAudit(config, { what: 'health', now: NOW });
  assert.equal(after.metrics.src_user_ratio, 0.5);
  assert.equal(after.metrics.src_user_count, 1);
  assert.equal(after.metrics.src_total_count, 2);
});
