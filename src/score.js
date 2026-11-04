import { recallSearchText } from './indexer.js';
import { viewKind } from './schema.js';
import { normalizeForSearch, tokensOf } from './tokenize.js';

const DAY_MS = 86_400_000;
const KIND_WEIGHT = Object.freeze({
  rule: 1.0,
  decision: 1.2,
  todo: 1.1,
  fact: 1.0,
  note: 0.9,
  revise: 0.8,
  retract: 0.0,
  close: 0.0,
});
const HALF_LIFE = Object.freeze({
  rule: Infinity,
  decision: 365,
  fact: 180,
  note: 90,
  todo: 30,
  revise: 90,
  retract: 1,
  close: 1,
});
const PENALTY = Object.freeze({
  active: 1.0,
  closed: 0.10,
  superseded: 0.02,
  revised: 0.02,
  retracted: 0.0,
});

function longestCommonRun(left, right) {
  if (!left || !right) return 0;
  const previous = new Uint16Array(right.length + 1);
  let best = 0;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Uint16Array(right.length + 1);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        current[rightIndex] = previous[rightIndex - 1] + 1;
        if (current[rightIndex] > best) best = current[rightIndex];
      }
    }
    previous.set(current);
  }
  return best;
}

function positiveReferenceCount(state, targetId) {
  let count = 0;
  for (const event of Object.values(state.byId ?? {})) {
    if (!['decision', 'note'].includes(viewKind(event))) continue;
    if (state.status?.[event.id]?.status !== 'active') continue;
    if (event.refs?.includes(targetId)) count += 1;
  }
  return count;
}

function aliasBonusFor(state, event, query) {
  const value = String(query ?? '');
  let longest = 0;
  for (const alias of state?.aliases?.[event.id]?.aliases ?? []) {
    if (value.includes(alias)) longest = Math.max(longest, [...alias].length);
  }
  return {
    aliasBonus: Math.min(8, 2 * longest),
    aliasHit: longest > 0,
  };
}

export function baseScore(event, query, index, state, opts = {}) {
  const queryTokens = [...new Set(tokensOf(query))];
  const searchText = recallSearchText(state, event, opts);
  const eventTokens = new Set(tokensOf(searchText));
  const hits = queryTokens.filter((gram) => eventTokens.has(gram));
  let tokenScore = 0;
  for (const gram of hits) {
    const length = [...gram].length;
    tokenScore += length ** 1.5 / (1 + Math.log(1 + (index.df?.[gram] ?? 0)));
  }

  const normalizedQuery = normalizeForSearch(query).replace(/\s+/gu, '');
  const normalizedEvent = normalizeForSearch(searchText).replace(/\s+/gu, '');
  const rawRun = longestCommonRun(normalizedQuery, normalizedEvent);
  const singleHanQuery = /^\p{Script=Han}$/u.test(normalizedQuery);
  const maxRunLen = rawRun >= 2 || singleHanQuery ? rawRun : 0;
  const keyHit = event.key
    ? event.key.split('.').some((part) => normalizeForSearch(part) === normalizeForSearch(query))
    : false;
  const tagHit = (event.tags ?? []).some((tag) => normalizedQuery.includes(normalizeForSearch(tag)));
  const { aliasBonus, aliasHit } = aliasBonusFor(state, event, query);
  const base = tokenScore + 2 * maxRunLen + (keyHit ? 3 : 0) + (tagHit ? 1.5 : 0)
    + aliasBonus;
  return { base, hits, maxRunLen, keyHit, tagHit, aliasBonus, aliasHit };
}

export function scoreEvent(state, index, event, query, opts = {}) {
  const baseParts = baseScore(event, query, index, state, opts);
  const effectiveKind = viewKind(event);
  const kind = KIND_WEIGHT[effectiveKind] ?? 0;
  const imp = 0.8 + 0.2 * (event.weight ?? 2);
  const ageDays = Math.max(0, ((opts.now ?? Date.now()) - Date.parse(event.ts)) / DAY_MS);
  let halfLife = HALF_LIFE[effectiveKind] ?? 90;
  if (event.solid === true || state.solid?.[event.id] === true) halfLife *= 3;
  const decay = halfLife === Infinity ? 1 : Math.max(0.15, 0.5 ** (ageDays / halfLife));
  const statusName = state.status?.[event.id]?.status ?? 'active';
  let penalty = PENALTY[statusName] ?? 1;
  if (opts.includeSuperseded && ['superseded', 'revised'].includes(statusName)) penalty = 0.5;
  const refs = 0.5 * Math.min(3, positiveReferenceCount(state, event.id));
  const score = baseParts.base * kind * imp * decay * penalty + refs;
  return {
    score,
    base: baseParts.base,
    kind,
    imp,
    decay,
    penalty,
    refs,
    hits: baseParts.hits,
    maxRunLen: baseParts.maxRunLen,
    aliasBonus: baseParts.aliasBonus,
    aliasHit: baseParts.aliasHit,
  };
}

export { HALF_LIFE, KIND_WEIGHT, PENALTY };
