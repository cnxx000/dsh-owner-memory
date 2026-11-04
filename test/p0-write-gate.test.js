import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../src/config.js';
import { readEvents } from '../src/storage/event-log.js';
import { memFix } from '../src/tools/mem_fix.js';
import { memNote } from '../src/tools/mem_note.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-p0-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return resolveConfig({ workspace: root });
}

function eventCount(config) {
  return readEvents(config.localRoot).events.length;
}

test('D9：decision 禁止 retract 且不落盘', async (t) => {
  const config = workspace(t);
  const decision = await memNote(config, {
    kind: 'decision',
    text: 'D9 决定继续使用现有发布流程。',
  }, { sessionId: 'd9-note' });
  const before = eventCount(config);

  await assert.rejects(
    memFix(config, {
      op: 'retract',
      refs: [decision.id],
      text: '撤销该决策。',
    }, { sessionId: 'd9-fix' }),
    (error) => error.code === 'E_RETRACT_FORBIDDEN',
  );
  assert.equal(eventCount(config), before);
});

test('D10：rule 无 ownerQuote 禁止 retract 且不落盘', async (t) => {
  const config = workspace(t);
  const rule = await memNote(config, {
    kind: 'rule',
    text: 'D10 修改文件前必须先确认范围。',
  }, { sessionId: 'd10-note' });
  const before = eventCount(config);

  await assert.rejects(
    memFix(config, {
      op: 'retract',
      refs: [rule.id],
      text: '撤销该规则。',
    }, { sessionId: 'd10-fix' }),
    (error) => error.code === 'E_RULE_RETRACT_FORBIDDEN',
  );
  assert.equal(eventCount(config), before);
});

test('D11：rule 带 ownerQuote 可以 retract 且原话落盘', async (t) => {
  const config = workspace(t);
  const rule = await memNote(config, {
    kind: 'rule',
    text: 'D11 修改配置前必须备份。',
  }, { sessionId: 'd11-note' });
  const ownerQuote = '这条红线可以撤掉。';

  const result = await memFix(config, {
    op: 'retract',
    refs: [rule.id],
    text: '主人明确撤销该规则。',
    ownerQuote,
  }, { sessionId: 'd11-fix' });
  const written = readEvents(config.localRoot).events.find((event) => event.id === result.id);

  assert.equal(result.status, 'written');
  assert.equal(written.ownerQuote, ownerQuote);
});

test('D12：rule 与非 rule 混合 retract 整体拒绝', async (t) => {
  const config = workspace(t);
  const rule = await memNote(config, {
    kind: 'rule',
    text: 'D12 发布前必须运行完整测试。',
  }, { sessionId: 'd12-rule' });
  const note = await memNote(config, {
    kind: 'note',
    text: 'D12 记录一次普通发布说明。',
  }, { sessionId: 'd12-note' });
  const before = eventCount(config);

  await assert.rejects(
    memFix(config, {
      op: 'retract',
      refs: [rule.id, note.id],
      text: '尝试混合撤销。',
      ownerQuote: '撤掉规则。',
    }, { sessionId: 'd12-fix' }),
    (error) => error.code === 'E_RULE_RETRACT_FORBIDDEN' && error.details?.mixed === true,
  );
  assert.equal(eventCount(config), before);
});

test('D13：提议撤红线 tag 可以写入', async (t) => {
  const config = workspace(t);
  const result = await memNote(config, {
    kind: 'note',
    text: '建议撤销指定红线，等待主人裁决。',
    tags: ['提议撤红线'],
  }, { sessionId: 'd13-note' });
  const written = readEvents(config.localRoot).events.find((event) => event.id === result.id);

  assert.equal(result.status, 'written');
  assert.deepEqual(written.tags, ['提议撤红线']);
});
