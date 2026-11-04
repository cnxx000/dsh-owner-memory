import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildIndex } from './indexer.js';
import { pinnedIds } from './l0.js';
import { appendReceipt } from './recall-log.js';
import { MemoryError, viewKind } from './schema.js';
import { baseScore, scoreEvent } from './score.js';
import { normalizeForSearch, tokensOf } from './tokenize.js';

const EMPTY_ALIASES = Object.freeze({ version: 1, entries: Object.freeze([]) });
const ALIAS_WEIGHT = 0.8;

export const RECALL_WHY = Object.freeze({
  BELOW_THRESHOLD: 'below_threshold',
  STATUS_PENALTY: 'status_penalty',
  OVER_LIMIT: 'over_limit',
  OVER_CHARS: 'over_chars',
  KINDS_FILTER: 'kinds_filter',
  SINCE_FILTER: 'since_filter',
  NO_MATCH: 'no_match',
  RULE_SEAT_DISPLACED: 'rule_seat_displaced',
  VEC_QUOTA: 'vec_quota',
});

function lexical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecallCandidate(event) {
  return !['confirm', 'symptom'].includes(event?.kind);
}

function aliasFailure(message, detail = {}) {
  throw new MemoryError('E_ALIAS_SCHEMA', message, detail);
}

export function validateAliasTable(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    aliasFailure('aliases.json 顶层必须是对象');
  }
  if (value.version !== 1) aliasFailure('aliases.json version 必须为 1');
  if (!Array.isArray(value.entries)) aliasFailure('aliases.json entries 必须是数组');

  const entries = value.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      aliasFailure(`aliases.json entries[${index}] 必须是对象`, { index });
    }
    const phrase = normalizeForSearch(entry.phrase);
    const hanCount = [...phrase].filter((character) => /\p{Script=Han}/u.test(character)).length;
    if (hanCount < 2) {
      throw new MemoryError(
        'E_ALIAS_PHRASE',
        `别名短语至少包含 2 个汉字：${entry.phrase ?? '(空)'}`,
        { index, phrase: entry.phrase },
      );
    }
    if (!Array.isArray(entry.terms) || entry.terms.length === 0
      || entry.terms.some((term) => typeof term !== 'string' || !normalizeForSearch(term))) {
      aliasFailure(`aliases.json entries[${index}].terms 必须是非空字符串数组`, { index });
    }
    return Object.freeze({
      phrase,
      terms: Object.freeze(entry.terms.map((term) => normalizeForSearch(term))),
    });
  });
  return Object.freeze({ version: 1, entries: Object.freeze(entries) });
}

export function loadAliasTable(file, opts = {}) {
  try {
    return validateAliasTable(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return EMPTY_ALIASES;
    if (error?.code === 'E_ALIAS_PHRASE') throw error;
    opts.probe?.('alias_parse_failed', `path=${file} err=${error?.message ?? error}`);
    return EMPTY_ALIASES;
  }
}

function aliasTokenWeights(query, aliases) {
  if (aliases === undefined || aliases === null) return new Map();
  const table = validateAliasTable(aliases);
  const normalizedQuery = normalizeForSearch(query);
  const originalTokens = new Set(tokensOf(query));
  const weights = new Map();
  for (const entry of table.entries) {
    if (!normalizedQuery.includes(entry.phrase)) continue;
    for (const term of entry.terms) {
      for (const token of tokensOf(term)) {
        if (!originalTokens.has(token)) weights.set(token, ALIAS_WEIGHT);
      }
    }
  }
  return weights;
}

function aliasBase(event, index, weights) {
  if (weights.size === 0) return { base: 0, hits: [] };
  const eventTokens = new Set(tokensOf([
    event.text ?? '',
    event.key ?? '',
    ...(event.tags ?? []),
  ].join(' ')));
  let base = 0;
  const hits = [];
  for (const [gram, weight] of weights) {
    if (!eventTokens.has(gram)) continue;
    const length = [...gram].length;
    base += weight * (length ** 1.5 / (1 + Math.log(1 + (index.df?.[gram] ?? 0))));
    hits.push(gram);
  }
  return { base, hits };
}

export function vectorAdjustedBase(baseLex, cosine, {
  floor = 0,
  beta = 0.5,
  queryBase = 3,
} = {}) {
  const denominator = 1 - floor;
  const s = Number.isFinite(cosine) && denominator > 0
    ? Math.max(0, Math.min(1, (cosine - floor) / denominator))
    : 0;
  const boost = beta * s * Math.max(0, queryBase - baseLex);
  return { base: baseLex + boost, s };
}

function scoreWithAliases(state, index, event, query, weights, opts = {}) {
  let parts = scoreEvent(state, index, event, query, opts);
  const extra = aliasBase(event, index, weights);
  if (extra.base !== 0) {
    parts = {
      ...parts,
      score: parts.score + extra.base * parts.kind * parts.imp * parts.decay * parts.penalty,
      base: parts.base + extra.base,
      hits: [...parts.hits, ...extra.hits],
    };
  }
  if (!opts.vec) return parts;

  const cosine = opts.vec.cosById?.[event.id];
  const floor = Number.isFinite(opts.vec.floor) ? opts.vec.floor : 0;
  const beta = Number.isFinite(opts.vec.beta) ? opts.vec.beta : 0.5;
  const baseLex = parts.base;
  const adjusted = vectorAdjustedBase(baseLex, cosine, {
    floor,
    beta,
    queryBase: opts.queryBase ?? 3,
  });
  const boost = adjusted.base - baseLex;
  return {
    ...parts,
    score: parts.score + boost * parts.kind * parts.imp * parts.decay * parts.penalty,
    base: baseLex + boost,
    baseLex,
    cos: Number.isFinite(cosine) ? cosine : null,
    s: adjusted.s,
    vecOnly: opts.lexicalIds ? !opts.lexicalIds.has(event.id) : baseLex === 0,
  };
}

function mergeStates(local, global) {
  return {
    byId: { ...(global.byId ?? {}), ...(local.byId ?? {}) },
    byKey: { ...(global.byKey ?? {}), ...(local.byKey ?? {}) },
    status: { ...(global.status ?? {}), ...(local.status ?? {}) },
    aliases: { ...(global.aliases ?? {}), ...(local.aliases ?? {}) },
    symptoms: { ...(global.symptoms ?? {}), ...(local.symptoms ?? {}) },
    asks: { ...(global.asks ?? {}), ...(local.asks ?? {}) },
    solid: { ...(global.solid ?? {}), ...(local.solid ?? {}) },
    confirmCount: { ...(global.confirmCount ?? {}), ...(local.confirmCount ?? {}) },
  };
}

function ranked(left, right) {
  return right.parts.score - left.parts.score
    || Date.parse(right.event.ts) - Date.parse(left.event.ts)
    || lexical(left.event.id, right.event.id);
}

function receiptId(query, opts, ids) {
  const input = JSON.stringify({ query: query ?? '', opts, ids });
  return `r_${crypto.createHash('sha1').update(input).digest('hex').slice(0, 10)}`;
}

function truncateText(text, maxChars = 200) {
  const value = String(text);
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function replacementPrefix(state, id) {
  const status = state.status?.[id] ?? {};
  const by = status.supersededBy ?? status.revisedBy ?? status.closedBy ?? status.retractedBy;
  return by ? `[已被 ${by} 取代] ` : '';
}

function toItem(state, candidate, prefix = '') {
  const event = candidate.event;
  const status = state.status?.[event.id]?.status ?? 'active';
  const item = {
    id: event.id,
    ts: event.ts,
    kind: viewKind(event),
    text: truncateText(`${prefix}${status === 'active' ? '' : replacementPrefix(state, event.id)}${event.text}`),
  };
  if (event.key !== undefined) item.key = event.key;
  if (status !== 'active') item.status = status;
  return item;
}

function packItems(state, candidates, {
  limit,
  maxChars,
  prefixes = new Map(),
  protectedId,
}) {
  if (protectedId !== undefined) {
    const entries = candidates.slice(0, limit).map((candidate) => ({
      candidate,
      item: toItem(state, candidate, prefixes.get(candidate.event.id) ?? ''),
    }));
    const protectedEntry = entries.find(({ candidate }) => candidate.event.id === protectedId);

    // 连席位自身都超过调用方预算时只能放弃席位；这是可返回的病态输入，不应拖垮召回。
    if (protectedEntry && protectedEntry.item.text.length <= maxChars) {
      let chars = entries.reduce((sum, entry) => sum + entry.item.text.length, 0);
      while (chars > maxChars) {
        const removableIndex = entries.findLastIndex(
          ({ candidate }) => candidate.event.id !== protectedId,
        );
        if (removableIndex < 0) break;
        chars -= entries[removableIndex].item.text.length;
        entries.splice(removableIndex, 1);
      }
      if (chars <= maxChars) return entries.map(({ item }) => item);
    }
  }

  const items = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (items.length >= limit) break;
    const item = toItem(state, candidate, prefixes.get(candidate.event.id) ?? '');
    if (chars + item.text.length > maxChars) continue;
    items.push(item);
    chars += item.text.length;
  }
  return items;
}

function activeRuleCandidates(state) {
  return Object.values(state.byId ?? {}).filter((event) => (
    viewKind(event) === 'rule' && state.status?.[event.id]?.status === 'active'
  ));
}

function receiptCandidate(event, parts, picked, why) {
  return {
    id: event.id,
    score: parts.score,
    base: parts.base,
    kind: parts.kind,
    imp: parts.imp,
    decay: parts.decay,
    penalty: parts.penalty,
    refs: parts.refs,
    ...(parts.aliasHit ? { aliasHit: true } : {}),
    ...(Object.hasOwn(parts, 'cos') ? {
      cos: parts.cos,
      s: parts.s,
      vecOnly: parts.vecOnly,
    } : {}),
    picked,
    ...(!picked ? { why } : {}),
  };
}

function buildReceipt(state, index, query, options) {
  const {
    receipt_id,
    now,
    items,
    rankedCandidates,
    limit,
    kinds,
    since,
    includeSuperseded,
    displacedId,
    aliasWeights = new Map(),
    vec,
    queryBase,
    lexicalIds,
    vecQuotaRejected = new Set(),
    threshold = true,
    allowEmptyQuery = false,
    channel = 'recall',
    sess,
    symptomsInRecall = false,
  } = options;
  const pickedIds = new Set(items.map((item) => item.id));
  const rank = new Map(rankedCandidates.map((candidate, position) => [candidate.event.id, position]));
  const candidates = Object.values(state.byId ?? {})
    .filter(isRecallCandidate)
    .sort((left, right) => lexical(left.id, right.id))
    .map((event) => {
      const parts = scoreWithAliases(
        state,
        index,
        event,
        query,
        aliasWeights,
        {
          now,
          includeSuperseded,
          vec,
          queryBase,
          lexicalIds,
          symptomsInRecall,
        },
      );
      const picked = pickedIds.has(event.id);
      if (picked) return receiptCandidate(event, parts, true);

      const status = state.status?.[event.id]?.status ?? 'active';
      let why;
      if (kinds && !kinds.includes(viewKind(event))) why = RECALL_WHY.KINDS_FILTER;
      else if (since && Date.parse(event.ts) < Date.parse(since)) why = RECALL_WHY.SINCE_FILTER;
      else if (status !== 'active') why = RECALL_WHY.STATUS_PENALTY;
      else if (vecQuotaRejected.has(event.id)) why = RECALL_WHY.VEC_QUOTA;
      else if (!allowEmptyQuery && parts.base === 0) why = RECALL_WHY.NO_MATCH;
      else if (threshold && parts.score < 1.0) why = RECALL_WHY.BELOW_THRESHOLD;
      else if (event.id === displacedId) why = RECALL_WHY.RULE_SEAT_DISPLACED;
      else if ((rank.get(event.id) ?? Number.POSITIVE_INFINITY) >= limit) why = RECALL_WHY.OVER_LIMIT;
      else why = RECALL_WHY.OVER_CHARS;
      const candidate = receiptCandidate(event, parts, false, why);
      if (why === RECALL_WHY.STATUS_PENALTY) {
        const detail = state.status?.[event.id] ?? {};
        candidate.status = detail.status;
        candidate.by = detail.supersededBy
          ?? detail.revisedBy
          ?? detail.retractedBy
          ?? detail.closedBy
          ?? null;
      }
      return candidate;
    });

  return {
    receipt_id,
    ts: new Date(now).toISOString(),
    channel,
    ...(sess ? { sess } : {}),
    query,
    grams: [...new Set(tokensOf(query))],
    picked: items.map((item) => item.id),
    chars: items.reduce((sum, item) => sum + item.text.length, 0),
    candidates,
  };
}

function logReceipt(root, receipt) {
  if (typeof root === 'string' && root) appendReceipt(root, receipt);
}

export function recallRules(state, index, opts = {}) {
  const query = opts.query ?? '';
  const limit = Math.min(12, Math.max(0, opts.limit ?? 12));
  const maxChars = Math.min(1200, Math.max(0, opts.maxChars ?? 1200));
  const now = opts.now ?? Date.now();
  const aliasWeights = aliasTokenWeights(query, opts.aliases);
  let candidates = activeRuleCandidates(state).map((event) => ({
    event,
    parts: scoreWithAliases(state, index, event, query, aliasWeights, {
      now,
      symptomsInRecall: opts.symptomsInRecall,
    }),
  }));

  if (query) {
    candidates.sort(ranked);
  } else {
    candidates.sort((left, right) => (
      (right.event.weight ?? 2) - (left.event.weight ?? 2)
      || Date.parse(right.event.ts) - Date.parse(left.event.ts)
      || lexical(left.event.id, right.event.id)
    ));
  }
  const items = packItems(state, candidates, { limit, maxChars });
  const result = {
    receipt_id: receiptId(query, { channel: 'rule', limit, maxChars }, items.map((item) => item.id)),
    items,
  };
  logReceipt(opts.log, buildReceipt(state, index, query, {
    receipt_id: result.receipt_id,
    now,
    items,
    rankedCandidates: candidates,
    limit,
    kinds: ['rule'],
    includeSuperseded: false,
    aliasWeights,
    threshold: false,
    allowEmptyQuery: query.length === 0,
    channel: 'rule',
    sess: opts.sess,
    symptomsInRecall: opts.symptomsInRecall,
  }));
  return result;
}

export function recall(state, index, query, opts = {}) {
  const localState = state;
  if (opts.global?.state) {
    state = mergeStates(localState, opts.global.state);
    // df 必须基于两个根的并集重算；直接拼两个 df 会把碰巧同 id 的 posting 重复计数。
    index = buildIndex(state, { symptomsInRecall: opts.symptomsInRecall });
  }
  if (Array.isArray(opts.kinds) && opts.kinds.length === 1 && opts.kinds[0] === 'rule') {
    return recallRules(state, index, { ...opts, query });
  }

  const limit = Math.min(6, Math.max(0, opts.limit ?? 4));
  const maxChars = Math.min(800, Math.max(0, opts.maxChars ?? 800));
  const includeSuperseded = opts.includeSuperseded === true;
  const now = opts.now ?? Date.now();
  const aliasWeights = aliasTokenWeights(query, opts.aliases);
  const lexicalIds = new Set();
  for (const gram of new Set([...tokensOf(query), ...aliasWeights.keys()])) {
    for (const id of index.postings?.[gram] ?? []) lexicalIds.add(id);
  }
  for (const [id, detail] of Object.entries(state.aliases ?? {})) {
    if ((detail.aliases ?? []).some((alias) => String(query).includes(alias))) lexicalIds.add(id);
  }

  const eligible = (event) => {
    if (!isRecallCandidate(event)) return false;
    const status = state.status?.[event.id]?.status ?? 'active';
    if (status !== 'active' && !includeSuperseded) return false;
    if (status === 'retracted') return false;
    if (opts.kinds && !opts.kinds.includes(viewKind(event))) return false;
    if (opts.since && Date.parse(event.ts) < Date.parse(opts.since)) return false;
    return true;
  };

  let queryBase = 3;
  let lexicalCandidateCount = 0;
  let residentIds;
  if (opts.vec) {
    residentIds = pinnedIds(localState, { now: new Date(now), health: {} });
    for (const id of [...lexicalIds].sort(lexical)) {
      const event = state.byId?.[id];
      if (!eligible(event)) continue;
      const lexicalParts = scoreWithAliases(
        state,
        index,
        event,
        query,
        aliasWeights,
        { now, includeSuperseded, symptomsInRecall: opts.symptomsInRecall },
      );
      queryBase = Math.max(queryBase, lexicalParts.base);
      if (lexicalParts.score >= 1.0) lexicalCandidateCount += 1;
    }
  }

  const ids = new Set(lexicalIds);
  if (opts.vec) {
    for (const id of Object.keys(opts.vec.cosById ?? {})) ids.add(id);
  }
  const candidates = [];
  for (const id of [...ids].sort(lexical)) {
    const event = state.byId?.[id];
    if (!eligible(event)) continue;
    const vecOnly = opts.vec && !lexicalIds.has(id);
    if (vecOnly && residentIds.has(id)) continue;
    const parts = scoreWithAliases(
      state,
      index,
      event,
      query,
      aliasWeights,
      {
        now,
        includeSuperseded,
        vec: opts.vec,
        queryBase,
        lexicalIds,
        symptomsInRecall: opts.symptomsInRecall,
      },
    );
    if (parts.score < 1.0) continue;
    candidates.push({ event, parts });
  }
  candidates.sort(ranked);

  const vecQuotaRejected = new Set();
  let natural;
  if (opts.vec) {
    const vecQuota = lexicalCandidateCount >= 2 ? 1 : 2;
    let vecPicked = 0;
    natural = [];
    for (const candidate of candidates) {
      if (candidate.parts.vecOnly && vecPicked >= vecQuota) {
        vecQuotaRejected.add(candidate.event.id);
        continue;
      }
      if (natural.length >= limit) continue;
      natural.push(candidate);
      if (candidate.parts.vecOnly) vecPicked += 1;
    }
  } else {
    natural = candidates.slice(0, limit);
  }
  let displacedId;
  const prefixes = new Map();
  if (opts.vec) {
    for (const candidate of natural) {
      if (candidate.parts.vecOnly) prefixes.set(candidate.event.id, '[相近] ');
    }
  }
  let protectedId;
  if (!opts.kinds && limit > 0) {
    // L0 是工作区级通道；global 只参与按需召回，不能冒充已经常驻。
    residentIds ??= pinnedIds(localState, { now: new Date(now), health: {} });
    const naturalIds = new Set(natural.map((candidate) => candidate.event.id));
    const seat = activeRuleCandidates(state)
      .filter((event) => !naturalIds.has(event.id) && !residentIds.has(event.id))
      .map((event) => ({
        event,
        parts: scoreWithAliases(state, index, event, query, aliasWeights, {
          now,
          symptomsInRecall: opts.symptomsInRecall,
        }),
        base: baseScore(event, query, index, state, {
          symptomsInRecall: opts.symptomsInRecall,
        }).base + aliasBase(event, index, aliasWeights).base,
      }))
      .filter((candidate) => candidate.base >= 1.0)
      .sort(ranked)[0];
    if (seat) {
      if (natural.length >= limit) {
        displacedId = natural[natural.length - 1].event.id;
        prefixes.delete(displacedId);
        natural[natural.length - 1] = seat;
      }
      else natural.push(seat);
      prefixes.set(seat.event.id, '[红线] ');
      protectedId = seat.event.id;
    }
  }

  const items = packItems(state, natural, {
    limit,
    maxChars,
    prefixes,
    protectedId,
  });
  const result = {
    receipt_id: receiptId(query, {
      limit,
      maxChars,
      kinds: opts.kinds ?? null,
      since: opts.since ?? null,
      includeSuperseded,
      ...(aliasWeights.size > 0 ? { aliases: [...aliasWeights.keys()] } : {}),
      ...(opts.vec ? { vector: true } : {}),
      ...(opts.symptomsInRecall === true ? { symptomsInRecall: true } : {}),
    }, items.map((item) => item.id)),
    items,
  };
  logReceipt(opts.log, buildReceipt(state, index, query, {
    receipt_id: result.receipt_id,
    now,
    items,
    rankedCandidates: candidates,
    limit,
    kinds: opts.kinds,
    since: opts.since,
    includeSuperseded,
    displacedId,
    aliasWeights,
    vec: opts.vec,
    queryBase,
    lexicalIds,
    vecQuotaRejected,
    channel: 'recall',
    sess: opts.sess,
    symptomsInRecall: opts.symptomsInRecall,
  }));
  return result;
}
