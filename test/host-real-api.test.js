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
  assert.match(text, /【长期记忆 · /);
  assert.match(
    text,
    /## 长期记忆（截至 \d{4}-\d{2}-\d{2}；记的是主人和主人的项目，不含鲸鱼娘自己）/u,
  );
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

test('注入自检：只按精确 persona 段的确定信号写 health', async () => {
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const { agent, agentHandlers, agentVariables } = fakeAgent(undefined, 'session-inject-check', 'whalechan');
  handlers.get('agent/created')({ agent, source: 'startup' });
  const provider = agentVariables.get('owner_memory');

  const assemble = agentHandlers.get('system-prompt/assemble');
  assert.equal(typeof assemble, 'function', '必须挂 system-prompt/assemble 做自检');

  const healthFile = path.join(root, '.dsh-mem', 'health.json');
  const readHealth = () => JSON.parse(fs.readFileSync(healthFile, 'utf8'));
  const key = `${process.pid}:session-inject-check`;
  const persona = { name: 'deployment:persona-prefix', text: '{{owner_memory}}' };

  // 人设引用变量但 variables 没注册，是确定的 not_registered。
  const missing = { sections: [persona], contexts: [], tools: [], variables: {} };
  await assemble(missing, {}, async () => missing);
  assert.equal(readHealth().injection_missing, true);
  assert.equal(readHealth().injection[key].reason, 'not_registered');

  // provider 与 assemble 共享 context，引用段仍存在 → provider_observed。
  const context = {};
  const pinned = provider(context);
  const healthy = {
    sections: [persona], contexts: [], tools: [], variables: { owner_memory: pinned },
  };
  await assemble(healthy, context, async () => healthy);
  assert.equal(readHealth().injection_missing, false);
  assert.equal(readHealth().injection[key].reason, 'provider_observed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('注入自检认结构化 assembly：{{owner_memory}} 在 persona 段里就算进去了', async () => {
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const { agent, agentHandlers, agentVariables } = fakeAgent();
  handlers.get('agent/created')({ agent, source: 'startup' });
  const context = {};
  const pinned = agentVariables.get('owner_memory')(context);

  const assemble = agentHandlers.get('system-prompt/assemble');
  const assembly = {
    sections: [
      { name: 'deployment:persona-prefix', text: '【每轮先看 · 你的记忆】\n{{owner_memory}}\n（人设从这里开始）' },
      { name: 'harness:identity', text: 'You are a coding agent.' },
    ],
    contexts: [],
    tools: [],
    variables: { owner_memory: pinned },
  };

  const returned = await assemble(assembly, context, async () => assembly);
  assert.equal(returned, assembly, '自检中间件必须原样返回 assembly');

  const readHealth = () => JSON.parse(fs.readFileSync(path.join(root, '.dsh-mem', 'health.json'), 'utf8'));
  assert.equal(readHealth().injection_missing, false, 'provider 已调用且引用段保留，不该报缺失');

  // 人设没引用变量 → n/a，不改已有状态。
  const plain = {
    sections: [{ name: 'deployment:persona-prefix', text: '这条人设没写变量。' }],
    contexts: [],
    tools: [],
    variables: { owner_memory: pinned },
  };
  await assemble(plain, {}, async () => plain);
  assert.equal(readHealth().injection_missing, false, '没引用的 assembly 不该改动 health');

  // 引用了变量但 variables 中没有注册 → 确定 missing。
  const unregistered = {
    sections: [{ name: 'deployment:persona-prefix', text: '{{owner_memory}}' }],
    contexts: [],
    tools: [],
    variables: {},
  };
  await assemble(unregistered, {}, async () => unregistered);
  assert.equal(readHealth().injection_missing, true);

  const nextContext = {};
  assembly.variables.owner_memory = agentVariables.get('owner_memory')(nextContext);
  await assemble(assembly, nextContext, async () => assembly);
  assert.equal(readHealth().injection_missing, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('健康告警按 agent 判定：没接线的 preset 不挂假警告，也不改共享 health', async () => {
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const healthFile = path.join(root, '.dsh-mem', 'health.json');
  const readHealth = () => JSON.parse(fs.readFileSync(healthFile, 'utf8'));

  const wired = fakeAgent(undefined, 'session-warn-wired', 'whalechan');
  handlers.get('agent/created')({ agent: wired.agent, source: 'startup' });
  const wiredAssemble = wired.agentHandlers.get('system-prompt/assemble');

  // 引用存在但变量未注册 → 当前 agent 确定 missing。
  const broken = {
    sections: [{ name: 'deployment:persona-prefix', text: '{{owner_memory}}' }],
    contexts: [],
    tools: [],
    variables: {},
  };
  await wiredAssemble(broken, {}, async () => broken);
  assert.equal(readHealth().injection_missing, true);

  // 没接线的 agent：n/a，不挂属于另一个 agent 的警告。
  const plain = fakeAgent(undefined, 'session-warn-plain');
  handlers.get('agent/created')({ agent: plain.agent, source: 'startup' });
  const plainAssemble = plain.agentHandlers.get('system-prompt/assemble');
  const plainInput = {
    sections: [{ name: 'deployment:persona-prefix', text: '创造模式人设，没有变量。' }],
    contexts: [],
    tools: [],
    variables: {},
  };
  await plainAssemble(plainInput, {}, async () => plainInput);
  assert.equal(readHealth().injection_missing, true, '没接线的 agent 不该改共享 health');

  const plainAudit = plain.agentRegistered.find((tool) => tool.name === 'mem_audit');
  const plainResult = await plainAudit.execute({ what: 'status' }, { agent: plain.agent });
  assert.ok(!(plainResult.warnings ?? []).some((warning) => warning.includes('{{owner_memory}}')),
    '没接线的 agent 不该收到记忆警告');

  // 接线且确实缺失的 agent：只给当前 agent 挂警告，健康记录保持 missing。
  const wiredAudit = wired.agentRegistered.find((tool) => tool.name === 'mem_audit');
  const wiredResult = await wiredAudit.execute({ what: 'status' }, { agent: wired.agent });
  assert.ok((wiredResult.warnings ?? []).some((warning) => warning.includes('{{owner_memory}}')));
  assert.equal(readHealth().injection_missing, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('A18：人设引用变量但装配未注册时按 not_registered 报警', async () => {
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const healthFile = path.join(root, '.dsh-mem', 'health.json');
  const readHealth = () => JSON.parse(fs.readFileSync(healthFile, 'utf8'));
  const create = (id, preset) => {
    const fake = fakeAgent(undefined, id, preset);
    handlers.get('agent/created')({ agent: fake.agent, source: 'startup' });
    return fake;
  };

  // 正常接线：provider 与 assemble 共用 context，引用段保留。
  const good = create('session-good', 'whalechan');
  const goodContext = {};
  const goodPinned = good.agentVariables.get('owner_memory')(goodContext);
  const goodAssembly = {
    sections: [{ name: 'deployment:persona-prefix', text: '{{owner_memory}}' }],
    contexts: [],
    tools: [],
    variables: { owner_memory: goodPinned },
  };
  await good.agentHandlers.get('system-prompt/assemble')(
    goodAssembly,
    goodContext,
    async () => goodAssembly,
  );
  assert.equal(readHealth().injection_missing, false);

  // header/preset 不参与判定；实际 persona 不引用变量就是 n/a。
  const plain = create('session-plain', 'cordis');
  const plainAssembly = {
    sections: [{ name: 'deployment:persona-prefix', text: '创造模式人设，没有变量。' }],
    contexts: [],
    tools: [],
    variables: {},
  };
  await plain.agentHandlers.get('system-prompt/assemble')(
    plainAssembly,
    {},
    async () => plainAssembly,
  );
  assert.equal(readHealth().injection_missing, false, '名单外的 preset 不该改 health');

  // A18 改为确定信号：引用仍在，但 variables 中没有注册。
  const broken = create('session-broken', 'whalechan');
  const brokenAssembly = {
    sections: [{ name: 'deployment:persona-prefix', text: '{{owner_memory}}' }],
    contexts: [],
    tools: [],
    variables: {},
  };
  await broken.agentHandlers.get('system-prompt/assemble')(
    brokenAssembly,
    {},
    async () => brokenAssembly,
  );
  const health = readHealth();
  assert.equal(health.injection_missing, true, '引用存在但变量未注册必须报出来');
  assert.equal(health.injection[`${process.pid}:session-broken`].reason, 'not_registered');
  fs.rmSync(root, { recursive: true, force: true });
});

test('A5d：只认精确 persona 段与三种确定 missing 信号', async () => {
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const healthFile = path.join(root, '.dsh-mem', 'health.json');
  const readHealth = () => {
    try { return JSON.parse(fs.readFileSync(healthFile, 'utf8')); } catch { return {}; }
  };
  const create = (id, preset = undefined) => {
    const fake = fakeAgent(undefined, id, preset);
    handlers.get('agent/created')({ agent: fake.agent, source: 'startup' });
    return fake;
  };

  const plain = create('session-a5d', 'cordis');
  const assemble = plain.agentHandlers.get('system-prompt/assemble');

  // 非 persona 段落里提到变量不算接线，也不写 health。
  const mentioned = {
    sections: [{ name: 'agent-instructions', text: '说明文档里顺嘴提到 {{owner_memory}}，不代表这条人设接线。' }],
    contexts: [],
    tools: [],
    variables: {},
  };
  await assemble(mentioned, {}, async () => mentioned);
  assert.equal(fs.existsSync(healthFile), false);

  // 精确 persona 引用存在但变量未注册 → not_registered。
  const unregistered = {
    sections: [{ name: 'deployment:persona-prefix', text: '【记忆】\n{{owner_memory}}' }],
    contexts: [],
    tools: [],
    variables: {},
  };
  await assemble(unregistered, {}, async () => unregistered);
  assert.equal(readHealth().injection[`${process.pid}:session-a5d`].reason, 'not_registered');

  // 同一 agent 改成 interpolate:false → 仍是确定 missing，并覆盖 reason。
  const interpolationOff = {
    sections: [{
      name: 'deployment:persona-prefix',
      text: '{{owner_memory}}',
      interpolate: false,
    }],
    contexts: [],
    tools: [],
    variables: { owner_memory: '【长期记忆】' },
  };
  await assemble(interpolationOff, {}, async () => interpolationOff);
  const health = readHealth();
  assert.equal(health.injection_missing, true);
  assert.equal(health.injection[`${process.pid}:session-a5d`].reason, 'interpolate_off');
  fs.rmSync(root, { recursive: true, force: true });
});

test('同工作区主 agent 正常、子代理无人设：连续五轮不互相污染', async () => {
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const unique = `${process.pid}-${Date.now()}`;
  const main = fakeAgent(undefined, `session-main-${unique}`, 'whalechan');
  const child = fakeAgent(undefined, `session-child-${unique}`, 'cordis');
  handlers.get('agent/created')({ agent: main.agent, source: 'startup' });
  handlers.get('agent/created')({ agent: child.agent, source: 'subagent' });
  const mainAssemble = main.agentHandlers.get('system-prompt/assemble');
  const childAssemble = child.agentHandlers.get('system-prompt/assemble');
  const mainPersona = { name: 'deployment:persona-prefix', text: '{{owner_memory}}' };
  const childPersona = { name: 'deployment:persona-prefix', text: '子代理无人设记忆引用。' };

  for (let round = 0; round < 5; round += 1) {
    const mainContext = {};
    const mainPinned = main.agentVariables.get('owner_memory')(mainContext);
    const mainInput = {
      sections: [mainPersona],
      contexts: [],
      tools: [],
      variables: { owner_memory: mainPinned },
    };
    await mainAssemble(mainInput, mainContext, async () => mainInput);

    const childContext = {};
    const childPinned = child.agentVariables.get('owner_memory')(childContext);
    const childInput = {
      sections: [childPersona],
      contexts: [],
      tools: [],
      variables: { owner_memory: childPinned },
    };
    await childAssemble(childInput, childContext, async () => childInput);
  }

  const health = JSON.parse(fs.readFileSync(path.join(root, '.dsh-mem', 'health.json'), 'utf8'));
  const mainKey = `${process.pid}:${main.agent.id}`;
  const childKey = `${process.pid}:${child.agent.id}`;
  assert.equal(health.injection[mainKey].verdict, 'ok');
  assert.equal(health.injection[childKey], undefined, 'n/a 子代理不应写 per-agent 明细');
  assert.equal(health.injection_missing, false);

  const probeFile = path.join(os.tmpdir(), 'dsh-owner-memory', 'load-probe.log');
  const probeText = fs.existsSync(probeFile) ? fs.readFileSync(probeFile, 'utf8') : '';
  const ownVerdicts = probeText.split(/\r?\n/u)
    .filter((line) => line.includes(`agent=${main.agent.id}`));
  assert.equal(ownVerdicts.some((line) => line.includes('verdict=missing')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('header=cordis 但实际 persona 无变量：n/a 且 health mtime 不变', async () => {
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const plain = fakeAgent(undefined, `session-cordis-na-${process.pid}`, 'cordis');
  handlers.get('agent/created')({ agent: plain.agent, source: 'startup' });
  const healthFile = path.join(root, '.dsh-mem', 'health.json');
  fs.mkdirSync(path.dirname(healthFile), { recursive: true });
  fs.writeFileSync(healthFile, `${JSON.stringify({ injection_missing: false }, null, 2)}\n`);
  const before = fs.statSync(healthFile).mtimeMs;
  const input = {
    sections: [{ name: 'deployment:persona-prefix', text: '创造模式，无记忆变量。' }],
    contexts: [],
    tools: [],
    variables: {},
  };
  await plain.agentHandlers.get('system-prompt/assemble')(input, {}, async () => input);
  assert.equal(fs.statSync(healthFile).mtimeMs, before);
  assert.deepEqual(JSON.parse(fs.readFileSync(healthFile, 'utf8')), { injection_missing: false });
  fs.rmSync(root, { recursive: true, force: true });
});

test('同 agent 后四轮 provider 未调用：相同 personaHash 以 cached 保持 ok', async () => {
  const { root, config } = workspace();
  const { host, handlers } = fakeHost();
  apply(host, config);
  const current = fakeAgent(undefined, `session-cached-${process.pid}`, 'whalechan');
  handlers.get('agent/created')({ agent: current.agent, source: 'startup' });
  const assemble = current.agentHandlers.get('system-prompt/assemble');
  const provider = current.agentVariables.get('owner_memory');
  const persona = { name: 'deployment:persona-prefix', text: '{{owner_memory}}' };
  const context = {};
  const pinned = provider(context);
  const input = {
    sections: [persona], contexts: [], tools: [], variables: { owner_memory: pinned },
  };
  await assemble(input, context, async () => input);

  const healthFile = path.join(root, '.dsh-mem', 'health.json');
  const key = `${process.pid}:${current.agent.id}`;
  assert.equal(JSON.parse(fs.readFileSync(healthFile, 'utf8')).injection[key].reason, 'provider_observed');
  const head = pinned.split(/\r?\n/u)[0];
  for (let round = 2; round <= 5; round += 1) {
    const output = {
      ...input,
      sections: [{ name: 'deployment:persona-prefix', text: `人设\n${head}\n第 ${round} 轮` }],
    };
    await assemble(input, {}, async () => output);
    const entry = JSON.parse(fs.readFileSync(healthFile, 'utf8')).injection[key];
    assert.equal(entry.verdict, 'ok');
    assert.equal(entry.reason, 'cached');
  }
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
