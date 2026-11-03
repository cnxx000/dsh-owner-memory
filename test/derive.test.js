import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveState } from '../src/derive.js';
import { MemoryError } from '../src/schema.js';

function event(id, kind, extra = {}) {
  return {
    id,
    ts: `2026-11-02T10:00:${String(Number(id.slice(-1)) || 0).padStart(2, '0')}+08:00`,
    kind,
    text: `测试事件 ${id}`,
    sess: 'derive-test',
    ...extra,
  };
}

test('A8：同 key 的事实只保留最新 active 值', () => {
  const v1 = event('m_v1', 'fact', { key: '主人.编辑器偏好' });
  const v2 = event('m_v2', 'fact', { key: '主人.编辑器偏好' });
  const v3 = event('m_v3', 'fact', { key: '主人.编辑器偏好' });
  const state = deriveState([v1, v2, v3]);

  assert.equal(state.byKey['主人.编辑器偏好'], v3.id);
  assert.deepEqual(state.status[v1.id], { status: 'superseded', supersededBy: v2.id });
  assert.deepEqual(state.status[v2.id], { status: 'superseded', supersededBy: v3.id });
  assert.deepEqual(state.status[v3.id], { status: 'active' });
});

test('A9：retract 最新事实后上一条事实恢复 active', () => {
  const v1 = event('m_v1', 'fact', { key: '主人.编辑器偏好' });
  const v2 = event('m_v2', 'fact', { key: '主人.编辑器偏好' });
  const v3 = event('m_v3', 'fact', { key: '主人.编辑器偏好' });
  const retract = event('m_r4', 'retract', { refs: [v3.id] });
  const state = deriveState([v1, v2, v3, retract]);

  assert.equal(state.byKey['主人.编辑器偏好'], v2.id);
  assert.deepEqual(state.status[v2.id], { status: 'active' });
  assert.deepEqual(state.status[v3.id], { status: 'retracted', retractedBy: retract.id });
});

test('A9b：revise 当前事实时回退；没有旧值时删除键', () => {
  const key = '主人.编辑器偏好';
  const v1 = event('m_v1', 'fact', { key });
  const v2 = event('m_v2', 'fact', { key });
  const reviseV2 = event('m_r3', 'revise', { refs: [v2.id] });
  const withHistory = deriveState([v1, v2, reviseV2]);

  assert.equal(withHistory.byKey[key], v1.id);
  assert.deepEqual(withHistory.status[v1.id], { status: 'active' });
  assert.deepEqual(withHistory.status[v2.id], { status: 'revised', revisedBy: reviseV2.id });

  const reviseOnly = event('m_r2', 'revise', { refs: [v1.id] });
  const withoutHistory = deriveState([v1, reviseOnly]);
  assert.equal(Object.hasOwn(withoutHistory.byKey, key), false);
  assert.deepEqual(withoutHistory.status[v1.id], { status: 'revised', revisedBy: reviseOnly.id });
});

test('revise 派生结果逐字节幂等', () => {
  const note = event('m_n1', 'note');
  const revise = event('m_r2', 'revise', { refs: [note.id] });
  const events = [note, revise];
  const first = deriveState(events);
  const second = deriveState(events);

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.status[note.id], { status: 'revised', revisedBy: revise.id });
});

test('retract 引用不存在的 id 时拒绝派生', () => {
  const retract = event('m_r1', 'retract', { refs: ['m_missing'] });
  assert.throws(
    () => deriveState([retract]),
    (error) => error instanceof MemoryError && error.code === 'E_REF_NOT_FOUND',
  );
});
