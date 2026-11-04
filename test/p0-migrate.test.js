import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSupersedeEvent,
  migrateP0History,
  plannedP0Events,
} from '../src/migrate/p0-history.js';
import { initRoot } from '../src/storage/files.js';

const IDS = Object.freeze({
  oldRule1: 'm_mw04dvx1_ef2e',
  oldRule2: 'm_mw04dvyh_c92b',
  newRule1: 'm_mw07406r_e503',
  newRule2: 'm_mw074084_2ebf',
  oldDecision: 'm_mw0de7kd_b3ff',
  halfDecision: 'm_mw0e2fk9_825d',
  finalDecision: 'm_mw0sofv5_4f93',
  injectionFact: 'm_mw06tca2_cea9',
  biliFact: 'm_mw0sjom4_cbe7',
});

function event(index, id, kind, extra = {}) {
  return {
    id,
    ts: new Date(Date.UTC(2026, 10, 3, 0, 0, index)).toISOString(),
    kind,
    text: `P0 迁移夹具事件 ${index}。`,
    weight: 2,
    scope: 'local',
    src: 'agent',
    sess: 'p0-migrate-test',
    ...extra,
  };
}

function fixtureEvents() {
  return [
    event(1, IDS.oldRule1, 'rule'),
    event(2, IDS.oldRule2, 'rule'),
    event(3, IDS.injectionFact, 'fact', { key: 'injection-check.判定作用域', weight: 3 }),
    event(4, IDS.newRule1, 'rule'),
    event(5, IDS.newRule2, 'rule'),
    event(6, 'm_mw07426q_fb4e', 'retract', { refs: [IDS.oldRule1, IDS.oldRule2] }),
    event(7, IDS.oldDecision, 'decision'),
    event(8, 'm_mw0e28u3_42a9', 'retract', { refs: [IDS.oldDecision] }),
    event(9, IDS.halfDecision, 'decision'),
    event(10, IDS.biliFact, 'fact', { key: 'bili账号.cookie位置', weight: 4 }),
    event(11, 'm_mw0softk_ee06', 'retract', { refs: [IDS.halfDecision] }),
    event(12, IDS.finalDecision, 'decision'),
    event(13, 'm_mw06vgcb_fd07', 'revise', { refs: [IDS.injectionFact] }),
    event(14, 'm_mw0su4vp_6c0a', 'revise', { refs: [IDS.biliFact] }),
  ];
}

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-p0-migrate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, '.dsh-mem');
  initRoot(root);
  const events = fixtureEvents();
  fs.writeFileSync(path.join(root, 'events.jsonl'), `${events.map((item) => JSON.stringify(item)).join('\n')}\n`);
  return root;
}

test('P0 迁移：六条事件幂等、旧字节不变、状态与补回键正确', async (t) => {
  const root = workspace(t);
  const eventFile = path.join(root, 'events.jsonl');
  const before = fs.readFileSync(eventFile);
  const first = await migrateP0History(root, { now: '2026-11-04T05:00:00.000Z' });
  const afterFirst = fs.readFileSync(eventFile);
  const second = await migrateP0History(root, { now: '2026-11-04T06:00:00.000Z' });
  const afterSecond = fs.readFileSync(eventFile);

  assert.equal(first.added.length, 6);
  assert.equal(first.afterLines, first.beforeLines + 6);
  assert.equal(second.added.length, 0);
  assert.equal(second.skipped.length, 6);
  assert.equal(second.afterLines, first.afterLines);
  assert.deepEqual(afterSecond, afterFirst);
  assert.deepEqual(afterFirst.subarray(0, before.length), before);

  const factByKey = Object.fromEntries(first.added
    .filter((item) => item.kind === 'fact')
    .map((item) => [item.key, item.id]));
  assert.equal(first.state.byKey['bili账号.cookie位置'], factByKey['bili账号.cookie位置']);
  assert.equal(first.state.byKey['injection-check.判定作用域'], factByKey['injection-check.判定作用域']);

  const expected = [
    [IDS.oldRule1, IDS.newRule1, 'm_mw07426q_fb4e'],
    [IDS.oldRule2, IDS.newRule2, 'm_mw07426q_fb4e'],
    [IDS.oldDecision, IDS.halfDecision, 'm_mw0e28u3_42a9'],
    [IDS.halfDecision, IDS.finalDecision, 'm_mw0softk_ee06'],
  ];
  for (const [oldId, newId, retractedBy] of expected) {
    assert.deepEqual(first.state.status[oldId], {
      status: 'superseded',
      supersededBy: newId,
      prevStatus: { status: 'retracted', retractedBy },
    });
  }
});

test('P0 迁移：白名单外 id 与未批准配对均拒绝', () => {
  assert.throws(
    () => createSupersedeEvent('m_not_allowed_0000', IDS.newRule1),
    (error) => error.code === 'E_MIGRATE_WHITELIST',
  );
  assert.throws(
    () => createSupersedeEvent(IDS.oldRule1, IDS.finalDecision),
    (error) => error.code === 'E_MIGRATE_WHITELIST',
  );
});

test('P0 迁移：锁内同时识别 archive 中已有迁移 id', async (t) => {
  const root = workspace(t);
  const archived = plannedP0Events('2026-11-04T04:00:00.000Z')[0];
  fs.writeFileSync(
    path.join(root, 'archive', '2026-Q4.jsonl'),
    `${JSON.stringify(archived)}\n`,
  );

  const result = await migrateP0History(root, { now: '2026-11-04T05:00:00.000Z' });
  assert.equal(result.added.length, 5);
  assert.ok(result.skipped.includes(archived.id));
  assert.deepEqual(result.state.status[IDS.oldRule1], {
    status: 'superseded',
    supersededBy: IDS.newRule1,
    prevStatus: { status: 'retracted', retractedBy: 'm_mw07426q_fb4e' },
  });
});
