import path from 'node:path';
import { mergeAliasProposals } from './alias-proposals.js';
import { buildIndex } from './indexer.js';
import { loadAliasTable, recall } from './recall.js';
import { readReceipts } from './recall-log.js';
import { viewKind } from './schema.js';
import { KIND_WEIGHT } from './score.js';
import { readJson } from './storage/files.js';
import { normalizeForSearch } from './tokenize.js';

function highest(candidates, field = 'score') {
  return [...(candidates ?? [])].sort((left, right) => (
    (right[field] ?? Number.NEGATIVE_INFINITY) - (left[field] ?? Number.NEGATIVE_INFINITY)
    || String(left.id).localeCompare(String(right.id))
  ))[0];
}

// 落盘回执只留前几名候选的 id/score/why/base；入选看顶层 picked，kind 权重按 state 里的事件反查。
function wasPicked(receipt, candidate) {
  return (receipt.picked ?? []).includes(candidate.id);
}

function kindWeight(state, candidate) {
  if (candidate.kind !== undefined) return candidate.kind;
  const event = state.byId?.[candidate.id];
  return event ? KIND_WEIGHT[viewKind(event)] ?? 0 : 0;
}

function classifyFailure(receipt, state) {
  const candidates = receipt.candidates ?? [];
  const top = highest(candidates);
  if (top?.why === 'status_penalty') return { signal: 'S', targetId: top.id };
  if ((receipt.picked ?? []).length === 0) {
    const target = highest(candidates.filter((candidate) => kindWeight(state, candidate) > 0));
    return target ? { signal: 'E', targetId: target.id } : null;
  }
  const picked = candidates.filter((candidate) => wasPicked(receipt, candidate));
  const bestPicked = highest(picked, 'base');
  if (bestPicked && bestPicked.base < 3) return { signal: 'W', targetId: bestPicked.id };
  return null;
}

function rawBigrams(phrase) {
  const chars = [...phrase];
  return chars.slice(0, -1).map((character, index) => `${character}${chars[index + 1]}`);
}

export function minedPhrase(query, index) {
  const runs = [...String(query ?? '').matchAll(/\p{Script=Han}+/gu)]
    .map((match) => ({ phrase: match[0], offset: match.index }))
    .filter(({ phrase }) => [...phrase].length >= 3 && [...phrase].length <= 8)
    .filter(({ phrase }) => rawBigrams(phrase).every((gram) => !index.postings?.[gram]))
    .sort((left, right) => (
      [...right.phrase].length - [...left.phrase].length
      || left.offset - right.offset
    ));
  return runs[0]?.phrase ?? null;
}

function overlaps(left, right) {
  const a = normalizeForSearch(left);
  const b = normalizeForSearch(right);
  return a === b || a.includes(b) || b.includes(a);
}

function alreadyKnown(phrase, state, aliases, rejected) {
  if ((aliases.entries ?? []).some((entry) => overlaps(phrase, entry.phrase))) return true;
  if (Object.values(state.aliases ?? {}).some(
    (detail) => (detail.aliases ?? []).some((alias) => overlaps(phrase, alias)),
  )) return true;
  return rejected.some((entry) => overlaps(phrase, entry.phrase));
}

function resolvedTargetId(state, initialId) {
  let id = initialId;
  const seen = new Set();
  while (!seen.has(id)) {
    seen.add(id);
    const status = state.status?.[id];
    if (status?.status !== 'superseded' || !status.supersededBy) return id;
    id = status.supersededBy;
  }
  return id;
}

function replayHitsTarget(state, index, aliases, query, targetId, now) {
  const replay = recall(state, index, query, {
    aliases,
    now: Date.parse(now) || Date.now(),
    limit: 6,
  });
  const resolved = resolvedTargetId(state, targetId);
  return replay.items.some((item) => item.id === targetId || item.id === resolved);
}

function makeProposal(receipt, signal, targetId, phrase) {
  return {
    phrase,
    target: { id: targetId },
    signal,
    quote: receipt.query,
    sess: receipt.sess || 'recall-log',
    proposedAt: receipt.ts,
    decision: null,
  };
}

export async function mineAliasProposals(root, options = {}) {
  const state = readJson(path.join(root, 'state.json'), null);
  if (!state?.byId) return { proposals: [], skipped: 'missing_state' };
  const index = buildIndex(state);
  const aliases = loadAliasTable(options.aliasesPath ?? path.join(root, 'aliases.json'));
  const rejectedValue = readJson(path.join(root, 'alias-rejected.json'), []);
  const rejected = Array.isArray(rejectedValue) ? rejectedValue : [];
  const receipts = readReceipts(root)
    .filter((receipt) => String(receipt.query ?? '').trim() && receipt.channel !== 'rule')
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  const proposals = [];
  const proposedKeys = new Set();

  const consider = (receipt, signal, targetId) => {
    if (!state.byId[targetId]) return;
    const phrase = minedPhrase(receipt.query, index);
    if (!phrase || alreadyKnown(phrase, state, aliases, rejected)) return;
    const key = `${phrase}\u0000${targetId}`;
    if (proposedKeys.has(key)) return;
    if (replayHitsTarget(state, index, aliases, receipt.query, targetId, receipt.ts)) return;
    proposedKeys.add(key);
    proposals.push(makeProposal(receipt, signal, targetId, phrase));
  };

  for (let leftIndex = 0; leftIndex < receipts.length; leftIndex += 1) {
    const failed = receipts[leftIndex];
    const failure = classifyFailure(failed, state);
    if (!failure || !failed.sess) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < receipts.length; rightIndex += 1) {
      const hit = receipts[rightIndex];
      const delta = Date.parse(hit.ts) - Date.parse(failed.ts);
      if (delta > 10 * 60 * 1000) break;
      if (hit.sess !== failed.sess) continue;
      const matched = (hit.candidates ?? []).find((candidate) => (
        candidate.id === failure.targetId && wasPicked(hit, candidate) && candidate.base >= 3
      ));
      if (!matched) continue;
      consider(failed, 'R', failure.targetId);
      break;
    }
  }

  for (const receipt of receipts) {
    const failure = classifyFailure(receipt, state);
    if (failure) consider(receipt, failure.signal, failure.targetId);
  }

  const merged = proposals.length > 0
    ? await mergeAliasProposals(root, proposals, options)
    : { accepted: [], limited: [] };
  return { proposals, accepted: merged.accepted };
}
