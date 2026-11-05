import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { buildIndex } from '../src/indexer.js';
import { scoreEvent } from '../src/score.js';
import { readJson } from '../src/storage/files.js';
import { readEvents } from '../src/storage/event-log.js';
import { memFact } from '../src/tools/mem_fact.js';
import { memNote } from '../src/tools/mem_note.js';
import { bigramJaccard, dedupSimilarity } from '../src/write/dedup.js';
import { suspectedShouldBeFact } from '../src/write/smell.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-write-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return resolveConfig({ workspace: root });
}

test('mem_fact 拒绝未来验证时间，并持久化有效 verifiedAt', async (t) => {
  const config = workspace(t);
  const eventFile = path.join(config.localRoot, 'events.jsonl');
  const future = new Date(Date.now() + 5 * 60_000).toISOString();

  await assert.rejects(
    memFact(config, {
      key: '测试.未来验证',
      text: '这条事实不应写入。',
      verifiedAt: future,
    }, { sessionId: 'verified-future' }),
    (error) => error.code === 'E_FUTURE_TIME' && /验证时间不能晚于现在/u.test(error.message),
  );
  assert.equal(fs.existsSync(eventFile), false);

  const past = '2026-01-02T03:04:05+08:00';
  const explicit = await memFact(config, {
    key: '测试.过去验证',
    text: '这条事实使用显式验证时间。',
    verifiedAt: past,
  }, { sessionId: 'verified-past' });
  const implicit = await memFact(config, {
    key: '测试.默认验证',
    text: '这条事实使用事件时间。',
  }, { sessionId: 'verified-default' });

  const events = readEvents(config.localRoot).events;
  const state = readJson(path.join(config.localRoot, 'state.json'));
  const explicitEvent = events.find((event) => event.id === explicit.id);
  const implicitEvent = events.find((event) => event.id === implicit.id);
  assert.equal(explicitEvent.verifiedAt, past);
  assert.equal(state.byId[explicit.id].verifiedAt, past);
  assert.equal(implicitEvent.verifiedAt, implicitEvent.ts);
  assert.equal(state.byId[implicit.id].verifiedAt, implicitEvent.ts);
});

test('A22：同一句 mem_note 三次只写一条正文并累计两次确认', async (t) => {
  const config = workspace(t);
  const args = { kind: 'note', text: '沙箱写入失败时先检查工作区权限。' };
  const first = await memNote(config, args, { sessionId: 'a22-1' });
  const second = await memNote(config, args, { sessionId: 'a22-2' });
  const third = await memNote(config, args, { sessionId: 'a22-3' });
  const events = readEvents(config.localRoot).events;
  const state = readJson(path.join(config.localRoot, 'state.json'));

  assert.equal(events.filter((event) => event.kind !== 'confirm').length, 1);
  assert.equal(events.filter((event) => event.kind === 'confirm').length, 2);
  assert.equal(second.duplicate, true);
  assert.equal(third.duplicate, true);
  assert.equal(second.id, first.id);
  assert.equal(third.id, first.id);
  assert.equal(state.confirmCount[first.id] ?? 0, 2);
  assert.ok(state.lastSeenAt[first.id]);

  await memNote(config, {
    kind: 'note',
    text: '这是另一条完全不同的部署记录。',
  }, { sessionId: 'a22-distinct' });
  const afterAppend = readJson(path.join(config.localRoot, 'state.json'));
  assert.equal(afterAppend.confirmCount[first.id], 2);
});

test('A27：近似重复写入成功并提示首条 id', async (t) => {
  const config = workspace(t);
  const oldText = '沙箱写不进 .dsh，shell 和 edit 都被拒';
  const newText = '沙箱写不进 .dsh，但带 danger-full-access 提权重试能写';
  const first = await memNote(config, { kind: 'note', text: oldText }, { sessionId: 'a27-1' });
  const second = await memNote(config, { kind: 'note', text: newText }, { sessionId: 'a27-2' });

  assert.equal(second.status, 'written');
  assert.equal(readEvents(config.localRoot).events.length, 2);
  assert.ok(second.warnings?.some((warning) => warning.includes(first.id)));
  assert.ok(bigramJaccard(oldText, newText) < 0.55);
  assert.ok(dedupSimilarity(oldText, newText) >= 0.55);
  assert.ok(dedupSimilarity(oldText, newText) < 0.85);
});

test('A23：3a 同时命中对象与方面时提示，但不阻断写入', async (t) => {
  const config = workspace(t);
  await memFact(config, {
    key: '主人.编辑器偏好',
    text: '主人当前偏好使用 VS Code。',
  }, { sessionId: 'a23-fact' });

  const covered = await memNote(config, {
    kind: 'note',
    text: '主人的编辑器偏好是 Cursor',
  }, { sessionId: 'a23-covered' });
  assert.equal(covered.status, 'written');
  assert.ok(covered.warnings?.some((warning) => (
    warning.includes("mem_fact(key='主人.编辑器偏好')")
    && warning.includes(covered.id)
  )));

  const aspectOnly = await memNote(config, {
    kind: 'note',
    text: '需要复查编辑器偏好这项记录。',
  }, { sessionId: 'a23-aspect-only' });
  assert.equal(aspectOnly.status, 'written');
  assert.equal(aspectOnly.warnings, undefined);
  t.diagnostic(`aspect-only-id=${aspectOnly.id}`);
});

test('A23b：3b 清单只读、稳定并按 ts/id 升序', async (t) => {
  const config = workspace(t);
  await memFact(config, {
    key: '主人.编辑器偏好',
    text: '主人当前偏好使用 VS Code。',
  }, { sessionId: 'a23b-fact' });
  const covered = await memNote(config, {
    kind: 'note',
    text: '主人的编辑器偏好是 Cursor',
  }, { sessionId: 'a23b-covered' });
  const aspectOnly = await memNote(config, {
    kind: 'note',
    text: '需要复查编辑器偏好这项记录。',
  }, { sessionId: 'a23b-aspect-only' });

  const stateFile = path.join(config.localRoot, 'state.json');
  const eventFile = path.join(config.localRoot, 'events.jsonl');
  const beforeState = fs.readFileSync(stateFile, 'utf8');
  const beforeEvents = fs.readFileSync(eventFile, 'utf8');
  const state = JSON.parse(beforeState);
  const index = buildIndex(state);
  const target = state.byId[covered.id];
  const scoreNow = Date.now();
  const beforeScore = scoreEvent(state, index, target, '编辑器偏好', { now: scoreNow }).score;
  const first = suspectedShouldBeFact(state);
  const second = suspectedShouldBeFact(state);
  const afterScore = scoreEvent(state, index, target, '编辑器偏好', { now: scoreNow }).score;

  assert.ok(first.includes(covered.id));
  assert.ok(!first.includes(aspectOnly.id));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first, [...first].sort((left, right) => (
    Date.parse(state.byId[left].ts) - Date.parse(state.byId[right].ts)
    || left.localeCompare(right)
  )));
  assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeState);
  assert.equal(fs.readFileSync(eventFile, 'utf8'), beforeEvents);
  assert.equal(afterScore, beforeScore);
});

function smellState(notes) {
  const fact = { id: 'm_smell_fact', ts: '2026-11-01T00:00:00.000Z', kind: 'fact', key: 'dsh-fish.运行状态', text: 'dsh-fish 正常运行。' };
  const byId = { [fact.id]: fact };
  for (const note of notes) byId[note.id] = { ts: '2026-11-02T00:00:00.000Z', kind: 'note', ...note };
  return {
    byId,
    byKey: { [fact.key]: fact.id },
    status: Object.fromEntries(Object.keys(byId).map((id) => [id, { status: 'active' }])),
  };
}

test('F3：只提到 aspect 的 note 不进 suspected_should_be_fact', () => {
  const state = smellState([
    { id: 'm_smell_aspect', text: '今天检查了一下服务器的运行状态，一切正常。' },
    { id: 'm_smell_object', text: 'dsh-fish 的插件目录在桌面上。' },
  ]);
  assert.deepEqual(suspectedShouldBeFact(state), []);
});

test('F4：同时含 object 和 aspect 的 note 仍进 suspected_should_be_fact', () => {
  const state = smellState([
    { id: 'm_smell_both', text: 'dsh-fish 的运行状态：已停止。' },
    { id: 'm_smell_aspect', text: '记一下数据库的运行状态。' },
  ]);
  assert.deepEqual(suspectedShouldBeFact(state), ['m_smell_both']);
});
