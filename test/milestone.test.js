import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { initRoot, readJson } from '../src/storage/files.js';
import { readEvents } from '../src/storage/event-log.js';
import { memFact } from '../src/tools/mem_fact.js';
import { memFix } from '../src/tools/mem_fix.js';
import { memNote } from '../src/tools/mem_note.js';

const execFileAsync = promisify(execFile);
const childWriter = path.resolve('fixtures/child-writer.js');
const childLock = path.resolve('fixtures/child-lock.js');

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function rawLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean);
}

test('A2：20 个三入口混合并发写不丢行', async (t) => {
  const root = workspace(t);
  const config = resolveConfig({ workspace: root });
  const seed = await memNote(config, {
    kind: 'todo',
    text: '2026-11-02 待关闭的并发测试任务。',
  }, { sessionId: 'seed' });
  const before = rawLines(path.join(config.localRoot, 'events.jsonl')).length;
  const writes = [];

  for (const suffix of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    writes.push(memFact(config, {
      key: `并发测试.项目${suffix}`,
      text: `2026-11-02 并发事实 ${suffix} 已写入。`,
    }, { sessionId: 'a2' }));
  }
  for (let index = 0; index < 7; index += 1) {
    writes.push(memNote(config, {
      kind: 'note',
      text: `2026-11-02 并发备注 ${index} 已写入。`,
    }, { sessionId: 'a2' }));
  }
  for (let index = 0; index < 6; index += 1) {
    writes.push(memFix(config, {
      op: 'retract',
      refs: [seed.id],
      text: `2026-11-02 第 ${index} 次撤销测试。`,
    }, { sessionId: 'a2' }));
  }
  const results = await Promise.all(writes);

  const lines = rawLines(path.join(config.localRoot, 'events.jsonl'));
  assert.equal(lines.length - before, 20);
  assert.equal(new Set(results.map((result) => result.id)).size, 20);
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
});

async function runA3Round(t, round) {
  const root = workspace(t);
  await Promise.all([
    execFileAsync(process.execPath, [childWriter, root, `a-${round}`, '100']),
    execFileAsync(process.execPath, [childWriter, root, `b-${round}`, '100']),
  ]);
  const lines = rawLines(path.join(root, '.dsh-mem', 'events.jsonl'));
  const events = lines.map((line) => JSON.parse(line));
  assert.equal(events.length, 200);
  assert.equal(new Set(events.map((event) => event.id)).size, 200);
}

test('A3：两个子进程各写 100 条不覆盖（连续 20 轮）', async (t) => {
  for (let round = 1; round <= 20; round += 1) {
    await t.test(`第 ${round} 轮`, async (roundTest) => runA3Round(roundTest, round));
  }
});

test('A3b：40 个短命子进程同时写入不超时', async (t) => {
  const root = workspace(t);
  await Promise.all(Array.from({ length: 40 }, (_, index) => (
    execFileAsync(process.execPath, [childWriter, root, `burst-${index}`, '1'])
  )));
  const lines = rawLines(path.join(root, '.dsh-mem', 'events.jsonl'));
  const events = lines.map((line) => JSON.parse(line));
  assert.equal(events.length, 40);
  assert.equal(new Set(events.map((event) => event.id)).size, 40);
});

test('A14：坏行跳过、留证并计入健康指标', async (t) => {
  const root = workspace(t);
  const config = resolveConfig({ workspace: root });
  await memNote(config, {
    kind: 'note',
    text: '2026-11-02 坏行之前的有效条目。',
  }, { sessionId: 'a14' });
  fs.appendFileSync(path.join(config.localRoot, 'events.jsonl'), '{bad json\n');
  await memNote(config, {
    kind: 'note',
    text: '2026-11-02 坏行之后的有效条目。',
  }, { sessionId: 'a14' });

  const parsed = readEvents(config.localRoot);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.corruptLines, 1);
  const evidence = fs.readdirSync(path.join(config.localRoot, 'corrupt'));
  assert.ok(evidence.length >= 1);
  assert.ok(evidence.some((name) => fs.readFileSync(path.join(config.localRoot, 'corrupt', name), 'utf8').includes('{bad json')));
  assert.equal(readJson(path.join(config.localRoot, 'health.json')).corruptLines, 1);
});

test('A15：60 秒陈旧锁可抢占并记 lock_stolen', async (t) => {
  const root = workspace(t);
  const config = resolveConfig({ workspace: root });
  initRoot(config.localRoot);
  fs.writeFileSync(path.join(config.localRoot, '.lock', 'owner.json'), JSON.stringify({
    pid: 999999,
    ts: new Date(Date.now() - 60_000).toISOString(),
    op: 'dead-writer',
    token: 'stale-token',
  }));

  const result = await memNote(config, {
    kind: 'note',
    text: '2026-11-02 抢占陈旧锁后写入成功。',
  }, { sessionId: 'a15' });
  assert.equal(result.status, 'written');
  assert.equal(readJson(path.join(config.localRoot, 'health.json')).lock_stolen, 1);
});

test('A15b：60 秒陈旧 claim 可自愈', async (t) => {
  const root = workspace(t);
  const config = resolveConfig({ workspace: root });
  initRoot(config.localRoot);
  const claim = path.join(config.localRoot, '.lock-claim');
  fs.mkdirSync(claim);
  fs.writeFileSync(path.join(claim, 'owner.json'), JSON.stringify({
    pid: 999999,
    ts: new Date(Date.now() - 60_000).toISOString(),
    op: 'claim:dead-writer',
    token: 'stale-claim-token',
  }));
  const staleWaiter = path.join(config.localRoot, '.lock-waiter-dead');
  fs.writeFileSync(staleWaiter, JSON.stringify({
    pid: 999999,
    ts: new Date(Date.now() - 60_000).toISOString(),
    op: 'dead-waiter',
    token: 'stale-waiter-token',
  }));

  const result = await memNote(config, {
    kind: 'note',
    text: '2026-11-02 陈旧 claim 自愈后写入成功。',
  }, { sessionId: 'a15b' });
  assert.equal(result.status, 'written');
  assert.equal(fs.existsSync(claim), false);
  assert.equal(fs.existsSync(staleWaiter), false);
});

test('ABA：两个进程并发抢占时临界区不重叠', async (t) => {
  const root = workspace(t);
  const memoryRoot = path.join(root, '.dsh-mem');
  const trace = path.join(root, 'trace.txt');
  initRoot(memoryRoot);
  fs.writeFileSync(path.join(memoryRoot, '.lock', 'owner.json'), JSON.stringify({
    pid: 999999,
    ts: new Date(Date.now() - 60_000).toISOString(),
    op: 'dead-writer',
    token: 'stale-token',
  }));
  await Promise.all([
    execFileAsync(process.execPath, [childLock, memoryRoot, trace, 'a']),
    execFileAsync(process.execPath, [childLock, memoryRoot, trace, 'b']),
  ]);
  const sequence = rawLines(trace);
  assert.equal(sequence.length, 4);
  assert.match(sequence[0], /^start:/u);
  assert.equal(sequence[1], `end:${sequence[0].slice(6)}`);
  assert.match(sequence[2], /^start:/u);
  assert.equal(sequence[3], `end:${sequence[2].slice(6)}`);
});

test('A26：初始化后目录自忽略且不改根 .gitignore', (t) => {
  const root = workspace(t);
  const rootIgnore = path.join(root, '.gitignore');
  fs.writeFileSync(rootIgnore, 'node_modules/\n');
  const before = fs.statSync(rootIgnore).mtimeMs;
  const memoryRoot = path.join(root, '.dsh-mem');
  initRoot(memoryRoot);
  assert.equal(fs.readFileSync(path.join(memoryRoot, '.gitignore'), 'utf8'), '*');
  assert.equal(fs.readFileSync(rootIgnore, 'utf8'), 'node_modules/\n');
  assert.equal(fs.statSync(rootIgnore).mtimeMs, before);
});
