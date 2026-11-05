import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initRoot, readJson } from '../src/storage/files.js';
import { rebuildState } from '../src/storage/event-log.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-rebuild-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, '.dsh-mem');
}

function id(index) {
  return `m_${(100_000 + index).toString(36)}_${index.toString(16).padStart(4, '0')}`;
}

function letters(value) {
  let result = '';
  let current = value;
  do {
    result = String.fromCharCode(97 + (current % 26)) + result;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);
  return result;
}

function baseEvent(index, kind, extra = {}) {
  return {
    id: id(index),
    ts: new Date(Date.UTC(2026, 10, 2, 0, 0, index)).toISOString(),
    kind,
    text: `2026-11-02 重建测试事件 ${index}。`,
    sess: 'rebuild-test',
    ...extra,
  };
}

function mixedEvents() {
  const events = [];
  const facts = [];
  const notes = [];
  const kinds = ['fact', 'note', 'rule', 'decision', 'todo'];
  for (let index = 0; index < 420; index += 1) {
    const kind = kinds[index % kinds.length];
    const extra = kind === 'fact' ? { key: `重建项目.属性${letters(index % 20)}` } : {};
    const item = baseEvent(index, kind, extra);
    events.push(item);
    if (kind === 'fact') facts.push(item.id);
    if (kind === 'note') notes.push(item.id);
  }
  for (let index = 0; index < 40; index += 1) {
    events.push(baseEvent(420 + index, 'revise', { refs: [notes[index]] }));
  }
  for (let index = 0; index < 40; index += 1) {
    events.push(baseEvent(460 + index, 'retract', { refs: [facts[index]] }));
  }
  return events;
}

test('A1：删除派生品后 state.json 可逐字节一致重建', async (t) => {
  const root = workspace(t);
  initRoot(root);
  const events = mixedEvents();
  assert.equal(events.length, 500);
  fs.writeFileSync(path.join(root, 'events.jsonl'), `${events.map((item) => JSON.stringify(item)).join('\n')}\n`);

  await rebuildState(root);
  const before = fs.readFileSync(path.join(root, 'state.json'), 'utf8');
  for (const name of ['state.json', 'events.jsonl.meta', 'index.json', 'pinned.md', 'health.json']) {
    fs.rmSync(path.join(root, name), { force: true });
  }
  await rebuildState(root);
  const after = fs.readFileSync(path.join(root, 'state.json'), 'utf8');

  assert.equal(after, before);
});

test('坏 JSON 使快路径失效一次，随后原始字节 sourceHash 恢复快路径', async (t) => {
  const root = workspace(t);
  initRoot(root);
  const events = mixedEvents().slice(0, 25);
  fs.writeFileSync(path.join(root, 'events.jsonl'), `${events.map((item) => JSON.stringify(item)).join('\n')}\n`);
  await rebuildState(root);
  const rebuiltBefore = readJson(path.join(root, 'health.json')).rebuilt;

  fs.appendFileSync(path.join(root, 'events.jsonl'), '{bad json\n');
  const state = await rebuildState(root);
  const healthAfterRebuild = readJson(path.join(root, 'health.json'));
  assert.equal(Object.keys(state.byId).length, events.length);
  assert.ok(healthAfterRebuild.corruptLines >= 1);
  assert.equal(healthAfterRebuild.rebuilt, rebuiltBefore + 1);

  await rebuildState(root);
  const healthAfterFastPath = readJson(path.join(root, 'health.json'));
  assert.equal(healthAfterFastPath.rebuilt, healthAfterRebuild.rebuilt);
});

test('C1：坏行按本轮实数计，清掉后重建归零，corruptLinesEver 保留峰值', async (t) => {
  const root = workspace(t);
  initRoot(root);
  const events = mixedEvents().slice(0, 10);
  const clean = `${events.map((item) => JSON.stringify(item)).join('\n')}\n`;
  const healthFile = path.join(root, 'health.json');

  fs.writeFileSync(path.join(root, 'events.jsonl'), `${clean}{bad 1\n{bad 2\n{bad 3\n`);
  await rebuildState(root);
  assert.equal(readJson(healthFile).corruptLines, 3);
  assert.equal(readJson(healthFile).corruptLinesEver, 3);

  // 同一批坏行再扫一遍（追加一条有效事件逼出重建），数不能虚增
  fs.appendFileSync(path.join(root, 'events.jsonl'), `${JSON.stringify(baseEvent(900, 'note'))}\n`);
  await rebuildState(root);
  assert.equal(readJson(healthFile).corruptLines, 3);
  assert.equal(readJson(healthFile).corruptLinesEver, 3);

  // 坏行被清掉后干净重建：当前归零，历史峰值还在
  fs.writeFileSync(path.join(root, 'events.jsonl'), clean);
  await rebuildState(root);
  const health = readJson(healthFile);
  assert.equal(health.corruptLines, 0);
  assert.equal(health.corruptLinesEver, 3);
  assert.ok(fs.readdirSync(path.join(root, 'corrupt')).length >= 1, 'preserveCorruptLine 留证不变');
});

test('C1b：旧 health 里挂着的历史峰值迁入 corruptLinesEver，当前值按实数回落', async (t) => {
  const root = workspace(t);
  initRoot(root);
  const events = mixedEvents().slice(0, 10);
  fs.writeFileSync(path.join(root, 'events.jsonl'), `${events.map((item) => JSON.stringify(item)).join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'health.json'), `${JSON.stringify({ corruptLines: 30, rebuilt: 0 })}\n`);
  await rebuildState(root);
  const health = readJson(path.join(root, 'health.json'));
  assert.equal(health.corruptLines, 0);
  assert.equal(health.corruptLinesEver, 30);
});
