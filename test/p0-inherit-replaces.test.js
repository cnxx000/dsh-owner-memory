import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { deriveState } from '../src/derive.js';
import { buildIndex } from '../src/indexer.js';
import { selectFacts } from '../src/l0.js';
import { recall } from '../src/recall.js';
import { scoreEvent } from '../src/score.js';
import { readJson } from '../src/storage/files.js';
import { rebuildState } from '../src/storage/event-log.js';
import { memFact } from '../src/tools/mem_fact.js';
import { memFix } from '../src/tools/mem_fix.js';
import { memNote } from '../src/tools/mem_note.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-p0-inherit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return resolveConfig({ workspace: root });
}

function state(config) {
  return readJson(path.join(config.localRoot, 'state.json'));
}

test('并发过期 revise 只标 revised，不覆盖后来写入的当前事实', () => {
  const base = {
    ts: '2026-11-04T12:00:00+08:00',
    weight: 2,
    scope: 'local',
    src: 'agent',
    sess: 'race',
  };
  const first = { ...base, id: 'm_race1_0001', kind: 'fact', key: '服务.区域', text: '服务当前在华北。' };
  const second = { ...base, id: 'm_race2_0002', kind: 'fact', key: '服务.区域', text: '服务当前在华东。' };
  const stale = {
    ...base,
    id: 'm_race3_0003',
    kind: 'revise',
    key: '服务.区域',
    text: '服务当前在华南。',
    refs: [first.id],
  };
  const derived = deriveState([first, second, stale]);

  assert.equal(derived.byKey['服务.区域'], second.id);
  assert.deepEqual(derived.status[first.id], { status: 'revised', revisedBy: stale.id });
});

test('D1：revise 继承当前 key，并进入 fact 召回与 L0', async (t) => {
  const config = workspace(t);
  const original = await memFact(config, {
    key: '账号.cookie位置',
    text: '账号 Cookie 当前存在旧目录。',
  }, { sessionId: 'd1-fact' });

  await assert.rejects(
    memFix(config, {
      op: 'revise',
      refs: [original.id],
      text: '账号 Cookie 路径应为新目录。',
    }, { sessionId: 'd1-bad' }),
    (error) => error.code === 'E_REVISE_NOT_STATEMENT',
  );
  await assert.rejects(
    memFix(config, {
      op: 'revise',
      refs: [original.id],
      text: '账号 Cookie 新目录',
    }, { sessionId: 'd1-field-only' }),
    (error) => error.code === 'E_REVISE_NOT_STATEMENT',
  );

  const revised = await memFix(config, {
    op: 'revise',
    refs: [original.id],
    text: '账号 Cookie 当前存在新目录。',
  }, { sessionId: 'd1-revise' });
  const current = state(config);
  const recalled = recall(current, buildIndex(current), '账号 Cookie 新目录', {
    kinds: ['fact'],
    limit: 4,
    maxChars: 800,
  });

  assert.equal(current.byKey['账号.cookie位置'], revised.id);
  assert.equal(current.byId[revised.id].key, '账号.cookie位置');
  assert.ok(recalled.items.some((item) => item.id === revised.id && item.kind === 'fact'));
  assert.ok(selectFacts(current).some((event) => event.id === revised.id));
});

test('D2a/D2b：无更早值时须显式 clearKey 才能删除键', async (t) => {
  const config = workspace(t);
  const original = await memFact(config, {
    key: '服务.运行模式',
    text: '服务当前运行模式是标准模式。',
  }, { sessionId: 'd2-fact' });
  const revised = await memFix(config, {
    op: 'revise',
    refs: [original.id],
    text: '服务当前运行模式是安全模式。',
  }, { sessionId: 'd2-revise' });

  await assert.rejects(
    memFix(config, {
      op: 'retract',
      refs: [revised.id],
      text: '撤销该修订。',
    }, { sessionId: 'd2a-retract' }),
    (error) => error.code === 'E_KEY_WOULD_CLEAR',
  );

  await memFix(config, {
    op: 'retract',
    refs: [revised.id],
    text: '撤销该修订并确认清空事实键。',
    clearKey: ['服务.运行模式'],
  }, { sessionId: 'd2b-retract' });
  assert.equal(state(config).byKey['服务.运行模式'], undefined);
});

test('D2c：有更早值自动回退，clearKey 反而被拒绝', async (t) => {
  const config = workspace(t);
  const first = await memFact(config, {
    key: '服务.部署区域',
    text: '服务当前部署区域在华北。',
  }, { sessionId: 'd2c-first' });
  const second = await memFact(config, {
    key: '服务.部署区域',
    text: '服务当前部署区域在华东。',
  }, { sessionId: 'd2c-second' });

  await assert.rejects(
    memFix(config, {
      op: 'retract',
      refs: [second.id],
      text: '撤销华东部署记录。',
      clearKey: ['服务.部署区域'],
    }, { sessionId: 'd2c-bad' }),
    (error) => error.code === 'E_CLEARKEY_NOT_NEEDED',
  );

  await memFix(config, {
    op: 'retract',
    refs: [second.id],
    text: '撤销华东部署记录。',
  }, { sessionId: 'd2c-good' });
  assert.equal(state(config).byKey['服务.部署区域'], first.id);
});

test('D3：revise 不能同时引用两个带 key 的事实', async (t) => {
  const config = workspace(t);
  const first = await memFact(config, {
    key: '项目.包管理器',
    text: '项目当前使用 pnpm。',
  }, { sessionId: 'd3-first' });
  const second = await memFact(config, {
    key: '项目.测试框架',
    text: '项目当前使用 node:test。',
  }, { sessionId: 'd3-second' });

  await assert.rejects(
    memFix(config, {
      op: 'revise',
      refs: [first.id, second.id],
      text: '项目当前使用新的统一工具。',
    }, { sessionId: 'd3-revise' }),
    (error) => error.code === 'E_REVISE_MULTI_KEY',
  );
});

test('D4：replaces 隐藏旧条目，includeSuperseded 可带前缀查看', async (t) => {
  const config = workspace(t);
  const first = await memNote(config, {
    kind: 'note',
    text: 'dsh-fish 当前采用旧连接方案。',
  }, { sessionId: 'd4-first' });
  const second = await memNote(config, {
    kind: 'note',
    text: 'dsh-fish 当前采用旧连接方案。',
    replaces: [first.id],
  }, { sessionId: 'd4-second' });
  const current = state(config);
  const index = buildIndex(current);
  const normal = recall(current, index, 'dsh-fish 连接方案');
  const withHistory = recall(current, index, 'dsh-fish 连接方案', { includeSuperseded: true });

  assert.deepEqual(current.status[first.id], {
    status: 'superseded',
    supersededBy: second.id,
    prevStatus: { status: 'active' },
  });
  assert.ok(normal.items.some((item) => item.id === second.id));
  assert.ok(!normal.items.some((item) => item.id === first.id));
  assert.ok(withHistory.items.some((item) => (
    item.id === first.id && item.text.startsWith(`[已被 ${second.id} 取代] `)
  )));
  assert.equal(scoreEvent(current, index, current.byId[first.id], 'dsh-fish').refs, 0);
});

test('D5：note 不能取代 rule', async (t) => {
  const config = workspace(t);
  const rule = await memNote(config, {
    kind: 'rule',
    text: '写文件前必须确认目标路径。',
  }, { sessionId: 'd5-rule' });

  await assert.rejects(
    memNote(config, {
      kind: 'note',
      text: '目标路径规则已有新说明。',
      replaces: [rule.id],
    }, { sessionId: 'd5-note' }),
    (error) => error.code === 'E_REPLACES_KIND',
  );
});

test('D6：retract 替代条目后恢复被取代条目的完整前态', async (t) => {
  const config = workspace(t);
  const first = await memNote(config, {
    kind: 'note',
    text: '发布流程当前使用旧审批链。',
  }, { sessionId: 'd6-first' });
  const second = await memNote(config, {
    kind: 'note',
    text: '发布流程当前使用新审批链。',
    replaces: [first.id],
  }, { sessionId: 'd6-second' });

  await memFix(config, {
    op: 'retract',
    refs: [second.id],
    text: '撤销新的审批链说明。',
  }, { sessionId: 'd6-retract' });
  assert.deepEqual(state(config).status[first.id], { status: 'active' });
});

test('D7/D8：继承保留较大 weight/tags/pin，重建结果深度一致', async (t) => {
  const config = workspace(t);
  const original = await memFact(config, {
    key: '构建.缓存策略',
    text: '构建当前使用本地缓存。',
    weight: 5,
    tags: ['状态'],
    pin: true,
  }, { sessionId: 'd7-fact' });
  const revised = await memFix(config, {
    op: 'revise',
    refs: [original.id],
    text: '构建当前使用共享缓存。',
  }, { sessionId: 'd7-revise' });
  const before = state(config);

  assert.equal(before.byId[revised.id].weight, 5);
  assert.deepEqual(before.byId[revised.id].tags, ['状态']);
  assert.equal(before.byId[revised.id].pin, true);

  fs.rmSync(path.join(config.localRoot, 'state.json'));
  const rebuilt = await rebuildState(config.localRoot, { ...config, recordRebuild: false });
  assert.deepEqual(rebuilt, before);
});
