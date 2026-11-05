import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assemblyReferencesVariable,
  renderAssemblyText,
  renderPinned,
  selectFacts,
  selectRules,
  truncateLine,
  verifyInjection,
} from '../src/l0.js';

function emptyState() {
  return { byId: {}, byKey: {}, status: {} };
}

function add(state, event) {
  state.byId[event.id] = event;
  state.status[event.id] = { status: 'active' };
  if (event.kind === 'fact') state.byKey[event.key] = event.id;
}

function item(index, kind, extra = {}) {
  return {
    id: `m_l0_${index.toString(16).padStart(4, '0')}`,
    ts: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    kind,
    text: `第 ${index} 条用于常驻注入预算验证的主人记忆。`,
    weight: 1 + (index % 5),
    ...extra,
  };
}

function largeState() {
  const state = emptyState();
  const kinds = ['rule', 'fact', 'todo'];
  for (let index = 0; index < 200; index += 1) {
    const kind = kinds[index % kinds.length];
    add(state, item(index, kind, kind === 'fact' ? { key: `项目.属性${String.fromCharCode(0x4e00 + index)}` } : {}));
  }
  return state;
}

test('A4：200 条候选仍不超过 1200 字符且保留六条红线', (t) => {
  const state = largeState();
  const selectedRules = selectRules(state).selected;
  const pinned = renderPinned(state, { now: new Date('2026-11-02T00:00:00Z'), health: {} });

  assert.ok(pinned.length <= 1200);
  assert.equal(selectedRules.length, 6);
  for (const rule of selectedRules) assert.ok(pinned.includes(rule.id));
  const renderedFacts = pinned.split('\n').filter((line) => (
    line.startsWith('[主人]') || line.startsWith('[项目]')
  ));
  assert.equal(renderedFacts.length, 7, '标题增长后不得从事实段额外淘汰条目');
  t.diagnostic(`A4 pinned chars=${pinned.length} facts=${renderedFacts.length}`);
});

test('A5：高分事实不挤红线，红线超配额写 health', () => {
  const state = emptyState();
  const ruleIds = [];
  for (let index = 0; index < 6; index += 1) {
    const rule = item(index, 'rule', {
      text: `红线${index}${'必须先确认并保留完整审计证据'.repeat(10)}`.slice(0, 120),
      weight: 5,
    });
    add(state, rule);
    ruleIds.push(rule.id);
  }
  for (let index = 10; index < 110; index += 1) {
    add(state, item(index, 'fact', { key: `高分事实.属性${String.fromCharCode(0x4e00 + index)}`, weight: 5, pin: true }));
  }
  const health = {};
  const pinned = renderPinned(state, { now: new Date('2026-11-02T00:00:00Z'), health });

  for (const id of ruleIds) assert.ok(pinned.includes(id));
  const renderedRules = pinned.split('\n').filter((line) => line.startsWith('[红线]'));
  assert.equal(renderedRules.length, 6);
  for (const line of renderedRules) assert.ok(line.includes('…'));
  assert.ok(pinned.length <= 1200);
  assert.equal(health.rules_overflow, true);
});

test('A5b：5 条红线 + 完整 id 落在 300 内，不截断也不写 overflow', (t) => {
  // 2026-11-04 实测形状：真实库里那 5 条红线，正文 21–30 字，id 13 字符。
  // 改配额前这里会误报 rules_overflow（304 > 260），尾注每轮喊「红线已截断」。
  const rules = [
    ['m_mw1iqtj4_9c94', '2026-11-04T10:49:55.456+08:00', '让我去问就问到双方都拍板、无需再调整才算完'],
    ['m_mw074084_2ebf', '2026-11-03T12:36:29.092+08:00', '任何 .md 改完必须跑 lint-md 到 exit=0'],
    ['m_mw07406r_e503', '2026-11-03T12:36:29.043+08:00', '顶层 inject 禁写 systemPrompt（静默坏）'],
    ['m_mw0fycaa_ffe2', '2026-11-03T16:44:01.330+08:00', '做插件前先提醒主人切创造模式（preset cordis）'],
    ['m_mw07409q_1c5c', '2026-11-03T12:36:29.150+08:00', '红线写成 32 字内的一句话命令，解释另存 note'],
  ];
  const state = emptyState();
  for (const [id, ts, text] of rules) add(state, { id, ts, kind: 'rule', text, weight: 5 });

  const health = {};
  const pinned = renderPinned(state, { now: new Date('2026-11-04T03:00:00Z'), health });
  const rendered = pinned.split('\n').filter((line) => line.startsWith('[红线]'));

  assert.equal(rendered.length, 5, '5 条红线一条都不能少');
  for (const [id] of rules) assert.ok(pinned.includes(id), `完整 id 必须保留：${id}`);
  for (const line of rendered) {
    assert.ok(!line.includes('…'), `正文没超 32 字时不该截断：${line}`);
    assert.match(line, /^\[红线\] \d{2}-\d{2}-\d{2} /u, `日期必须是 YY-MM-DD：${line}`);
  }
  assert.ok(rendered.join('\n').length <= 300, '5 条红线必须落在 300 字符配额内');
  assert.ok(pinned.length <= 1200);
  assert.equal(health.rules_overflow, false);
  assert.equal(health.rules_truncated_hard, false);
  t.diagnostic(`A5b rules chars=${rendered.join('\n').length} pinned chars=${pinned.length}`);
});

function footerOf(pinned) {
  return pinned.split('\n').at(-1);
}

function rulesState(count, text) {
  const state = emptyState();
  for (let index = 0; index < count; index += 1) {
    add(state, item(index, 'rule', {
      id: `m_mw0740${index}q_${index}c5c`,
      text,
      weight: 5,
    }));
  }
  return state;
}

test('C2（原 A5c）：6 条满 32 字红线全渲染 → 不报 overflow，只报 near_limit', (t) => {
  // 6 条约 372 字符，名义上超 300 配额，但一行没丢、正文没压——尾注不能喊「已截断」。
  const text = '必须先确认并保留完整审计证据再动手改动任何配置文件和代码'.slice(0, 32);
  const state = rulesState(6, text);
  const health = {};
  const pinned = renderPinned(state, { now: new Date('2026-11-04T03:00:00Z'), health });

  const rendered = pinned.split('\n').filter((line) => line.startsWith('[红线]'));
  assert.equal(rendered.length, 6);
  for (const line of rendered) assert.ok(!line.includes('…'), `正文不该被压：${line}`);
  assert.equal(health.rules_overflow, false);
  assert.equal(health.rules_truncated_hard, false);
  assert.equal(health.rules_near_limit, true);
  assert.equal(footerOf(pinned), "> 红线已接近配额，必要时 mem_recall(kinds=['rule'])。");
  assert.ok(!pinned.includes('已截断'));
  assert.ok(pinned.length <= 1200);
  t.diagnostic(`C2 footer=${footerOf(pinned)}`);
});

test('C3：8 条红线（超 6 条两条）→ rules_overflow=true，尾注报未常驻', (t) => {
  const state = rulesState(8, '短红线正文');
  const health = {};
  const pinned = renderPinned(state, { now: new Date('2026-11-04T03:00:00Z'), health });

  assert.equal(pinned.split('\n').filter((line) => line.startsWith('[红线]')).length, 6);
  assert.equal(health.rules_overflow, true);
  assert.equal(health.rules_near_limit, false);
  assert.equal(
    footerOf(pinned),
    "> 另有 2 条红线未常驻；任何写文件/改配置/跑命令之前，必须先 mem_recall(kinds=['rule'])。",
  );
  t.diagnostic(`C3 footer=${footerOf(pinned)}`);
});

test('C4：4 条短红线、预算充足 → 三个标志都 false，无红线尾注', (t) => {
  const state = rulesState(4, '短红线正文');
  const health = {};
  const pinned = renderPinned(state, { now: new Date('2026-11-04T03:00:00Z'), health });

  assert.equal(pinned.split('\n').filter((line) => line.startsWith('[红线]')).length, 4);
  assert.equal(health.rules_overflow, false);
  assert.equal(health.rules_truncated_hard, false);
  assert.equal(health.rules_near_limit, false);
  assert.equal(footerOf(pinned), '> 更多细节用 mem_recall 查。');
  assert.ok(!pinned.includes('红线未常驻') && !pinned.includes('红线内容已截断') && !pinned.includes('接近配额'));
  t.diagnostic(`C4 footer=${footerOf(pinned)}`);
});

test('C2b：没丢行但正文超 32 字被压 → 尾注报「红线内容已截断」', () => {
  const state = rulesState(1, '这是一条明显超过三十二字符上限的红线正文，用来逼出截断标记和尾注验证。');
  const health = {};
  const pinned = renderPinned(state, { now: new Date('2026-11-04T03:00:00Z'), health });

  assert.equal(health.rules_overflow, true);
  assert.equal(health.rules_near_limit, false);
  assert.equal(
    footerOf(pinned),
    "> 红线内容已截断；任何写文件/改配置/跑命令之前，必须先 mem_recall(kinds=['rule'])。",
  );
});

test('H1/H2/H3：新标题、事实主体标签与注入自检均正确，且条数和总预算不变', (t) => {
  const state = emptyState();
  add(state, item(1, 'fact', { key: '主人.编辑器偏好', text: '主人偏好使用当前编辑器。' }));
  add(state, item(2, 'fact', { key: 'dsh-fish.运行状态', text: 'dsh-fish 当前正常运行。' }));
  const pinned = renderPinned(state, { now: new Date('2026-11-02T00:00:00Z'), health: {} });
  assert.equal(
    pinned.split('\n')[0],
    '## 长期记忆（截至 2026-11-02；记的是主人和主人的项目，不含鲸鱼娘自己）',
  );
  const factLines = pinned.split('\n').filter((line) => (
    line.startsWith('[主人]') || line.startsWith('[项目]')
  ));
  assert.equal(factLines.length, selectFacts(state, { now: new Date('2026-11-02T00:00:00Z') }).length);
  assert.ok(factLines.some((line) => line.startsWith('[主人]') && line.includes('m_l0_0001')));
  assert.ok(factLines.some((line) => line.startsWith('[项目]') && line.includes('m_l0_0002')));
  assert.equal(pinned.includes('[事实]'), false);
  assert.deepEqual(verifyInjection(`persona\n${pinned}\nend`, pinned), { ok: true, missing: false });
  assert.deepEqual(verifyInjection('persona without owner memory', pinned), { ok: false, missing: true });
  assert.ok(pinned.length <= 1200);
  t.diagnostic(`H3 pinned chars=${pinned.length} facts=${factLines.length}`);
});

test('同一 state 两次渲染逐字节相同', () => {
  const state = largeState();
  const options = { now: new Date('2026-11-02T00:00:00Z'), health: {} };
  assert.equal(renderPinned(state, options), renderPinned(state, options));
});

test('超长 fact 截断后 id 仍在输出', () => {
  const state = emptyState();
  const fact = item(1, 'fact', {
    key: '主人.超长偏好',
    text: '这是一条非常长的事实文本，用来证明截断以后仍然保留原始事件标识，方便后续召回完整内容。',
  });
  add(state, fact);
  const pinned = renderPinned(state, { now: new Date('2026-11-02T00:00:00Z'), health: {} });

  assert.ok(pinned.includes(fact.id));
  assert.ok(pinned.includes(truncateLine(fact.text, fact.id)));
});

test('红线溢出数组与溢出条数一致', () => {
  const state = emptyState();
  for (let index = 0; index < 9; index += 1) add(state, item(index, 'rule'));
  const result = selectRules(state, { limit: 6 });

  assert.equal(result.selected.length, 6);
  assert.equal(result.overflow.length, 3);
  assert.deepEqual(result.overflow.map((event) => event.id), selectRules(state, { limit: 6 }).overflow.map((event) => event.id));
});

test('50 组随机 state 始终安全且确定性渲染', () => {
  let seed = 0x5eed1234;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const kinds = ['rule', 'fact', 'todo', 'decision', 'note'];

  for (let sample = 0; sample < 50; sample += 1) {
    const state = emptyState();
    const count = Math.floor(random() * 240);
    for (let index = 0; index < count; index += 1) {
      const kind = kinds[Math.floor(random() * kinds.length)];
      const idLength = 1 + Math.floor(random() * 300);
      const textLength = Math.floor(random() * 500);
      add(state, {
        id: `m_${sample}_${index}_${'x'.repeat(idLength)}`,
        ts: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        kind,
        text: '记'.repeat(textLength),
        weight: 1 + Math.floor(random() * 5),
        pin: random() > 0.5,
        ...(kind === 'fact' ? { key: `随机项目.属性${sample}_${index}` } : {}),
      });
    }
    const now = new Date('2026-11-02T00:00:00Z');
    let first;
    assert.doesNotThrow(() => {
      first = renderPinned(state, { now, health: {} });
    });
    const second = renderPinned(state, { now, health: {} });
    assert.ok(first.length <= 1200);
    assert.ok(first.startsWith('## 长期记忆（截至 '));
    assert.equal(
      first.split('\n').filter((line) => line.startsWith('[红线]')).length,
      selectRules(state).selected.length,
    );
    assert.equal(second, first);
  }
});

test('renderAssemblyText：结构化 assembly 按宿主的 {{变量}} 规则插值', () => {
  const pinned = '## 长期记忆（截至 2026-11-03；记的是主人和主人的项目，不含鲸鱼娘自己）\n[红线] 不许把密钥写进记忆。';
  const assembly = {
    sections: [
      { name: 'persona', text: `【每轮先看 · 你的记忆】\n{{owner_memory}}\n（下面是人设）` },
      { name: 'harness:identity', text: 'You are a coding agent.' },
    ],
    contexts: [{ name: 'runtime', text: '{{owner_memory}} 的尾巴' }],
    tools: [],
    variables: { owner_memory: pinned },
  };
  const text = renderAssemblyText(assembly);
  assert.ok(text.includes(pinned), '插值后必须能找到记忆首行');
  assert.ok(!text.includes('{{owner_memory}}'), '已注册的变量不该以字面量留下');
  assert.equal(verifyInjection(text, pinned).missing, false);
});

test('renderAssemblyText：未知变量保持字面量，自检判失败', () => {
  const text = renderAssemblyText({
    sections: [{ name: 'persona', text: '{{owner_memory}}' }],
    contexts: [],
    variables: {},
  });
  assert.equal(text, '{{owner_memory}}');
  assert.equal(
    verifyInjection(text, '## 长期记忆（截至 2026-11-03；记的是主人和主人的项目，不含鲸鱼娘自己）').missing,
    true,
  );
});

test('renderAssemblyText：interpolate:false 不插值，字符串原样返回', () => {
  const literal = renderAssemblyText({
    sections: [{ name: 'raw', text: '{{owner_memory}}', interpolate: false }],
    variables: { owner_memory: '不该出现' },
  });
  assert.equal(literal, '{{owner_memory}}');
  assert.equal(renderAssemblyText('已经是文本'), '已经是文本');
  assert.equal(renderAssemblyText(null), '');
});

test('assemblyReferencesVariable：只认真的 {{变量}} 引用', () => {
  assert.equal(assemblyReferencesVariable({
    sections: [{ name: 'persona', text: '开头 {{owner_memory}} 结尾' }],
  }, 'owner_memory'), true);
  assert.equal(assemblyReferencesVariable({
    contexts: [{ name: 'runtime', text: '{{ owner_memory }}' }],
    sections: [],
  }, 'owner_memory'), true, '带空格也算引用');
  assert.equal(assemblyReferencesVariable({
    sections: [{ name: 'persona', text: '没有引用任何变量' }],
  }, 'owner_memory'), false);
  assert.equal(assemblyReferencesVariable({
    sections: [{ name: 'persona', text: '{{other_memory}}' }],
  }, 'owner_memory'), false, '别的变量不算');
  assert.equal(assemblyReferencesVariable(null, 'owner_memory'), false);
});

test('assemblyReferencesVariable：{ section } 只认人设段，文档里提到变量不算接线', () => {
  // 2026-11-04 真机：创造模式的 assembly 里有一段非 persona 文本带着 `{{owner_memory}}`，
  // 被判成「引用了却没进去」，每轮把 injection_missing 写成 true。
  const assembly = {
    sections: [
      { name: 'agent-instructions', text: '工作区说明里顺嘴提到 {{owner_memory}}，不代表这条人设接线了。' },
      { name: 'harness:identity', text: 'You are a coding agent.' },
    ],
    contexts: [{ name: 'runtime', text: '{{owner_memory}} 只出现在说明里' }],
  };
  assert.equal(assemblyReferencesVariable(assembly, 'owner_memory'), true, '不带过滤时仍按「提到」处理');
  assert.equal(assemblyReferencesVariable(assembly, 'owner_memory', { section: 'persona' }), false);

  const wired = {
    sections: [
      { name: 'persona', text: '【记忆】\n{{owner_memory}}' },
      { name: 'agent-instructions', text: '无关段落' },
    ],
    contexts: [],
  };
  assert.equal(assemblyReferencesVariable(wired, 'owner_memory', { section: 'persona' }), true);
  assert.equal(assemblyReferencesVariable({
    sections: [{ name: 'persona-prefix', text: '{{owner_memory}}' }],
  }, 'owner_memory', { section: 'persona' }), true, '段名带 persona 后缀也算');
  assert.equal(assemblyReferencesVariable({
    contexts: [{ name: 'persona', text: '{{owner_memory}}' }],
    sections: [],
  }, 'owner_memory', { section: 'persona' }), true, 'contexts 里的 persona 段也认');
});


