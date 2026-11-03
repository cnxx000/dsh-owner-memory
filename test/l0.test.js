import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assemblyReferencesVariable,
  renderAssemblyText,
  renderPinned,
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
  t.diagnostic(`A4 pinned chars=${pinned.length}`);
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

test('A18：提示词首行特征串可检出注入缺失', () => {
  const pinned = '## 关于主人（截至 2026-11-02）\n> 更多细节用 mem_recall 查。';
  assert.deepEqual(verifyInjection(`persona\n${pinned}\nend`, pinned), { ok: true, missing: false });
  assert.deepEqual(verifyInjection('persona without owner memory', pinned), { ok: false, missing: true });
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
    assert.ok(first.startsWith('## 关于主人（截至 '));
    assert.equal(
      first.split('\n').filter((line) => line.startsWith('[红线]')).length,
      selectRules(state).selected.length,
    );
    assert.equal(second, first);
  }
});

test('renderAssemblyText：结构化 assembly 按宿主的 {{变量}} 规则插值', () => {
  const pinned = '## 关于主人（截至 2026-11-03）\n[红线] 不许把密钥写进记忆。';
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
  assert.equal(verifyInjection(text, '## 关于主人（截至 2026-11-03）').missing, true);
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


