import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { foldEvents } from '../src/fold.js';
import { initRoot, readJson } from '../src/storage/files.js';
import { rebuildState } from '../src/storage/event-log.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-migrate-fold-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return resolveConfig({ workspace: root });
}

function event(id, ts, kind, text, extra = {}) {
  return {
    id,
    ts,
    kind,
    text,
    weight: 2,
    scope: 'local',
    src: 'agent',
    sess: 'fold-test',
    ...extra,
  };
}

function writeEvents(root, events) {
  initRoot(root);
  fs.writeFileSync(
    path.join(root, 'events.jsonl'),
    `${events.map((item) => JSON.stringify(item)).join('\n')}\n`,
  );
}

function currentEvents(root) {
  return fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8')
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

test('A16：折叠有快照、季度归档和可逆 id 并集', async (t) => {
  const config = workspace(t);
  const events = [
    event('m_old1_0001', '2020-01-01T00:00:00.000Z', 'fact', '旧包管理器为 npm。', { key: '项目.包管理器' }),
    event('m_new2_0002', '2020-01-02T00:00:00.000Z', 'fact', '新包管理器为 pnpm。', { key: '项目.包管理器' }),
    event('m_note3_0003', '2020-01-03T00:00:00.000Z', 'note', '旧诊断结论不正确。'),
    event('m_fix4_0004', '2020-01-04T00:00:00.000Z', 'revise', '诊断结论已经纠正。', { refs: ['m_note3_0003'] }),
    event('m_live5_0005', '2020-01-05T00:00:00.000Z', 'note', '即使很老仍保持 active。'),
  ];
  writeEvents(config.localRoot, events);
  await rebuildState(config.localRoot, { ...config, recordRebuild: false });
  const beforeIds = new Set(events.map((item) => item.id));
  const result = await foldEvents(config, { now: '2026-11-02T12:00:00.000Z' });

  assert.equal(result.folded, 2);
  assert.equal(fs.existsSync(result.snapshot), true);
  assert.equal(fs.existsSync(result.archive), true);
  const current = currentEvents(config.localRoot);
  const archived = fs.readFileSync(result.archive, 'utf8')
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const recoveredIds = new Set([
    ...current.filter((item) => item.kind !== 'fold').map((item) => item.id),
    ...archived.map((item) => item.id),
  ]);
  assert.deepEqual([...recoveredIds].sort(), [...beforeIds].sort());
  assert.equal(result.foldEvent.foldedCount, archived.length);
  assert.equal(current.at(-1).id, result.foldEvent.id);
});

test('A17：100 条十年前 active 事件一条不折叠', async (t) => {
  const config = workspace(t);
  const events = Array.from({ length: 100 }, (_, index) => (
    event(
      `m_${(10_000 + index).toString(36)}_${index.toString(16).padStart(4, '0')}`,
      new Date(Date.UTC(2016, 0, 1, 0, 0, index)).toISOString(),
      'note',
      `十年前仍然有效的记录 ${index}。`,
    )
  ));
  writeEvents(config.localRoot, events);
  await rebuildState(config.localRoot, { ...config, recordRebuild: false });
  const result = await foldEvents(config, { now: '2026-11-02T12:00:00.000Z' });
  const after = currentEvents(config.localRoot);

  assert.equal(result.folded, 0);
  assert.equal(after.length, 100);
  assert.deepEqual(after.map((item) => item.id).sort(), events.map((item) => item.id).sort());
});
