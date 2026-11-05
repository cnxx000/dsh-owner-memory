import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyAliasProposals, deterministicAliasId } from '../src/alias-apply.js';
import { mineAliasProposals } from '../src/alias-mining.js';
import { mergeAliasProposals } from '../src/alias-proposals.js';
import { resolveConfig } from '../src/config.js';
import { readJson } from '../src/storage/files.js';
import { appendEvent, rebuildState } from '../src/storage/event-log.js';
import { memFact } from '../src/tools/mem_fact.js';
import { memNote } from '../src/tools/mem_note.js';

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-alias-proposal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return resolveConfig({
    workspace: directory,
    root: path.join(directory, '.dsh-mem'),
    globalRoot: path.join(directory, 'global-memory'),
  });
}

function proposals(config) {
  return readJson(path.join(config.localRoot, 'alias-proposals.json'), []);
}

function proposal(phrase, targetId, extra = {}) {
  return {
    phrase,
    target: { id: targetId },
    signal: 'write',
    quote: `主人说${phrase}就是目标。`,
    sess: 'proposal-test',
    proposedAt: '2026-11-04T08:00:00.000Z',
    decision: null,
    ...extra,
  };
}

test('写入侧四条校验各拒绝一例，正文仍正常写入', async (t) => {
  const config = workspace(t);
  for (let index = 0; index < 11; index += 1) {
    await appendEvent(config, {
      kind: 'note',
      text: index < 2 ? `高频词背景记录 ${index}` : `普通背景记录 ${index}`,
      sess: 'seed',
    });
  }

  const first = await memNote(config, {
    kind: 'note',
    text: '目标正文包含正文俗称，但不含其它候选。',
    aliases: ['引用缺失', '这个插件', '正文俗称'],
    aliasQuote: '主人说这个插件和正文俗称。',
  }, { sessionId: 'reject-1' });
  const second = await memFact(config, {
    key: '提案.高频测试',
    text: '目标事实正文。',
    aliases: ['高频词组'],
    aliasQuote: '主人把它叫高频词组。',
  }, { sessionId: 'reject-2' });

  assert.equal(first.status, 'written');
  assert.equal(second.status, 'written');
  assert.equal(first.warnings.filter((warning) => warning.includes('已丢弃')).length, 3);
  assert.equal(second.warnings.filter((warning) => warning.includes('已丢弃')).length, 1);
  assert.deepEqual(proposals(config), []);
  const state = await rebuildState(config.localRoot, { ...config, recordRebuild: false });
  assert.ok(state.byId[first.id]);
  assert.ok(state.byId[second.id]);
});

test('每会话最多三条 write 提案，第四条只告警', async (t) => {
  const config = workspace(t);
  const phrases = ['养鱼组件', '海豚组件', '鲸鱼组件', '水草组件'];
  const results = [];
  for (const [index, phrase] of phrases.entries()) {
    results.push(await memNote(config, {
      kind: 'note',
      text: `互不重复的目标正文 ${index}。`,
      aliases: [phrase],
      aliasQuote: `主人说${phrase}就是这个目标。`,
    }, { sessionId: 'same-session' }));
  }

  assert.equal(proposals(config).length, 3);
  assert.equal(results[3].warnings.some((warning) => /已达 3 条/u.test(warning)), true);
});

test('并发合并键相同提案时保留人工 decision', async (t) => {
  const config = workspace(t);
  const decided = proposal('养鱼组件', 'm_target_0001', { decision: 'event' });
  await mergeAliasProposals(config.localRoot, [decided], config);
  await mergeAliasProposals(config.localRoot, [
    proposal('养鱼组件', 'm_target_0001', {
      quote: '后来的自动提案不应覆盖决定。',
      decision: null,
    }),
  ], config);

  assert.equal(proposals(config)[0].decision, 'event');
  assert.equal(proposals(config)[0].quote, '后来的自动提案不应覆盖决定。');
});

test('apply 幂等、跟随 replaces、retract 作废并对 quote 脱敏', async (t) => {
  const config = workspace(t);
  const old = await appendEvent(config, {
    kind: 'note',
    text: '旧目标条目。',
    sess: 'apply-seed',
  });
  const latest = await appendEvent(config, {
    kind: 'note',
    text: '最新目标条目。',
    replaces: [old.id],
    sess: 'apply-seed',
  });
  const doomed = await appendEvent(config, {
    kind: 'note',
    text: '即将撤回的目标。',
    sess: 'apply-seed',
  });
  await appendEvent(config, {
    kind: 'retract',
    text: '目标已作废。',
    refs: [doomed.id],
    sess: 'apply-seed',
  });
  fs.writeFileSync(
    path.join(config.localRoot, 'alias-proposals.json'),
    `${JSON.stringify([
      proposal('养鱼组件', old.id, {
        decision: 'event',
        quote: '密钥 ABCDEFGHIJKLMNOPQRSTUVWX 对应养鱼组件。',
      }),
      proposal('作废俗称', doomed.id, { decision: 'event' }),
    ], null, 2)}\n`,
  );

  const first = await applyAliasProposals(config.localRoot, { config });
  const second = await applyAliasProposals(config.localRoot, { config });
  const state = await rebuildState(config.localRoot, { ...config, recordRebuild: false });
  const eventId = deterministicAliasId(latest.id, '养鱼组件');
  const applied = state.byId[eventId];

  assert.deepEqual(first, { events: 1, table: 0, rejected: 0, voided: 1 });
  assert.deepEqual(second, { events: 0, table: 0, rejected: 0, voided: 0 });
  assert.deepEqual(applied.refs, [latest.id]);
  assert.match(applied.quote, /\[redacted\]/u);
  assert.equal(applied.quote.includes('ABCDEFGHIJKLMNOPQRSTUVWX'), false);
  assert.equal(Object.values(state.byId).filter((event) => event.id === eventId).length, 1);
  const voided = proposals(config).find(({ phrase }) => phrase === '作废俗称');
  assert.equal(voided.result, 'void:target_retracted');
  assert.equal(state.aliases[doomed.id], undefined);
});

// 新回执落盘时候选只剩 id/score/why/base：picked 看回执顶层，kind 由挖掘器按 state 反查。
function compactCandidates(receipt) {
  return {
    ...receipt,
    candidateCount: receipt.candidates.length,
    candidates: receipt.candidates.map(({ id, score, why, base }) => ({
      id,
      score,
      ...(why !== undefined ? { why } : {}),
      base,
    })),
  };
}

test('挖掘器识别 R/E/S/W，并跳过 rule 通道', async (t) => {
  await assertMinesAllSignals(t, (receipt) => receipt);
});

test('挖掘器在裁短的新回执（无 kind/picked）上同样识别 R/E/S/W', async (t) => {
  await assertMinesAllSignals(t, compactCandidates);
});

async function assertMinesAllSignals(t, shape) {
  const config = workspace(t);
  const targetR = await appendEvent(config, { kind: 'note', text: '甲目标信息。', sess: 'mine' });
  const targetE = await appendEvent(config, { kind: 'note', text: '乙目标信息。', sess: 'mine' });
  const targetS = await appendEvent(config, { kind: 'note', text: '丙目标信息。', sess: 'mine' });
  const targetW = await appendEvent(config, { kind: 'note', text: '丁目标信息。', sess: 'mine' });
  await appendEvent(config, {
    kind: 'retract',
    text: '丙目标已撤回。',
    refs: [targetS.id],
    sess: 'mine',
  });
  const base = Date.parse('2026-11-04T08:00:00.000Z');
  const receipts = [
    {
      ts: new Date(base).toISOString(), channel: 'recall', sess: 'r',
      query: '珊瑚暗号', picked: [],
      candidates: [{ id: targetR.id, score: 0, base: 0, kind: 0.9, picked: false, why: 'no_match' }],
    },
    {
      ts: new Date(base + 60_000).toISOString(), channel: 'recall', sess: 'e',
      query: '海豚暗号', picked: [],
      candidates: [{ id: targetE.id, score: 0, base: 0, kind: 0.9, picked: false, why: 'no_match' }],
    },
    {
      ts: new Date(base + 120_000).toISOString(), channel: 'recall', sess: 's',
      query: '鲸鱼暗号', picked: [],
      candidates: [{ id: targetS.id, score: 2, base: 20, kind: 0.9, picked: false, why: 'status_penalty' }],
    },
    {
      ts: new Date(base + 180_000).toISOString(), channel: 'recall', sess: 'w',
      query: '水草暗号', picked: [targetW.id],
      candidates: [{ id: targetW.id, score: 2, base: 2, kind: 0.9, picked: true }],
    },
    {
      ts: new Date(base + 240_000).toISOString(), channel: 'recall', sess: 'r',
      query: '甲目标信息', picked: [targetR.id],
      candidates: [{ id: targetR.id, score: 8, base: 4, kind: 0.9, picked: true }],
    },
    {
      ts: new Date(base + 300_000).toISOString(), channel: 'rule', sess: 'rule',
      query: '规则暗号', picked: [],
      candidates: [{ id: targetE.id, score: 0, base: 0, kind: 1, picked: false, why: 'no_match' }],
    },
  ];
  fs.writeFileSync(
    path.join(config.localRoot, 'recall-log.jsonl'),
    `${receipts.map((receipt) => JSON.stringify(shape(receipt))).join('\n')}\n`,
  );

  const result = await mineAliasProposals(config.localRoot);
  assert.deepEqual(
    result.proposals.map(({ phrase, signal }) => [phrase, signal]).sort(),
    [['海豚暗号', 'E'], ['珊瑚暗号', 'R'], ['水草暗号', 'W'], ['鲸鱼暗号', 'S']].sort(),
  );
  assert.equal(result.proposals.some(({ phrase }) => phrase === '规则暗号'), false);
}
