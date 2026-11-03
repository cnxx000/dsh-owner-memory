import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFakeHost } from '../fixtures/fake-host.mjs';
import { apply, inject, name } from '../src/index.js';
import { renderPinned } from '../src/l0.js';
import { readJson } from '../src/storage/files.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function options(root) {
  return {
    workspace: root,
    globalRoot: path.join(root, 'global-memory'),
    variableName: 'owner_memory',
  };
}

function tool(host, toolName) {
  return host.registeredTools.find((item) => item.name === toolName);
}

test('插件入口注册六工具并通过变量通道实时提供 pinned', (t) => {
  const root = workspace(t);
  const host = createFakeHost();
  apply(host, options(root));

  assert.equal(name, 'dsh-owner-memory');
  // 2026-11-02 试装更正：不能声明 'systemPrompt'——它是 agent 作用域的服务，
  // 插件作用域不可达，静态 inject 会无限等待，插件彻底静默（没工具、没日志、没报错）。
  // 真契约见 dsh-fish：inject 只放宿主级服务，提示词在 agent/created 里挂。
  assert.deepEqual(inject, ['tools']);
  assert.deepEqual(host.registeredTools.map((item) => item.name), [
    'mem_fact',
    'mem_note',
    'mem_fix',
    'mem_recall',
    'mem_audit',
  ]);
  const provided = host.variables.get('owner_memory')();
  const pinnedFirstLine = renderPinned({ byId: {}, byKey: {}, status: {} }).split('\n')[0];
  assert.notEqual(provided, '');
  assert.ok(provided.startsWith('【主人记忆 · '));
  assert.ok(provided.includes(path.resolve(root, '.dsh-mem', 'events.jsonl')));
  assert.ok(provided.includes(pinnedFirstLine));
});

test('缺 systemPrompt 服务只 warn，写工具仍注册', (t) => {
  const root = workspace(t);
  const host = createFakeHost({ systemPrompt: false });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    assert.doesNotThrow(() => apply(host, options(root)));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(host.registeredTools.length, 5);
  // 没有 systemPrompt 时仍然要告警，但告警措辞跟着真契约走：现在缺的是 agent 挂载通道。
  assert.ok(warnings.some((message) => message.includes('agent')));
});

test('运行时注入自检写 health，并在下一次 mem 调用返回 warning', async (t) => {
  const root = workspace(t);
  // 真契约：自检挂在 agent 的 system-prompt/assemble 中间件上，不是插件作用域的 afterRender。
  const handlers = new Map();
  const host = Object.assign(createFakeHost(), {
    on(event, handler) { handlers.set(event, handler); return () => {}; },
  });
  apply(host, options(root));

  const agentHandlers = new Map();
  const agent = {
    ctx: {
      tools: { register() { return () => {}; } },
      systemPrompt: { variable(_name, provider) { agent.provider = provider; return () => {}; } },
      on(event, handler) { agentHandlers.set(event, handler); return () => {}; },
    },
  };
  handlers.get('agent/created')({ agent, source: 'startup' });

  const provided = agent.provider();
  const assemble = agentHandlers.get('system-prompt/assemble');
  assert.equal(typeof assemble, 'function');

  await assemble({}, {}, async () => ({ text: `persona\n${provided}` }));
  let health = readJson(path.join(root, '.dsh-mem', 'health.json'));
  assert.equal(health.injection_missing, false);

  await assemble({}, {}, async () => ({ text: 'persona 里没有 owner_memory' }));
  health = readJson(path.join(root, '.dsh-mem', 'health.json'));
  assert.equal(health.injection_missing, true);

  const result = await tool(host, 'mem_audit').execute({ what: 'status' });
  assert.ok(result.warnings.some((warning) => warning.includes('{{owner_memory}}')));
  assert.equal(readJson(path.join(root, '.dsh-mem', 'health.json')).injection_missing, false);
});

test('A19：mem_note 绕开会抛错的 agent fs seam，并落到工作区内', async (t) => {
  const root = workspace(t);
  let agentFsCalls = 0;
  const denied = () => {
    agentFsCalls += 1;
    throw new Error('sandbox: file access denied');
  };
  const host = createFakeHost({
    agentFs: { writeFile: denied, edit: denied },
  });
  apply(host, options(root));
  const result = await tool(host, 'mem_note').execute({
    kind: 'note',
    text: 'A19 验证宿主 node:fs 写入路径。',
  }, { sessionId: 'a19-host' });
  const eventFile = path.resolve(root, '.dsh-mem', 'events.jsonl');
  const relative = path.relative(path.resolve(root), eventFile);

  assert.equal(result.status, 'written');
  assert.equal(agentFsCalls, 0);
  assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
  assert.ok(fs.readFileSync(eventFile, 'utf8').includes(result.id));
});

test('disabled 文件只阻断三个写工具，mem_recall 仍可读', async (t) => {
  const root = workspace(t);
  const host = createFakeHost();
  apply(host, options(root));
  const seed = await tool(host, 'mem_note').execute({
    kind: 'note',
    text: '只读开关测试的独特星河记录。',
  }, { sessionId: 'switch-seed' });
  fs.writeFileSync(path.join(root, '.dsh-mem', 'disabled'), '');

  await assert.rejects(
    tool(host, 'mem_fact').execute({
      key: '开关测试.状态',
      text: '开关关闭后不应写入事实。',
    }, { sessionId: 'switch-fact' }),
    (error) => error.code === 'E_DISABLED',
  );
  await assert.rejects(
    tool(host, 'mem_note').execute({
      kind: 'note',
      text: '完全不同且不应写入的禁用备注。',
    }, { sessionId: 'switch-note' }),
    (error) => error.code === 'E_DISABLED',
  );
  await assert.rejects(
    tool(host, 'mem_fix').execute({
      op: 'retract',
      refs: [seed.id],
      text: '禁用时不能追加撤销事件。',
    }, { sessionId: 'switch-fix' }),
    (error) => error.code === 'E_DISABLED',
  );

  const recalled = await tool(host, 'mem_recall').execute({ query: '独特星河记录' });
  assert.ok(recalled.items.some((item) => item.id === seed.id));
});

test('包元数据与 cordis patch 可发布且保持零依赖', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const patch = fs.readFileSync(path.resolve('cordis.patch.yml'), 'utf8');
  assert.equal(packageJson.main, './src/index.js');
  assert.equal(packageJson.exports['.'], './src/index.js');
  assert.equal(packageJson.exports['./package.json'], './package.json');
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml');
  assert.deepEqual(packageJson.dependencies, {});
  for (const field of [
    'row: memory',
    "root: '.dsh-mem'",
    "globalRoot: '~/.dsh/owner-memory'",
    'variableName: owner_memory',
    'injectMaxChars: 1200',
    'recallLimit: 4',
    'recallMaxChars: 800',
    'foldAtLines: 20000',
  ]) {
    assert.ok(patch.includes(field));
  }
});
