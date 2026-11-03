import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply } from '../src/index.js';

/**
 * 照真宿主的形状造假宿主。
 *
 * 这个文件的由来（两次真实事故，别再退回去）：
 *   ① P9 交付的 `host.test.js` 用「registerTool」形状 → 真宿主是 `tools.register`
 *      （dsh-whale-loli memory.js:612）→ 假宿主全绿、真装上去一个工具都不注册。
 *   ② 入口曾写 `inject = ['systemPrompt','tools']`。`systemPrompt` 属于 **agent 作用域**，
 *      插件作用域不可达，cordis 静态 inject 会「无限等待」——表现是彻底静默：
 *      没工具、没日志、没报错、`.dsh-mem` 也不创建。真契约见 dsh-fish：
 *      inject 里没有 systemPrompt，提示词相关的东西在 `agent/created` 钩子里用
 *      `agent.ctx.systemPrompt` 挂。
 * 所以这里同时锁「宿主级注册」与「agent 级挂载」两条路。
 */

function fakeHost({ withOn = true } = {}) {
  const hostRegistered = [];
  const hostVariables = new Map();
  const handlers = new Map();
  const host = {
    tools: { register(tool) { hostRegistered.push(tool); return () => {}; } },
    systemPrompt: {
      variable(name, provider) { hostVariables.set(name, provider); return () => {}; },
    },
  };
  if (withOn) {
    host.on = (event, handler) => {
      handlers.set(event, handler);
      return () => {};
    };
  }
  return { host, hostRegistered, hostVariables, handlers };
}

function fakeAgent(cwd, id = 'session-owner-memory-test', preset = undefined) {
  const agentRegistered = [];
  const agentVariables = new Map();
  const agentHandlers = new Map();
  const header = { id, ...(cwd ? { cwd } : {}), ...(preset ? { agentPreset: preset } : {}) };
  const agent = {
    id,
    session: { header },
    ctx: {
      tools: { register(tool) { agentRegistered.push(tool); return () => {}; } },
      systemPrompt: {
        variable(name, provider) { agentVariables.set(name, provider); return () => {}; },
      },
      on: (event, handler) => { agentHandlers.set(event, handler); return () => {}; },
    },
  };
  return { agent, agentRegistered, agentVariables, agentHandlers };
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-host-real-'));
  return { root, config: { workspace: root, globalRoot: path.join(root, 'global') } };
}

test('宿主级：tools.register 拿到全部五个工具', () => {
  const { root, config } = workspace();
  const { host, hostRegistered } = fakeHost();
  apply(host, config);

  const names = hostRegistered.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['mem_audit', 'mem_fact', 'mem_fix', 'mem_note', 'mem_recall']);
  for (const tool of hostRegistered) {
    assert.equal(typeof tool.execute, 'function');
    assert.ok(String(tool.description).length > 10);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('inject 列表里不许出现 systemPrompt（插件作用域够不到，会无限等待）', async () => {
  const mod = await import('../src/index.js');
  assert.deepEqual(mod.inject, ['tools']);
});

test('agent/created：把工具补挂到 agent，并把变量挂到 agent 的 systemPrompt 上', () => {
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);

  const onCreated = handlers.get('agent/created');
  assert.equal(typeof onCreated, 'function', '必须监听 agent/created');

  const { agent, agentRegistered, agentVariables } = fakeAgent();
  // 宿主真实 payload 形状是 `{ agent, source, signal }`，不是 agent 本身。
  onCreated({ agent, source: 'startup' });

  assert.deepEqual(agentRegistered.map((t) => t.name).sort(),
    ['mem_audit', 'mem_fact', 'mem_fix', 'mem_note', 'mem_recall']);
  const provider = agentVariables.get('owner_memory');
  assert.equal(typeof provider, 'function');
  const text = provider();
  assert.match(text, /【主人记忆 · /);
  assert.match(text, /## 关于主人/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('按会话工作区落库：注入横幅和工具写入都落在 agent 的 cwd，不是 profile 目录', async () => {
  // 2026-11-03 落点修正。apply 时 process.cwd() 是 profile 目录，相对 root 被解析到那里；
  // 会话工作区只有 agent 建出来才知道。这里同时验注入与写入两条路。
  const { root, config } = workspace();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-ws-'));
  const { host, handlers } = fakeHost();
  apply(host, config);

  const { agent, agentRegistered, agentVariables } = fakeAgent(ws);
  handlers.get('agent/created')({ agent, source: 'startup' });

  const banner = agentVariables.get('owner_memory')();
  assert.ok(banner.includes(path.join(ws, '.dsh-mem')), '横幅必须指向会话工作区的库');
  assert.ok(!banner.includes(path.join(root, '.dsh-mem')), '不能指向 apply 时的 profile 目录');

  const note = agentRegistered.find((tool) => tool.name === 'mem_note');
  const out = await note.execute({ kind: 'note', text: '落点测试' }, { agent });
  assert.equal(out.status, 'written');
  assert.ok(fs.existsSync(path.join(ws, '.dsh-mem', 'events.jsonl')), '事件要落在会话工作区');
  assert.equal(fs.existsSync(path.join(root, '.dsh-mem')), false, 'apply 时的目录不该被创建');

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

test('agent/created 只认宿主真实 payload：裸 agent 不挂，{ agent } 才挂', () => {
  // 2026-11-03 第三次事故：宿主发的是 `{ agent, source, signal }`。夹具如果直接传 agent，
  // 这条用例会绿着放行一个「真机上永远挂不上」的版本——踩过两次同一个坑了。
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const onCreated = handlers.get('agent/created');

  const bare = fakeAgent();
  assert.doesNotThrow(() => onCreated(bare.agent));
  assert.equal(bare.agentVariables.size, 0, '裸 agent 不是宿主契约，不能静默当成挂上了');

  const wrapped = fakeAgent();
  onCreated({ agent: wrapped.agent, source: 'startup' });
  assert.ok(wrapped.agentVariables.has('owner_memory'), '真实 payload 形状必须挂上变量');
  fs.rmSync(root, { recursive: true, force: true });
});

test('注入自检：assemble 中间件能判定「没进提示」并写进 health', async () => {
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const { agent, agentHandlers, agentVariables } = fakeAgent();
  handlers.get('agent/created')({ agent, source: 'startup' });
  const provider = agentVariables.get('owner_memory');
  const firstLine = provider().split('\n')[0];

  const assemble = agentHandlers.get('system-prompt/assemble');
  assert.equal(typeof assemble, 'function', '必须挂 system-prompt/assemble 做自检');

  const healthFile = path.join(root, '.dsh-mem', 'health.json');
  const readHealth = () => JSON.parse(fs.readFileSync(healthFile, 'utf8'));

  // 提示里没有记忆 → injection_missing 为真
  await assemble({}, {}, async () => ({ text: '完全无关的系统提示' }));
  assert.equal(readHealth().injection_missing, true);

  // 提示里带了记忆横幅 → 归零
  await assemble({}, {}, async () => ({ text: `开头\n${firstLine}\n结尾` }));
  assert.equal(readHealth().injection_missing, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('注入自检认结构化 assembly：{{owner_memory}} 在 persona 段里就算进去了', async () => {
  // 2026-11-03 假警报：真宿主交给 system-prompt/assemble 的是 PromptAssembly，
  // 不是最终文本。旧代码 String(assembly) => "[object Object]"，每轮都误报缺失。
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const { agent, agentHandlers, agentVariables } = fakeAgent();
  handlers.get('agent/created')({ agent, source: 'startup' });
  const pinned = agentVariables.get('owner_memory')();

  const assemble = agentHandlers.get('system-prompt/assemble');
  const assembly = {
    sections: [
      { name: 'persona', text: '【每轮先看 · 你的记忆】\n{{owner_memory}}\n（人设从这里开始）' },
      { name: 'harness:identity', text: 'You are a coding agent.' },
    ],
    contexts: [],
    tools: [],
    variables: { owner_memory: pinned },
  };

  const returned = await assemble({}, {}, async () => assembly);
  assert.equal(returned, assembly, '自检中间件必须原样返回 assembly');

  const readHealth = () => JSON.parse(fs.readFileSync(path.join(root, '.dsh-mem', 'health.json'), 'utf8'));
  assert.equal(readHealth().injection_missing, false, '变量插值后能找到记忆首行，不该再报缺失');

  // 反例一：人设压根没引用变量 → 不评判，也不许把别处写好的 false 盖回 true。
  // （创造模式与鲸鱼娘共用一份工作区 health，这条不锁住就会互相覆盖。）
  await assemble({}, {}, async () => ({
    sections: [{ name: 'persona', text: '这条人设没写变量。' }],
    contexts: [],
    tools: [],
    variables: { owner_memory: pinned },
  }));
  assert.equal(readHealth().injection_missing, false, '没引用的 assembly 不该改动 health');

  // 反例二：引用了变量但变量没值（插值后仍是字面量）→ 如实报缺失。
  await assemble({}, {}, async () => ({
    sections: [{ name: 'persona', text: '{{owner_memory}}' }],
    contexts: [],
    tools: [],
    variables: {},
  }));
  assert.equal(readHealth().injection_missing, true);

  // 再回到引用且正常的 assembly → 翻回 false。
  await assemble({}, {}, async () => assembly);
  assert.equal(readHealth().injection_missing, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('健康告警按 agent 判定：没接线的 preset 不挂假警告，也不改共享 health', async () => {
  // 2026-11-03 第三个坑：健康状态按工作区共享，但「人设有没有接线」按 agent。
  // 创造模式的人设没有 {{owner_memory}}，它每轮都会把鲸鱼娘写好的 false 盖回 true。
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const healthFile = path.join(root, '.dsh-mem', 'health.json');
  const readHealth = () => JSON.parse(fs.readFileSync(healthFile, 'utf8'));

  const wired = fakeAgent();
  handlers.get('agent/created')({ agent: wired.agent, source: 'startup' });
  const wiredAssemble = wired.agentHandlers.get('system-prompt/assemble');
  const wiredPinned = wired.agentVariables.get('owner_memory')();

  // 接线的人设引用了变量但没拿到值 → health 如实为 true
  await wiredAssemble({}, {}, async () => ({
    sections: [{ name: 'persona', text: '{{owner_memory}}' }], contexts: [], tools: [], variables: {},
  }));
  assert.equal(readHealth().injection_missing, true);

  // 没接线的 agent：组装不评判、audit 不挂假警告、health 保持原值
  const plain = fakeAgent();
  handlers.get('agent/created')({ agent: plain.agent, source: 'startup' });
  const plainAssemble = plain.agentHandlers.get('system-prompt/assemble');
  await plainAssemble({}, {}, async () => ({
    sections: [{ name: 'persona', text: '创造模式人设，没有变量。' }],
    contexts: [],
    tools: [],
    variables: { owner_memory: wiredPinned },
  }));
  assert.equal(readHealth().injection_missing, true, '没接线的 agent 不该改共享 health');

  const plainAudit = plain.agentRegistered.find((tool) => tool.name === 'mem_audit');
  const plainResult = await plainAudit.execute({ what: 'status' }, { agent: plain.agent });
  assert.ok(!(plainResult.warnings ?? []).some((warning) => warning.includes('{{owner_memory}}')),
    '没接线的 agent 不该收到记忆警告');

  // 接线且确实缺失的 agent：audit 挂一次真实警告，之后 health 归零
  const wiredAudit = wired.agentRegistered.find((tool) => tool.name === 'mem_audit');
  const wiredResult = await wiredAudit.execute({ what: 'status' }, { agent: wired.agent });
  assert.ok((wiredResult.warnings ?? []).some((warning) => warning.includes('{{owner_memory}}')));
  assert.equal(readHealth().injection_missing, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('wiredPresets：名单里的 preset 没引用变量要报缺失（A18），名单外的不评判', async () => {
  // 2026-11-03：只靠「这条 assembly 有没有引用变量」不够——人设被改坏、变量被删时，
  // 没有引用就无从判断。所以用 preset 名单声明「谁本该接线」。
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, { ...config, wiredPresets: ['whalechan'] });
  const healthFile = path.join(root, '.dsh-mem', 'health.json');
  const readHealth = () => JSON.parse(fs.readFileSync(healthFile, 'utf8'));
  const create = (id, preset) => {
    const fake = fakeAgent(undefined, id, preset);
    handlers.get('agent/created')({ agent: fake.agent, source: 'startup' });
    return fake;
  };

  // 名单里且正常插值 → false
  const good = create('session-good', 'whalechan');
  const goodPinned = good.agentVariables.get('owner_memory')();
  await good.agentHandlers.get('system-prompt/assemble')({}, {}, async () => ({
    sections: [{ name: 'persona', text: '{{owner_memory}}' }],
    contexts: [],
    tools: [],
    variables: { owner_memory: goodPinned },
  }));
  assert.equal(readHealth().injection_missing, false);

  // 名单外（创造模式）不引用变量 → 不评判，health 保持 false
  const plain = create('session-plain', 'cordis');
  await plain.agentHandlers.get('system-prompt/assemble')({}, {}, async () => ({
    sections: [{ name: 'persona', text: '创造模式人设，没有变量。' }],
    contexts: [],
    tools: [],
    variables: {},
  }));
  assert.equal(readHealth().injection_missing, false, '名单外的 preset 不该改 health');

  // 名单里但人设丢了变量 → 按缺失报（A18 的原始诉求）
  const broken = create('session-broken', 'whalechan');
  await broken.agentHandlers.get('system-prompt/assemble')({}, {}, async () => ({
    sections: [{ name: 'persona', text: '人设被改坏了，变量没了。' }],
    contexts: [],
    tools: [],
    variables: {},
  }));
  assert.equal(readHealth().injection_missing, true, '名单里的 preset 丢变量必须报出来');
  fs.rmSync(root, { recursive: true, force: true });
});

test('缺 systemPrompt 时不炸（照 loli 的容错）', () => {
  const { root, config } = workspace();
  const host = { tools: { register() { return () => {}; } } };
  assert.doesNotThrow(() => apply(host, config));
  fs.rmSync(root, { recursive: true, force: true });
});

test('A19 真形状：写入不经过 agent 的 fs seam，且落在工作区内', async () => {
  const { root, config } = workspace();
  const { host, hostRegistered } = fakeHost();
  let agentFsCalls = 0;
  host.fs = {
    writeFile() { agentFsCalls += 1; throw new Error('agent fs 不该被调用'); },
    edit() { agentFsCalls += 1; throw new Error('agent fs 不该被调用'); },
  };
  apply(host, config);

  const note = hostRegistered.find((tool) => tool.name === 'mem_note');
  const result = await note.execute({ kind: 'note', text: 'A19：宿主侧写入不该经过 agent fs。' }, { sessionId: 'a19' });

  assert.equal(result.status, 'written');
  assert.equal(agentFsCalls, 0);

  const eventsFile = path.join(root, '.dsh-mem', 'events.jsonl');
  assert.ok(path.resolve(eventsFile).startsWith(path.resolve(root)), '事件文件必须在工作区内');
  assert.match(fs.readFileSync(eventsFile, 'utf8'), new RegExp(result.id));
  fs.rmSync(root, { recursive: true, force: true });
});
