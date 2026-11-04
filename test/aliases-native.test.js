import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { deriveState } from '../src/derive.js';
import { foldEvents } from '../src/fold.js';
import { buildIndex, eventSearchText } from '../src/indexer.js';
import { recall } from '../src/recall.js';
import { readReceipts } from '../src/recall-log.js';
import { validateEvent } from '../src/schema.js';
import { initRoot } from '../src/storage/files.js';
import { appendEvent, rebuildState } from '../src/storage/event-log.js';

const NOW = Date.parse('2026-11-04T12:00:00+08:00');

function event(id, kind, text, extra = {}) {
  return {
    id,
    ts: new Date(NOW).toISOString(),
    kind,
    text,
    weight: 3,
    scope: 'local',
    src: 'agent',
    sess: 'aliases-native-test',
    ...extra,
  };
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-alias-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return resolveConfig({
    workspace: root,
    root: path.join(root, '.dsh-mem'),
    globalRoot: path.join(root, 'global-memory'),
  });
}

function receiptFor(root, state, query) {
  const result = recall(state, buildIndex(state), query, { now: NOW, log: root });
  return { result, receipt: readReceipts(root, { limit: 1 })[0] };
}

test('N1：条目自带俗称按最长完整短语增加 base，并记录 aliasHit', async (t) => {
  const config = workspace(t);
  const written = await appendEvent(config, {
    kind: 'note',
    text: 'dsh-fish 已停止运行。',
    aliases: ['鱼插件', '养鱼的插件'],
    sess: 'n1',
  });
  const state = await rebuildState(config.localRoot, { ...config, recordRebuild: false });
  const { result, receipt } = receiptFor(config.localRoot, state, '请检查鱼插件当前状态');
  const candidate = receipt.candidates.find(({ id }) => id === written.id);

  assert.equal(result.items.some(({ id }) => id === written.id), true);
  assert.equal(candidate.base, 6);
  assert.equal(candidate.aliasHit, true);

  const capped = receiptFor(config.localRoot, state, '养鱼的插件现在怎样').receipt
    .candidates.find(({ id }) => id === written.id);
  assert.equal(capped.base, 8);
});

test('N2：alias 事件能给已有条目补俗称并参与打分', (t) => {
  const target = event('m_native1_0001', 'note', 'dsh-fish 已停止运行。');
  const alias = event('m_native2_0002', 'alias', '审核通过俗称“养鱼插件”。', {
    refs: [target.id],
    aliases: ['养鱼插件'],
    quote: '大家把 dsh-fish 叫作养鱼插件。',
    src: 'review',
  });
  const state = deriveState([target, alias]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-alias-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { result, receipt } = receiptFor(
    root,
    state,
    '养鱼插件坏了吗',
  );
  const candidate = receipt.candidates.find(({ id }) => id === target.id);

  assert.deepEqual(state.aliases[target.id], {
    aliases: ['养鱼插件'],
    quote: alias.quote,
  });
  assert.equal(result.items.some(({ id }) => id === target.id), true);
  assert.equal(candidate.base, 8);
  assert.equal(candidate.aliasHit, true);
});

test('N3：replaces 继承俗称，旧条目 retract 后不参与召回', () => {
  const old = event('m_native3_0003', 'note', 'dsh-fish 旧状态。', {
    aliases: ['养鱼插件'],
  });
  const replacement = event('m_native4_0004', 'note', 'dsh-fish 新状态。', {
    replaces: [old.id],
  });
  const retract = event('m_native5_0005', 'retract', '旧条目已撤回。', {
    refs: [old.id],
  });
  const state = deriveState([old, replacement, retract]);
  const result = recall(state, buildIndex(state), '养鱼插件', { now: NOW });

  assert.deepEqual(state.aliases[replacement.id]?.aliases, ['养鱼插件']);
  assert.equal(state.status[old.id].status, 'retracted');
  assert.equal(result.items.some(({ id }) => id === replacement.id), true);
  assert.equal(result.items.some(({ id }) => id === old.id), false);

  const fact = event('m_nativec_000c', 'fact', '插件状态为旧值。', {
    key: '插件.状态',
    aliases: ['养鱼插件'],
  });
  const revise = event('m_natived_000d', 'revise', '插件状态已纠正。', {
    key: '插件.状态',
    refs: [fact.id],
  });
  const revisedState = deriveState([fact, revise]);
  assert.deepEqual(revisedState.aliases[revise.id]?.aliases, ['养鱼插件']);
});

test('N4：俗称不进入 eventSearchText，且不改变 df', () => {
  const plain = event('m_native6_0006', 'note', 'dsh-fish 已停止运行。');
  const aliased = { ...plain, aliases: ['养鱼插件'] };
  const plainIndex = buildIndex(deriveState([plain]));
  const aliasIndex = buildIndex(deriveState([aliased]));

  assert.equal(eventSearchText(aliased).includes('养鱼插件'), false);
  assert.deepEqual(aliasIndex.df, plainIndex.df);
});

test('N5：删除 state.json 后 aliases 可逐字节一致重建', async (t) => {
  const config = workspace(t);
  const target = await appendEvent(config, {
    kind: 'note',
    text: 'dsh-fish 已停止运行。',
    aliases: ['鱼插件'],
    sess: 'n5',
  });
  await appendEvent(config, {
    kind: 'alias',
    text: '审核通过俗称“养鱼插件”。',
    refs: [target.id],
    aliases: ['养鱼插件', '鱼插件'],
    quote: '以后提到养鱼插件就是 dsh-fish。',
    proposal: {
      signal: 'paraphrase',
      sess: 'proposal-session',
      proposedAt: '2026-11-04T03:00:00.000Z',
    },
    src: 'review',
    sess: 'n5-review',
  });
  const before = JSON.stringify(
    JSON.parse(fs.readFileSync(path.join(config.localRoot, 'state.json'), 'utf8')).aliases,
  );

  fs.rmSync(path.join(config.localRoot, 'state.json'));
  await rebuildState(config.localRoot, { ...config, recordRebuild: false });
  const after = JSON.stringify(
    JSON.parse(fs.readFileSync(path.join(config.localRoot, 'state.json'), 'utf8')).aliases,
  );

  assert.equal(after, before);
});

test('N6：src=review 只允许 alias/symptom 内部事件', () => {
  const note = event('m_native7_0007', 'note', '普通条目。', { src: 'review' });
  const alias = event('m_native8_0008', 'alias', '审核通过俗称。', {
    refs: ['m_native7_0007'],
    aliases: ['普通俗称'],
    quote: '普通俗称是主人原话。',
    src: 'review',
  });
  const symptom = event('m_native9_0009', 'symptom', '审核补录症状词。', {
    refs: ['m_native7_0007'],
    symptoms: ['普通报错'],
    src: 'review',
  });

  assert.throws(() => validateEvent(note), (error) => error.code === 'E_SCHEMA');
  assert.doesNotThrow(() => validateEvent(alias));
  assert.doesNotThrow(() => validateEvent(symptom));
});

test('fold：alias 事件随被归档目标进入引用闭包', async (t) => {
  const config = workspace(t);
  initRoot(config.localRoot);
  const target = event('m_native9_0009', 'note', '待归档旧条目。', {
    ts: '2020-01-01T00:00:00.000Z',
  });
  const alias = event('m_nativea_000a', 'alias', '审核通过旧条目俗称。', {
    ts: '2026-11-01T00:00:00.000Z',
    refs: [target.id],
    aliases: ['旧条俗称'],
    quote: '旧条俗称指旧条目。',
    src: 'review',
  });
  const retract = event('m_nativeb_000b', 'retract', '旧条目已撤回。', {
    ts: '2026-11-02T00:00:00.000Z',
    refs: [target.id],
  });
  fs.writeFileSync(
    path.join(config.localRoot, 'events.jsonl'),
    `${[target, alias, retract].map((item) => JSON.stringify(item)).join('\n')}\n`,
  );
  await rebuildState(config.localRoot, { ...config, recordRebuild: false });
  const folded = await foldEvents(config, {
    now: '2026-11-04T12:00:00.000Z',
    retentionMs: 24 * 60 * 60 * 1000,
  });
  const archived = fs.readFileSync(folded.archive, 'utf8')
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));

  assert.deepEqual(archived.map(({ id }) => id), [target.id, alias.id]);
  const rebuilt = await rebuildState(config.localRoot, { ...config, recordRebuild: false });
  assert.deepEqual(rebuilt.aliases[target.id]?.aliases, ['旧条俗称']);
});
