import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderPinned } from '../src/l0.js';
import { persistPinnedHealth, readJson } from '../src/storage/files.js';

function stateWithRule(text) {
  const event = {
    id: 'm_persist_0001',
    ts: '2026-11-03T00:00:00.000Z',
    kind: 'rule',
    text,
    weight: 5,
  };
  return {
    byId: { [event.id]: event },
    byKey: {},
    status: { [event.id]: { status: 'active' } },
  };
}

function healthFile(root) {
  return readJson(path.join(root, 'health.json'), {});
}

test('rules_overflow 落盘：截断写 true，不截断写回 false', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-l0-health-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 超过 32 字符 → L0 会截断，health 必须记下来
  const longHealth = {};
  renderPinned(stateWithRule('这是一条明显超过三十二字符上限的红线正文，用来逼出截断标记和落盘验证。'), {
    health: longHealth,
  });
  assert.equal(longHealth.rules_overflow, true);
  persistPinnedHealth(root, longHealth);
  assert.equal(healthFile(root).rules_overflow, true);

  // 32 字符内 → 不截断，指标要能回落，不能只升不降
  const shortHealth = {};
  renderPinned(stateWithRule('短红线'), { health: shortHealth });
  assert.equal(shortHealth.rules_overflow, false);
  persistPinnedHealth(root, shortHealth);
  assert.equal(healthFile(root).rules_overflow, false);

  persistPinnedHealth(root, { rules_overflow: false, rules_near_limit: true });
  assert.equal(healthFile(root).rules_near_limit, true);
  persistPinnedHealth(root, shortHealth);
  assert.equal(healthFile(root).rules_near_limit, false);

  // 落盘只覆盖配额两项，别把别的 health 字段冲掉
  persistPinnedHealth(root, longHealth);
  assert.equal(healthFile(root).injection_missing, false);
});
