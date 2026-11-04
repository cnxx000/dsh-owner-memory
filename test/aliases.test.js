import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { deriveState } from '../src/derive.js';
import { createTools } from '../src/host.js';
import { buildIndex } from '../src/indexer.js';
import { loadAliasTable, recall } from '../src/recall.js';

const NOW = Date.parse('2026-11-04T12:00:00+08:00');
const ALIASES = {
  version: 1,
  entries: [
    { phrase: '养鱼的插件', terms: ['dsh-fish'] },
    { phrase: '搬运工具', terms: ['mem_migrate'] },
    { phrase: '体检数字', terms: ['health'] },
  ],
};

function event(id, text, extra = {}) {
  return {
    id,
    ts: new Date(NOW).toISOString(),
    kind: 'note',
    text,
    weight: 3,
    sess: 'aliases-test',
    ...extra,
  };
}

function prepared(events) {
  const state = deriveState(events);
  return { state, index: buildIndex(state) };
}

test('A1：短语别名把 dsh-fish 相关条目召回前四', () => {
  const target = event('m_fish', 'dsh-fish 已整体卸载，不再运行。', {
    kind: 'decision',
    weight: 5,
  });
  const distractors = [
    event('m_other1', '插件配置检查已经完成。'),
    event('m_other2', '水族箱维护记录已经归档。'),
    event('m_other3', '桌面工具目前正常运行。'),
    event('m_other4', '旧组件已经停止维护。'),
  ];
  const { state, index } = prepared([target, ...distractors]);
  const result = recall(state, index, '养鱼的插件现在怎么样？', {
    aliases: ALIASES,
    now: NOW,
  });

  assert.ok(result.items.slice(0, 4).some(({ id }) => id === target.id));
});

test('A1b：同条件下原文命中排在 0.8 折别名命中之前', () => {
  const exact = event('m_exact', '养鱼的插件已经关闭。');
  const aliased = event('m_alias', 'dsh-fish 已经关闭。');
  const { state, index } = prepared([exact, aliased]);
  const result = recall(state, index, '养鱼的插件', {
    aliases: ALIASES,
    now: NOW,
  });

  assert.equal(result.items[0].id, exact.id);
  assert.ok(result.items.some(({ id }) => id === aliased.id));
});

test('H2：主体停用词不改变“养鱼的插件”前四条', (t) => {
  const events = [
    event('m_fish_decision', 'dsh-fish 已整体卸载，不再运行。', {
      kind: 'decision',
      weight: 5,
    }),
    event('m_fish_note', 'dsh-fish 的旧配置文件仍需清理。', { weight: 4 }),
    event('m_exact', '养鱼的插件已经关闭。'),
    event('m_plugin', '插件配置检查已经完成。'),
    event('m_aquarium', '水族箱维护记录已经归档。'),
  ];
  const { state, index } = prepared(events);
  const ids = recall(state, index, '养鱼的插件', {
    aliases: ALIASES,
    now: NOW,
  }).items.slice(0, 4).map(({ id }) => id);

  assert.deepEqual(ids, ['m_exact', 'm_fish_decision', 'm_fish_note', 'm_plugin']);
  t.diagnostic(`养鱼的插件前四条=${ids.join(',')}`);
});

test('A2：单字别名直接拒绝并报 E_ALIAS_PHRASE', () => {
  const { state, index } = prepared([event('m_fish', 'dsh-fish 已卸载。')]);
  assert.throws(
    () => recall(state, index, '鱼插件', {
      aliases: { version: 1, entries: [{ phrase: '鱼', terms: ['dsh-fish'] }] },
      now: NOW,
    }),
    (error) => error.code === 'E_ALIAS_PHRASE',
  );
});

test('A3：别名文件不存在时与不传别名逐字节一致', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-alias-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aliases = loadAliasTable(path.join(root, 'aliases.json'));
  const { state, index } = prepared([event('m_note', '本地数据库连接池配置。')]);
  const plain = recall(state, index, '数据库连接池', { now: NOW });
  const missing = recall(state, index, '数据库连接池', { aliases, now: NOW });

  assert.equal(JSON.stringify(missing), JSON.stringify(plain));
});

test('A4：未出现完整短语“体检数字”时不扩展 health', () => {
  const health = event('m_health', 'health 指标需要重启桌面端后刷新。');
  const { state, index } = prepared([health]);
  const result = recall(state, index, '我上次体检血压多少', {
    aliases: ALIASES,
    now: NOW,
  });

  assert.equal(result.items.some(({ id }) => id === health.id), false);
});

test('解析失败降级为空表并发 alias_parse_failed 探针', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-alias-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'aliases.json');
  const stages = [];
  fs.writeFileSync(file, '{"version":1,"entries":[');

  assert.deepEqual(
    loadAliasTable(file, { probe: (stage) => stages.push(stage) }),
    { version: 1, entries: [] },
  );
  assert.deepEqual(stages, ['alias_parse_failed']);
});

test('mem_recall 每次调用重新读取 aliases.json', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-alias-hot-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const config = resolveConfig({
    workspace,
    root: path.join(workspace, '.dsh-mem'),
    globalRoot: path.join(workspace, 'global-memory'),
  });
  const tools = Object.fromEntries(createTools(config).map((tool) => [tool.name, tool]));
  const written = await tools.mem_note.execute({
    kind: 'decision',
    text: 'dsh-fish 已整体卸载。',
  }, { sessionId: 'alias-hot-seed' });

  const before = await tools.mem_recall.execute({ query: '养鱼的插件' });
  assert.equal(before.items.some(({ id }) => id === written.id), false);
  fs.writeFileSync(config.aliasesPath, JSON.stringify(ALIASES));
  const after = await tools.mem_recall.execute({ query: '养鱼的插件' });
  assert.equal(after.items.some(({ id }) => id === written.id), true);
});
