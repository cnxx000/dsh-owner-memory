import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCarry, carryOnce } from '../src/carry.js';
import { resolveConfig } from '../src/config.js';
import { deriveState } from '../src/derive.js';
import { buildIndex } from '../src/indexer.js';
import { recall } from '../src/recall.js';
import { readJson } from '../src/storage/files.js';
import { rebuildState } from '../src/storage/event-log.js';
import { memFact } from '../src/tools/mem_fact.js';
import { memNote } from '../src/tools/mem_note.js';

function temporaryDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('A21：W2 只召回共享 global，不泄漏 W1 local', async (t) => {
  const root = temporaryDirectory(t);
  const globalRoot = path.join(root, 'shared-global');
  const configW1 = resolveConfig({ workspace: path.join(root, 'w1'), globalRoot });
  const configW2 = resolveConfig({ workspace: path.join(root, 'w2'), globalRoot });
  const local = await memFact(configW1, {
    key: '项目甲.构建口令',
    text: '项目甲使用独有词紫电本地构建。',
  }, { sessionId: 'w1-local' });
  const global = await memFact(configW1, {
    key: '主人.称呼偏好',
    text: '主人长期偏好独有词鲸语称呼。',
    scope: 'global',
    weight: 4,
  }, { sessionId: 'w1-global' });

  const localW2 = await rebuildState(configW2.localRoot, { ...configW2, recordRebuild: false });
  const globalState = await rebuildState(globalRoot, { ...configW2, recordRebuild: false });
  const globalSource = { state: globalState, index: buildIndex(globalState) };
  for (const options of [
    {},
    { kinds: ['fact'] },
    { includeSuperseded: true },
    { kinds: ['fact'], includeSuperseded: true },
  ]) {
    const result = recall(localW2, buildIndex(localW2), '紫电本地构建', {
      ...options,
      global: globalSource,
    });
    assert.equal(result.items.some((item) => item.id === local.id), false);
  }

  const result = recall(localW2, buildIndex(localW2), '鲸语称呼', { global: globalSource });
  assert.ok(result.items.some((item) => item.id === global.id));
});

test('E_GLOBAL_KIND：global 拒绝 note，接受 weight=4 fact', async (t) => {
  const root = temporaryDirectory(t);
  const config = resolveConfig({
    workspace: path.join(root, 'workspace'),
    globalRoot: path.join(root, 'global'),
  });
  await assert.rejects(
    memNote(config, {
      kind: 'note',
      text: '这条普通备注不应进入全局根。',
      scope: 'global',
    }, { sessionId: 'global-note' }),
    (error) => error.code === 'E_GLOBAL_KIND',
  );
  const accepted = await memFact(config, {
    key: '主人.长期偏好',
    text: '主人长期偏好结构化输出。',
    scope: 'global',
    weight: 4,
  }, { sessionId: 'global-fact' });
  assert.equal(accepted.status, 'written');
});

test('A28：carry 取最近实质会话，过滤纯 note，会话内只返回一次且不写事件', async (t) => {
  const root = temporaryDirectory(t);
  const config = resolveConfig({ workspace: root });
  const fact = await memFact(config, {
    key: '项目.包管理器',
    text: '项目当前使用 pnpm 管理依赖。',
  }, { sessionId: 'S1' });
  const note = await memNote(config, {
    kind: 'note',
    text: '纯代码会话里记录的一条流水账。',
  }, { sessionId: 'S2' });
  const state = readJson(path.join(config.localRoot, 'state.json'));
  const selected = buildCarry(state);

  assert.equal(selected.sess, 'S1');
  assert.ok(selected.ids.includes(fact.id));
  assert.equal(selected.ids.includes(note.id), false);
  assert.ok(selected.text.includes(fact.id));
  assert.equal(selected.text.includes(note.id), false);
  assert.equal(buildCarry(deriveState([])).text, '');

  const eventFile = path.join(config.localRoot, 'events.jsonl');
  const linesBefore = fs.readFileSync(eventFile, 'utf8').split(/\r?\n/u).filter(Boolean).length;
  const first = await carryOnce(state, {
    root: config.localRoot,
    sess: 'S3',
    now: '2026-11-02T12:00:00.000Z',
  });
  const second = await carryOnce(state, {
    root: config.localRoot,
    sess: 'S3',
    now: '2026-11-02T12:00:01.000Z',
  });
  const linesAfter = fs.readFileSync(eventFile, 'utf8').split(/\r?\n/u).filter(Boolean).length;

  assert.ok(first.text.includes(fact.id));
  assert.equal(second.text, '');
  assert.equal(linesAfter, linesBefore);
});

test('同一工作区并发两个新会话各 carry 一次且登记不覆盖', async (t) => {
  const root = temporaryDirectory(t);
  const config = resolveConfig({ workspace: root });
  await memFact(config, {
    key: '项目.运行方式',
    text: '项目通过 node --test 执行验证。',
  }, { sessionId: 'source-session' });
  const state = readJson(path.join(config.localRoot, 'state.json'));
  const [left, right] = await Promise.all([
    carryOnce(state, { root: config.localRoot, sess: 'new-left' }),
    carryOnce(state, { root: config.localRoot, sess: 'new-right' }),
  ]);
  const persisted = readJson(path.join(config.localRoot, 'state.json'));

  assert.notEqual(left.text, '');
  assert.notEqual(right.text, '');
  assert.ok(persisted.carriedSessions['new-left']);
  assert.ok(persisted.carriedSessions['new-right']);
  assert.equal((await carryOnce(state, { root: config.localRoot, sess: 'new-left' })).text, '');
  assert.equal((await carryOnce(state, { root: config.localRoot, sess: 'new-right' })).text, '');
});
