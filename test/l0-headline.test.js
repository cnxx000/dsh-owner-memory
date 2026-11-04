import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { renderPinned, selectFacts } from '../src/l0.js';
import { readEvents } from '../src/storage/event-log.js';
import { memFact } from '../src/tools/mem_fact.js';

const NOW = new Date('2026-11-04T12:00:00.000Z');

function emptyState() {
  return { byId: {}, byKey: {}, status: {}, confirmCount: {} };
}

function addFact(state, index, {
  key = `项目.方面${index}`,
  text = `事实正文 ${index}`,
  headline,
  ts = `2026-11-${String(index + 1).padStart(2, '0')}T01:02:03.000Z`,
} = {}) {
  const event = {
    id: `m_headline_${String(index).padStart(4, '0')}`,
    ts,
    kind: 'fact',
    key,
    text,
    weight: 3,
    ...(headline === undefined ? {} : { headline }),
  };
  state.byId[event.id] = event;
  state.byKey[key] = event.id;
  state.status[event.id] = { status: 'active' };
  return event;
}

function addRule(state, text) {
  const event = {
    id: 'm_headrule_0001',
    ts: '2026-11-04T00:00:00.000Z',
    kind: 'rule',
    text,
    weight: 5,
  };
  state.byId[event.id] = event;
  state.status[event.id] = { status: 'active' };
}

function factLines(pinned) {
  return pinned.split('\n').filter((line) => (
    line.startsWith('[主人]') || line.startsWith('[项目]')
  ));
}

test('headline 写入事件并由 schema 拒绝超长或换行值', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-headline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = resolveConfig({ workspace: root });

  const result = await memFact(config, {
    key: '项目.当前结论',
    text: '项目已完成事实验证。',
    headline: '验证通过',
  }, { sessionId: 'headline-write' });
  assert.equal(
    readEvents(config.localRoot).events.find((event) => event.id === result.id).headline,
    '验证通过',
  );

  for (const headline of ['十九个字的结论会因为超过十八字而被拒绝掉', '结论\n换行']) {
    await assert.rejects(
      memFact(config, {
        key: '项目.非法结论',
        text: '这条不应落盘。',
        headline,
      }, { sessionId: 'headline-invalid' }),
      (error) => error.code === 'E_SCHEMA',
    );
  }
});

test('H1 混排：headline 新格式与无 headline 旧格式同段共存', () => {
  const state = emptyState();
  addFact(state, 0, {
    key: '主人.编辑器偏好',
    text: '主人当前使用 Cursor。',
    headline: '继续使用 Cursor',
  });
  const legacy = addFact(state, 1, {
    key: '项目.兼容状态',
    text: '项目兼容路径仍按旧记录展示。',
  });
  const pinned = renderPinned(state, { now: NOW, health: {} });
  const lines = factLines(pinned);

  assert.ok(lines.includes('[主人] 11-01 主人.编辑器偏好：继续使用 Cursor'));
  assert.ok(lines.includes(`[项目] 26-11-02 ${legacy.text}(${legacy.id})`));
});

test('H2 跨年：今年省略年份，去年保留两位年份', () => {
  const state = emptyState();
  addFact(state, 0, {
    key: '项目.今年状态',
    headline: '今年结论',
    ts: '2026-01-02T00:00:00.000Z',
  });
  addFact(state, 1, {
    key: '项目.去年状态',
    headline: '去年结论',
    ts: '2025-12-31T23:00:00.000Z',
  });
  const lines = factLines(renderPinned(state, { now: NOW, health: {} }));

  assert.ok(lines.some((line) => line.includes(' 01-02 项目.今年状态：今年结论')));
  assert.ok(lines.some((line) => line.includes(' 25-12-31 项目.去年状态：去年结论')));
});

test('H3 撞名：相同方面段用对象前缀消歧', () => {
  const state = emptyState();
  addFact(state, 0, { key: 'a.状态', headline: '正常' });
  addFact(state, 1, { key: 'b.状态', headline: '异常' });
  const lines = factLines(renderPinned(state, { now: NOW, health: {} }));

  assert.ok(lines.some((line) => line.includes(' a.状态：正常')));
  assert.ok(lines.some((line) => line.includes(' b.状态：异常')));
});

test('H4 超长：不再裁掉 headline 或对象标签', () => {
  const state = emptyState();
  addFact(state, 0, {
    key: '项目.一二三四五六七八九十一二',
    headline: '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未',
  });
  const health = {};
  const [line] = factLines(renderPinned(state, { now: NOW, health }));
  const conclusion = line.match(/^\[项目\] 11-01 (.+)：(.+)$/u);

  assert.ok(conclusion);
  assert.equal(conclusion[1], '项目.一二三四五六七八九十一二');
  assert.equal(conclusion[2], '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未');
  assert.deepEqual(health.fact_label_long, ['项目.一二三四五六七八九十一二']);
});

test('H5 静默丢条：前八名不是渲染就是进入 fact_overflow', () => {
  const state = emptyState();
  for (let index = 0; index < 9; index += 1) {
    addFact(state, index, {
      key: `项目.长事实${index}`,
      text: `第${index}条${'用于挤满事实段字符预算的长正文'.repeat(8)}`,
      ts: `2026-11-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    });
  }
  addRule(state, '这是一条超长红线，要求在所有修改前完成确认和审计，并保留完整证据以便复核。');
  const health = {};
  const pinned = renderPinned(state, { now: NOW, health });
  const topEight = selectFacts(state, { limit: 8, now: NOW });
  const renderedKeys = new Set(
    topEight.filter((event) => pinned.includes(event.id)).map((event) => event.key),
  );
  const accounted = [...new Set([...renderedKeys, ...health.fact_overflow])].sort();

  assert.deepEqual(accounted, topEight.map((event) => event.key).sort());
  assert.deepEqual(health.fact_overflow, [...health.fact_overflow].sort());
  assert.deepEqual(
    health.fact_headline_missing,
    topEight.map((event) => event.key).sort(),
  );
});

test('H6 旧格式不变：无 headline 的事实逐字节沿用原格式', () => {
  const state = emptyState();
  const event = addFact(state, 0, {
    key: '项目.旧格式',
    text: '一二三四五六七八九十一二三四五六七八九十二二二三四五六七八九十三二三四五六',
    ts: '2026-11-04T01:02:03.000Z',
  });
  const [line] = factLines(renderPinned(state, { now: NOW, health: {} }));

  assert.equal(
    line,
    `[项目] 26-11-04 ${event.text.slice(0, 32)}…(${event.id})`,
  );
});

test('L1：bili账号 使用英文开头简称', () => {
  const state = emptyState();
  addFact(state, 0, {
    key: 'bili账号.发言能力',
    headline: '已转正，可发评论',
    ts: '2026-11-04T01:02:03.000Z',
  });

  assert.ok(factLines(renderPinned(state, { now: NOW, health: {} }))
    .includes('[项目] 11-04 bili.发言能力：已转正，可发评论'));
});

test('L2：中英混合对象分别截取 cursor 与用户级', () => {
  const state = emptyState();
  addFact(state, 0, { key: 'cursor模型.分工', headline: '设计与实现分开' });
  addFact(state, 1, { key: '用户级skill.x', headline: '全预设可见' });
  const lines = factLines(renderPinned(state, { now: NOW, health: {} }));

  assert.ok(lines.some((line) => line.includes(' cursor.分工：设计与实现分开')));
  assert.ok(lines.some((line) => line.includes(' 用户级.x：全预设可见')));
});

test('L3：开头同类段不足两字时使用对象前四字', () => {
  const state = emptyState();
  addFact(state, 0, { key: 'b站账号.x', headline: '已配置' });
  const [line] = factLines(renderPinned(state, { now: NOW, health: {} }));

  assert.ok(line.includes(' b站账号.x：已配置'));
});

test('L4：全部 active 键中的简称冲突改用完整对象段', () => {
  const state = emptyState();
  addFact(state, 0, { key: 'bili账号.a', headline: '账号结论' });
  addFact(state, 1, { key: 'bili登录.b', headline: '登录结论' });
  const lines = factLines(renderPinned(state, { now: NOW, health: {} }));

  assert.ok(lines.some((line) => line.includes(' bili账号.a：账号结论')));
  assert.ok(lines.some((line) => line.includes(' bili登录.b：登录结论')));
});

test('L5：headline 已含简称时省略对象且大小写不敏感', () => {
  const state = emptyState();
  addFact(state, 0, { key: 'bili账号.状态', headline: 'BILI 已完成转正' });
  const [line] = factLines(renderPinned(state, { now: NOW, health: {} }));

  assert.ok(line.includes(' 状态：BILI 已完成转正'));
  assert.ok(!line.includes(' bili.状态：'));
});

test('L6：标签与 headline 超 26 字仍完整渲染并进入 fact_label_long', () => {
  const state = emptyState();
  const key = 'cursor模型.一二三四五六七八九十一二';
  const headline = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未';
  addFact(state, 0, { key, headline });
  const health = {};
  const [line] = factLines(renderPinned(state, { now: NOW, health }));

  assert.ok(line.includes(` cursor.一二三四五六七八九十一二：${headline}`));
  assert.deepEqual(health.fact_label_long, [key]);
});
