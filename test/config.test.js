import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configForAgent, configForExec, configForWorkspace, resolveConfig } from '../src/config.js';

/**
 * 2026-11-03：root 的相对/绝对语义。
 *
 * 插件 apply 跑在宿主进程里，process.cwd() 是 profile 目录；会话工作区要到 agent
 * 建出来才拿得到。这里把「按 agent 重算」钉住：
 *   - 相对 root（默认 `.dsh-mem`）→ <agent cwd>/.dsh-mem
 *   - 绝对 root → 主人指定的位置，不跟着会话跑
 *   - 拿不到 cwd → 原样返回，不猜
 */

const A = path.join(os.tmpdir(), 'owner-memory-root-a');
const B = path.join(os.tmpdir(), 'owner-memory-root-b');

test('相对 root：按 agent 工作区重算 localRoot，globalRoot 不变', () => {
  const base = resolveConfig({ workspace: A, root: '.dsh-mem', globalRoot: path.join(A, 'global') });
  const bound = configForAgent(base, { session: { header: { cwd: B } } });
  assert.equal(bound.localRoot, path.join(B, '.dsh-mem'));
  assert.equal(bound.aliasesPath, path.join(B, '.dsh-mem', 'aliases.json'));
  assert.equal(bound.workspace, B);
  assert.equal(bound.globalRoot, base.globalRoot);
});

test('绝对 root：不按会话改，尊重主人指定的位置', () => {
  const fixed = path.join(A, 'fixed-mem');
  const base = resolveConfig({ workspace: A, root: fixed, globalRoot: path.join(A, 'global') });
  assert.equal(base.localRoot, fixed);
  assert.equal(configForAgent(base, { session: { header: { cwd: B } } }).localRoot, fixed);
});

test('拿不到工作区时原样退回，不猜', () => {
  const base = resolveConfig({ workspace: A });
  assert.equal(configForAgent(base, {}).localRoot, base.localRoot);
  assert.equal(configForAgent(base, undefined), base);
  assert.equal(configForExec(base, undefined), base);
  assert.equal(base.symptomsInRecall, true);
});

test('exec.agent 缺 session.header.cwd 时按 header.cwd 兜底', () => {
  const base = resolveConfig({ workspace: A });
  const bound = configForExec(base, { agent: { header: { cwd: B } } });
  assert.equal(bound.localRoot, path.join(B, '.dsh-mem'));
});

test('同一个工作区不重复造 config', () => {
  const base = resolveConfig({ workspace: A });
  assert.equal(configForWorkspace(base, A), base);
});

test('wiredPresets：默认空名单，配置后保留独立拷贝', () => {
  assert.deepEqual(resolveConfig({ workspace: A }).wiredPresets, []);
  const list = ['whalechan'];
  const config = resolveConfig({ workspace: A, wiredPresets: list });
  list.push('cordis');
  assert.deepEqual(config.wiredPresets, ['whalechan'], '不许被外部数组后来改动影响');
  assert.deepEqual(configForAgent(config, { session: { header: { cwd: B } } }).wiredPresets, ['whalechan']);
});

test('vector：深合并默认值并展开 modelDir', () => {
  const config = resolveConfig({
    workspace: A,
    home: B,
    vector: { beta: 0.25, enabled: false },
  });
  assert.equal(config.vector.enabled, false);
  assert.equal(config.vector.beta, 0.25);
  assert.equal(config.vector.floor, null);
  assert.equal(
    config.vector.modelDir,
    path.join(B, '.dsh', 'owner-memory', 'models', 'bge-small-zh-v1.5@75c43b0'),
  );
});
