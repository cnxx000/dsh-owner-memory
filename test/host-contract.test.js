import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTools } from '../src/host.js';

/**
 * 宿主 register() 契约。
 *
 * 2026-11-03 的真事故：六个 mem_* 工具在桌面版里一个都没出现。探针显示
 * 模块 import 了、apply 进来了（hasTools=true），然后什么都没有。
 * 根因：真宿主的 `ctx.tools.register(definition)` 第一件事是
 *   output 必须是 { schema, render, presentationMeta? }，缺了直接 throw TypeError，
 * 而 apply 没兜住 → 整个 apply 中断。
 *
 * 当时的 test/host-real-api.test.js 用的假 tools 服务只检查 `register` 存不存在，
 * 于是 88 个用例全绿，照样放过了一个"一个工具都注册不上"的版本。
 * 这个文件按宿主的真规则验，缺 output / schema 不合法 / 返回值不合 schema 都算红。
 */

/** 复刻 dsh-tools 支持的 JSON Schema 子集校验。 */
function assertSupportedJsonSchema(schema, at = 'schema') {
  assert.ok(schema && typeof schema === 'object', `${at} 必须是对象`);
  const allowed = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
  for (const key of Object.keys(schema)) {
    assert.ok(allowed.has(key), `${at}.${key} 不是宿主支持的关键字`);
  }
  for (const [name, child] of Object.entries(schema.properties ?? {})) {
    assertSupportedJsonSchema(child, `${at}.properties.${name}`);
  }
  if (schema.items) assertSupportedJsonSchema(schema.items, `${at}.items`);
}

/** 复刻 dsh-tools 的 validateJsonSchemaValue（本仓库用到的部分）。 */
function violationsOf(schema, value, at = 'value') {
  const out = [];
  const visit = (node, val, where) => {
    if (node.type === 'object') {
      if (val === null || typeof val !== 'object' || Array.isArray(val)) { out.push(`${where} 不是对象`); return; }
      for (const key of node.required ?? []) if (!Object.hasOwn(val, key)) out.push(`${where}.${key} 缺失`);
      if (node.additionalProperties === false) {
        for (const key of Object.keys(val)) if (!Object.hasOwn(node.properties ?? {}, key)) out.push(`${where}.${key} 未声明`);
      }
      for (const [key, child] of Object.entries(node.properties ?? {})) if (Object.hasOwn(val, key)) visit(child, val[key], `${where}.${key}`);
    } else if (node.type === 'array') {
      if (!Array.isArray(val)) { out.push(`${where} 不是数组`); return; }
      for (const [i, item] of val.entries()) if (node.items) visit(node.items, item, `${where}[${i}]`);
    } else if (node.type === 'string' && typeof val !== 'string') out.push(`${where} 不是字符串`);
    else if (node.type === 'integer' && !Number.isInteger(val)) out.push(`${where} 不是整数`);
    else if (node.type === 'boolean' && typeof val !== 'boolean') out.push(`${where} 不是布尔`);
  };
  visit(schema, value, at);
  return out;
}

/** 复刻宿主 register() 的准入检查，返回定义本身（真宿主返回 disposer）。 */
function hostRegister(definition) {
  const { name, output } = definition;
  assert.ok(output !== undefined && typeof output === 'object' && typeof output.render === 'function',
    `tool "${name}" 必须声明 output { schema, render }，否则宿主会抛 TypeError 并中断整个 apply`);
  assertSupportedJsonSchema(output.schema, `tool "${name}".output.schema`);
  assert.equal(typeof definition.execute, 'function', `tool "${name}" 必须有 execute`);
  return definition;
}

function makeConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-mem-contract-'));
  return {
    root: path.join(root, 'local'),
    globalRoot: path.join(root, 'global'),
    variableName: 'owner_memory',
    injectMaxChars: 1200,
    recallLimit: 4,
    recallMaxChars: 800,
    foldAtLines: 20000,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('宿主契约：六个工具都带 output { schema, render }，且都通过 register 准入', () => {
  const config = makeConfig();
  try {
    const tools = createTools(config);
    assert.equal(tools.length, 5);
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ['mem_audit', 'mem_fact', 'mem_fix', 'mem_note', 'mem_recall'],
    );
    for (const tool of tools) {
      hostRegister(tool);
      const parts = tool.output.render({}, {});
      assert.ok(Array.isArray(parts) && parts.length > 0, `${tool.name} 的 render 必须返回 content parts`);
      for (const part of parts) assert.equal(part.type, 'text', `${tool.name} 的 render 只产出 text part`);
    }
  } finally {
    config.cleanup();
  }
});

test('mem_fact 的键格式写在模型看得见的地方（描述 + key 参数）', () => {
  // 2026-11-03：鲸鱼娘按自由格式起 key（连字符一段式）被全数拒绝。
  // 规则本身没错，错在这条规则没写进工具描述——模型只能靠猜。
  const config = makeConfig();
  try {
    const fact = createTools(config).find((tool) => tool.name === 'mem_fact');
    assert.match(fact.description, /对象\.方面/u);
    assert.match(fact.parameters.properties.key.description, /对象\.方面/u);
  } finally {
    config.cleanup();
  }
});

test('宿主契约：没 inject 的服务在属性访问时就抛，apply 也必须跑完并注册五个工具', async () => {
  // 2026-11-03 真桌面第二次事故：cordis 的 ctx 是代理，`ctx.systemPrompt`（插件 inject 里没有）
  // 一访问就抛，而这一句写在 try 外面 → apply 在 register-done 之后中断，
  // 探针只留下 import/apply-enter/apply-config/register-done 四行，没有 apply-done，
  // 六个工具随作用域销毁。这个用例把「代理访问就抛」这个宿主特性钉在契约里。
  const config = makeConfig();
  process.env.DSH_OWNER_MEM_PROBE = 'off';
  const { apply } = await import('../src/index.js');
  const registered = [];
  const listeners = new Map();
  const allowed = new Set(['tools', 'on']);
  const ctx = new Proxy({}, {
    get(_target, key) {
      if (typeof key === 'symbol') return undefined;
      if (!allowed.has(key)) throw new Error(`Service "${key}" is not available in this scope`);
      if (key === 'tools') {
        return { register: (definition) => { registered.push(definition.name); return () => {}; } };
      }
      return (event, handler) => { listeners.set(event, handler); return () => {}; };
    },
  });
  try {
    assert.doesNotThrow(() => apply(ctx, { root: config.root, globalRoot: config.globalRoot, workspace: config.root }));
    assert.deepEqual(registered.sort(), ['mem_audit', 'mem_fact', 'mem_fix', 'mem_note', 'mem_recall']);

    // agent/created 里同样会摸 agent.ctx.systemPrompt，也得能补挂，不能把监听器里炸掉。
    // 宿主 payload 形状是 `{ agent, source, signal }`。
    const agent = { ctx: { systemPrompt: { variable: () => () => {} } } };
    assert.doesNotThrow(() => listeners.get('agent/created')?.({ agent, source: 'startup' }));
  } finally {
    config.cleanup();
  }
});

test('宿主契约：execute 的返回值满足各自的 output.schema（写入/召回/纠正跑一遍）', async () => {
  const config = makeConfig();
  const context = { sessionId: 'contract-probe' };
  try {
    const tools = Object.fromEntries(createTools(config).map((tool) => [tool.name, hostRegister(tool)]));
    const written = await tools.mem_fact.execute({ key: 'probe.contract', text: '契约检查写入的一条临时事实', tags: ['验证'] }, context);
    assert.deepEqual(violationsOf(tools.mem_fact.output.schema, written), []);
    assert.equal(written.status, 'written');

    const noted = await tools.mem_note.execute({ kind: 'note', text: '契约检查写入的一条临时事件' }, context);
    assert.deepEqual(violationsOf(tools.mem_note.output.schema, noted), []);

    const recalled = await tools.mem_recall.execute({ query: '契约检查' }, context);
    assert.deepEqual(violationsOf(tools.mem_recall.output.schema, recalled), []);
    assert.ok(Array.isArray(recalled.items) && recalled.items.length >= 1, '刚写的事实应当被召回');

    const audited = await tools.mem_audit.execute({ what: 'health' }, context);
    assert.deepEqual(violationsOf(tools.mem_audit.output.schema, audited), []);

    const fixed = await tools.mem_fix.execute({
      op: 'retract',
      refs: [written.id],
      clearKey: ['probe.contract'],
    }, context);
    assert.deepEqual(violationsOf(tools.mem_fix.output.schema, fixed), []);
    assert.deepEqual(fixed.affected, [written.id]);
  } finally {
    config.cleanup();
  }
});
