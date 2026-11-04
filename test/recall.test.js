import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveState } from '../src/derive.js';
import { buildIndex } from '../src/indexer.js';
import { recall, recallRules } from '../src/recall.js';
import { baseScore, KIND_WEIGHT, scoreEvent } from '../src/score.js';

const NOW = Date.parse('2026-11-02T12:00:00+08:00');

function event(id, kind, text, extra = {}) {
  return {
    id,
    ts: new Date(NOW - Number(id.replace(/\D/gu, '') || 0) * 1000).toISOString(),
    kind,
    text,
    sess: 'recall-test',
    weight: 3,
    ...extra,
  };
}

function prepared(events) {
  const state = deriveState(events);
  return { state, index: buildIndex(state) };
}

function collectKeys(value, keys = []) {
  if (value === null || typeof value !== 'object') return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectKeys(child, keys);
  }
  return keys;
}

function collectWrapperStrings(value, path = [], strings = []) {
  if (typeof value === 'string') {
    const isMemoryBody = path.length === 3
      && path[0] === 'items'
      && Number.isInteger(path[1])
      && path[2] === 'text';
    if (!isMemoryBody) strings.push(value);
    return strings;
  }
  if (value === null || typeof value !== 'object') return strings;
  for (const [key, child] of Object.entries(value)) {
    collectWrapperStrings(child, [...path, Array.isArray(value) ? Number(key) : key], strings);
  }
  return strings;
}

test('A6：revise 后原条降至 0.02 且新条目排前', () => {
  const original = event('m_n1', 'note', '量子沙箱裂纹导致配置读取失败。');
  const before = prepared([original]);
  const beforeScore = scoreEvent(before.state, before.index, original, '量子沙箱裂纹', { now: NOW }).score;
  const revision = event('m_r2', 'revise', '量子沙箱裂纹实际来自缓存失效。', { refs: [original.id] });
  const after = prepared([original, revision]);
  const oldScore = scoreEvent(after.state, after.index, original, '量子沙箱裂纹', { now: NOW }).score;
  const newScore = scoreEvent(after.state, after.index, revision, '量子沙箱裂纹', { now: NOW }).score;
  const result = recall(after.state, after.index, '量子沙箱裂纹', { now: NOW });

  assert.ok(oldScore <= beforeScore * 0.020001);
  assert.ok(newScore > oldScore);
  assert.equal(result.items[0].id, revision.id);
  assert.equal(result.items.some((item) => item.id === original.id), false);
});

test('A7：三条 revise 不给原条增加 ref_bonus', () => {
  const original = event('m_n1', 'note', '独特回归词条。');
  const revisions = [2, 3, 4].map((index) => (
    event(`m_r${index}`, 'revise', `第 ${index} 次纠正独特回归词条。`, { refs: [original.id] })
  ));
  const { state, index } = prepared([original, ...revisions]);
  const parts = scoreEvent(state, index, original, '独特回归词条', { now: NOW });
  assert.equal(parts.refs, 0);
});

test('A10：召回条数、单条、总字数与返回措辞全部封顶', () => {
  const events = Array.from({ length: 20 }, (_, index) => (
    event(
      `m_n${index}`,
      'note',
      `缓存穿透诊断${index === 0 ? '，更多细节见 §7，' : ''}${'细节'.repeat(130)}${index}`,
      { weight: 5 },
    )
  ));
  const { state, index } = prepared(events);
  const result = recall(state, index, '缓存穿透诊断', { limit: 99, maxChars: 9999, now: NOW });

  assert.ok(result.items.length <= 6);
  assert.ok(result.items.every((item) => item.text.length <= 200));
  assert.ok(result.items.reduce((sum, item) => sum + item.text.length, 0) <= 800);
  assert.ok(result.items.some((item) => item.text.includes('更多细节见 §7')));
  assert.equal(
    collectKeys(result).some((key) => /^(?:total|hasMore|remaining)$/iu.test(key)),
    false,
  );
  assert.doesNotMatch(collectWrapperStrings(result).join('\n'), /还有|更多/iu);
});

test('A11：完全无关查询诚实返回零条', () => {
  const { state, index } = prepared([event('m_n1', 'note', '本地数据库连接池配置。')]);
  assert.deepEqual(recall(state, index, '火星土豆种植计划', { now: NOW }).items, []);
});

test('H2：主体词不制造伪召回，主人 key 的具体方面仍可命中', (t) => {
  const { state, index } = prepared([
    event('m_owner_schedule', 'fact', '通常凌晨一点休息。', { key: '主人.作息' }),
    event('m_owner_editor', 'fact', '偏好使用当前编辑器。', { key: '主人.编辑器偏好' }),
    event('m_whale_note', 'note', '鲸鱼娘会先读取长期记忆。'),
  ]);
  const birthday = recall(state, index, '主人生日', { now: NOW });
  const whaleBirthday = recall(state, index, '鲸鱼娘生日', { now: NOW });
  const schedule = recall(state, index, '主人作息', { now: NOW });

  assert.deepEqual(birthday.items, []);
  assert.deepEqual(whaleBirthday.items, []);
  assert.deepEqual(schedule.items.map(({ id }) => id), ['m_owner_schedule']);
  t.diagnostic(`主人生日=${birthday.items.length} 条；主人作息=${schedule.items.length} 条`);
});

function ruleSeatFixture() {
  const events = [];
  for (let index = 1; index <= 8; index += 1) {
    const collision = index === 1 ? '(m_zq9)' : '';
    events.push(event(`m_rule${index}`, 'rule', `普通红线 ${index}：修改配置前确认。${collision}`, {
      weight: index <= 6 ? 5 : 4,
    }));
  }
  const special = event('m_zq9', 'rule', '修改 whale-chan-fixed.yml 的 maxChars 前必须备份。', { weight: 1 });
  events.push(special);
  for (let index = 1; index <= 5; index += 1) {
    events.push(event(
      `m_note${index}`,
      'note',
      `whale-chan-fixed.yml maxChars 配置定位与修改细节 ${'maxChars '.repeat(index)}`,
      { weight: 5 },
    ));
  }
  return { ...prepared(events), special };
}

test('A24：L0 外的相关 rule 获得条件席位', () => {
  const { state, index, special } = ruleSeatFixture();
  const result = recall(state, index, 'whale-chan-fixed.yml maxChars', { limit: 4, now: NOW });
  const picked = result.items.find((item) => item.id === special.id);
  const belowThreshold = Object.values(state.byId)
    .filter((item) => item.kind === 'rule' && baseScore(item, 'whale-chan-fixed.yml maxChars', index).base < 1)
    .length;

  assert.ok(picked);
  assert.ok(picked.text.startsWith('[红线]'));
  assert.equal(belowThreshold, 8);
});

test('A25：无关查询不触发 rule 席位', () => {
  const { state, index } = ruleSeatFixture();
  const query = '某个完全无关的量子咖啡坑';
  const result = recall(state, index, query, { limit: 4, now: NOW });
  const rejectedRules = Object.values(state.byId)
    .filter((item) => item.kind === 'rule' && baseScore(item, query, index).base < 1)
    .length;

  assert.equal(result.items.filter((item) => item.kind === 'rule').length, 0);
  assert.equal(KIND_WEIGHT.rule, 1.0);
  assert.equal(rejectedRules, 9);
});

test('A10b：红线条件席位不会被 800 字符预算跳过', () => {
  const rules = Array.from({ length: 6 }, (_, index) => (
    event(`m_guard${index}`, 'rule', `常驻红线 ${index}：提交前检查。`, { weight: 5 })
  ));
  const seat = event(
    'm_guard-seat',
    'rule',
    `星云协议变更前必须备份。${'席位正文'.repeat(60)}`,
    { weight: 1 },
  );
  const notes = Array.from({ length: 6 }, (_, index) => (
    event(
      `m_budget${index}`,
      'note',
      `星云协议变更诊断 ${'星云协议变更细节'.repeat(35)} ${index}`,
      { weight: 5 },
    )
  ));
  const { state, index } = prepared([...rules, seat, ...notes]);
  const result = recall(state, index, '星云协议变更', { limit: 6, now: NOW });
  const picked = result.items.find((item) => item.id === seat.id);

  assert.ok(picked);
  assert.ok(picked.text.startsWith('[红线]'));
  assert.ok(result.items.reduce((sum, item) => sum + item.text.length, 0) <= 800);
});

test('同一 state 与 query 的召回和索引逐字节确定', () => {
  const fixture = ruleSeatFixture();
  assert.equal(JSON.stringify(buildIndex(fixture.state)), JSON.stringify(buildIndex(fixture.state)));
  const first = recall(fixture.state, fixture.index, 'whale-chan-fixed.yml maxChars', { now: NOW });
  const second = recall(fixture.state, fixture.index, 'whale-chan-fixed.yml maxChars', { now: NOW });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('被取代条目即使独特词完美命中也默认不返回', () => {
  const v1 = event('m_f1', 'fact', '主人使用紫电火花引擎处理依赖。', { key: '主人.依赖工具' });
  const v2 = event('m_f2', 'fact', '主人现在使用标准包管理器处理依赖。', { key: '主人.依赖工具' });
  const { state, index } = prepared([v1, v2]);
  const result = recall(state, index, '紫电火花引擎', { now: NOW });
  assert.equal(result.items.some((item) => item.id === v1.id), false);
});

test('红线强制通道允许空 query 且独立放宽到 12 条', () => {
  const events = Array.from({ length: 14 }, (_, index) => (
    event(`m_rule${index}`, 'rule', `红线 ${index}`, { weight: 1 + (index % 5) })
  ));
  const { state, index } = prepared(events);
  const result = recallRules(state, index, { now: NOW });
  assert.equal(result.items.length, 12);
  assert.ok(result.items.reduce((sum, item) => sum + item.text.length, 0) <= 1200);
});
