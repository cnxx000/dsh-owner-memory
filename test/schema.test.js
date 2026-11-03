import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryError, validateEvent, validateKey } from '../src/schema.js';

const badKeys = [
  '主人.身高180',
  '项目.用pnpm',
  '主人',
  '偏好',
  '主人.喜欢的东西',
  'dsh.0.2.1.路径',
  '主人.今天的心情',
];

for (const key of badKeys) {
  test(`§3.3 反例以 E_BAD_KEY 拒绝：${key}`, () => {
    assert.throws(
      () => validateKey(key),
      (error) => error instanceof MemoryError && error.code === 'E_BAD_KEY',
    );
  });
}

test('fact 必须有合法 key，纠正类必须有 refs', () => {
  const base = {
    id: 'm_mhl1z_1a2b',
    ts: '2026-11-02T17:00:00+08:00',
    text: '主人 2026-11-02 的事实。',
    sess: 'schema-test',
  };
  assert.throws(
    () => validateEvent({ ...base, kind: 'fact' }),
    (error) => error.code === 'E_BAD_KEY',
  );
  assert.throws(
    () => validateEvent({ ...base, kind: 'revise' }),
    (error) => error.code === 'E_SCHEMA',
  );
});
