import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { deriveState } from '../src/derive.js';
import { eventSearchText, buildIndex } from '../src/indexer.js';
import { renderPinned, selectFacts } from '../src/l0.js';
import { recall } from '../src/recall.js';
import { persistPinnedHealth, readJson } from '../src/storage/files.js';
import { readEvents, rebuildState } from '../src/storage/event-log.js';
import { memFact } from '../src/tools/mem_fact.js';
import { memNote } from '../src/tools/mem_note.js';

const execFileAsync = promisify(execFile);
const childConfirm = fileURLToPath(new URL('../fixtures/child-confirm.js', import.meta.url));

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-confirm-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return resolveConfig({ workspace: directory });
}

async function writeWithTwoConfirms(config) {
  const args = { kind: 'note', text: '重复出现的部署结论需要保留确认次数。' };
  const first = await memNote(config, args, { sessionId: 'confirm-first' });
  await memNote(config, args, { sessionId: 'confirm-second' });
  await memNote(config, args, { sessionId: 'confirm-third' });
  return first;
}

async function writeReplacedFacts(config) {
  await memFact(config, {
    key: '项目.竞争项',
    text: '项目竞争项当前使用稳定值。',
  }, { sessionId: 'fact-competitor' });
  for (const [index, value] of ['第一版', '第二版', '第三版'].entries()) {
    await memFact(config, {
      key: '项目.重复确认项',
      text: `项目重复确认项当前使用${value}。`,
    }, { sessionId: `fact-replace-${index}` });
  }
}

test('C1：两次去重命中写两条 confirm 并派生计数和末次时间', async (t) => {
  const config = workspace(t);
  const first = await writeWithTwoConfirms(config);
  const events = readEvents(config.localRoot).events;
  const confirms = events.filter((event) => event.kind === 'confirm');
  const state = readJson(path.join(config.localRoot, 'state.json'));

  assert.equal(confirms.length, 2);
  assert.ok(confirms.every((event) => (
    event.refs.length === 1
    && event.refs[0] === first.id
    && event.text === `确认：${first.id} 再次被想起。`
  )));
  assert.equal(state.confirmCount[first.id], 2);
  assert.equal(state.lastSeenAt[first.id], confirms[1].ts);
});

test('C2：删除 state 和 meta 后含 confirm 派生字段逐字节一致', async (t) => {
  const config = workspace(t);
  await writeWithTwoConfirms(config);
  const stateFile = path.join(config.localRoot, 'state.json');
  const before = fs.readFileSync(stateFile, 'utf8');

  fs.rmSync(stateFile);
  fs.rmSync(path.join(config.localRoot, 'events.jsonl.meta'));
  await rebuildState(config.localRoot, { ...config, recordRebuild: false });

  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});

test('C3：20 个 Windows 子进程并发确认无丢写', async (t) => {
  const config = workspace(t);
  const first = await memNote(config, {
    kind: 'note',
    text: '并发确认目标必须稳定存在。',
  }, { sessionId: 'confirm-seed' });

  await Promise.all(Array.from({ length: 20 }, (_, index) => (
    execFileAsync(process.execPath, [
      childConfirm,
      config.localRoot,
      first.id,
      `confirm-child-${index}`,
    ])
  )));

  const events = readEvents(config.localRoot).events;
  const state = readJson(path.join(config.localRoot, 'state.json'));
  assert.equal(events.filter((event) => event.kind === 'confirm').length, 20);
  assert.equal(state.confirmCount[first.id], 20);
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
});

test('C4：fact_overflow 只记录前八名中被渲染预算挤掉的键', (t) => {
  const config = workspace(t);
  const state = { byId: {}, byKey: {}, status: {}, confirmCount: {} };
  for (let index = 0; index < 9; index += 1) {
    const event = {
      id: `m_fact${index}_000${index}`,
      ts: new Date(Date.UTC(2026, 10, 1, 0, 0, index)).toISOString(),
      kind: 'fact',
      key: `项目.属性${index}`,
      text: `同分事实 ${index}`,
      weight: 4,
    };
    state.byId[event.id] = event;
    state.byKey[event.key] = event.id;
    state.status[event.id] = { status: 'active' };
  }
  const health = {};
  renderPinned(state, { now: new Date('2026-11-04T00:00:00.000Z'), health });
  persistPinnedHealth(config.localRoot, health);

  assert.deepEqual(health.fact_overflow, []);
  assert.deepEqual(
    readJson(path.join(config.localRoot, 'health.json')).fact_overflow,
    [],
  );
});

test('C5：confirm 不进搜索文本、索引或召回结果', async (t) => {
  const config = workspace(t);
  const first = await memNote(config, {
    kind: 'note',
    text: '召回只应返回用户可见的原始记忆。',
  }, { sessionId: 'recall-seed' });
  await memNote(config, {
    kind: 'note',
    text: '召回只应返回用户可见的原始记忆。',
  }, { sessionId: 'recall-confirm' });

  const state = readJson(path.join(config.localRoot, 'state.json'));
  const confirm = Object.values(state.byId).find((event) => event.kind === 'confirm');
  const index = buildIndex(state);
  const result = recall(state, index, `确认 ${first.id} 再次被想起`, { limit: 6 });

  assert.equal(eventSearchText(confirm), '');
  assert.ok(Object.values(index.postings).every((ids) => !ids.includes(confirm.id)));
  assert.ok(result.items.every((item) => item.id !== confirm.id));
});

test('F1：同键连写三次只把两次实际取代计为确认并参与 L0 排序', async (t) => {
  const config = workspace(t);
  await writeReplacedFacts(config);
  const state = readJson(path.join(config.localRoot, 'state.json'));
  const selected = selectFacts(state, { limit: 1, now: new Date() });

  assert.equal(state.confirmCount['项目.重复确认项'], 2);
  assert.equal(
    state.lastSeenAt['项目.重复确认项'],
    state.byId[state.byKey['项目.重复确认项']].ts,
  );
  assert.equal(selected[0].key, '项目.重复确认项');
});

test('F2：同键取代计数在删除 state 后逐字节一致重建', async (t) => {
  const config = workspace(t);
  await writeReplacedFacts(config);
  const stateFile = path.join(config.localRoot, 'state.json');
  const before = fs.readFileSync(stateFile, 'utf8');

  fs.rmSync(stateFile);
  fs.rmSync(path.join(config.localRoot, 'events.jsonl.meta'));
  await rebuildState(config.localRoot, { ...config, recordRebuild: false });

  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});

test('F3：旧同键事实已 retract 时新 fact 不计取代确认', () => {
  const key = '项目.已撤销项';
  const state = deriveState([
    {
      id: 'm_factold_0001',
      ts: '2026-11-01T00:00:00.000Z',
      kind: 'fact',
      key,
      text: '项目已撤销项曾使用旧值。',
      sess: 'fact-retract',
    },
    {
      id: 'm_retract_0002',
      ts: '2026-11-02T00:00:00.000Z',
      kind: 'retract',
      refs: ['m_factold_0001'],
      text: '撤销旧事实。',
      sess: 'fact-retract',
    },
    {
      id: 'm_factnew_0003',
      ts: '2026-11-03T00:00:00.000Z',
      kind: 'fact',
      key,
      text: '项目已撤销项现在使用新值。',
      sess: 'fact-retract',
    },
  ]);

  assert.equal(state.confirmCount[key] ?? 0, 0);
  assert.equal(state.lastSeenAt[key], undefined);
});
