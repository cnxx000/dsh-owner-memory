import crypto from 'node:crypto';
import { buildIndex } from './indexer.js';
import { pinnedIds } from './l0.js';
import { appendReceipt } from './recall-log.js';
import { baseScore, scoreEvent } from './score.js';
import { tokensOf } from './tokenize.js';

export const RECALL_WHY = Object.freeze({
  BELOW_THRESHOLD: 'below_threshold',
  STATUS_PENALTY: 'status_penalty',
  OVER_LIMIT: 'over_limit',
  OVER_CHARS: 'over_chars',
  KINDS_FILTER: 'kinds_filter',
  SINCE_FILTER: 'since_filter',
  NO_MATCH: 'no_match',
  RULE_SEAT_DISPLACED: 'rule_seat_displaced',
});

function lexical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergeStates(local, global) {
  return {
    byId: { ...(global.byId ?? {}), ...(local.byId ?? {}) },
    byKey: { ...(global.byKey ?? {}), ...(local.byKey ?? {}) },
    status: { ...(global.status ?? {}), ...(local.status ?? {}) },
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
    kind: event.kind,
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
    event.kind === 'rule' && state.status?.[event.id]?.status === 'active'
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
    threshold = true,
    allowEmptyQuery = false,
  } = options;
  const pickedIds = new Set(items.map((item) => item.id));
  const rank = new Map(rankedCandidates.map((candidate, position) => [candidate.event.id, position]));
  const candidates = Object.values(state.byId ?? {})
    .sort((left, right) => lexical(left.id, right.id))
    .map((event) => {
      const parts = scoreEvent(state, index, event, query, { now, includeSuperseded });
      const picked = pickedIds.has(event.id);
      if (picked) return receiptCandidate(event, parts, true);

      const status = state.status?.[event.id]?.status ?? 'active';
      let why;
      if (kinds && !kinds.includes(event.kind)) why = RECALL_WHY.KINDS_FILTER;
      else if (since && Date.parse(event.ts) < Date.parse(since)) why = RECALL_WHY.SINCE_FILTER;
      else if (status !== 'active') why = RECALL_WHY.STATUS_PENALTY;
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
  let candidates = activeRuleCandidates(state).map((event) => ({
    event,
    parts: scoreEvent(state, index, event, query, { now }),
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
    threshold: false,
    allowEmptyQuery: query.length === 0,
  }));
  return result;
}

export function recall(state, index, query, opts = {}) {
  const localState = state;
  if (opts.global?.state) {
    state = mergeStates(localState, opts.global.state);
    // df 必须基于两个根的并集重算；直接拼两个 df 会把碰巧同 id 的 posting 重复计数。
    index = buildIndex(state);
  }
  if (Array.isArray(opts.kinds) && opts.kinds.length === 1 && opts.kinds[0] === 'rule') {
    return recallRules(state, index, { ...opts, query });
  }

  const limit = Math.min(6, Math.max(0, opts.limit ?? 4));
  const maxChars = Math.min(800, Math.max(0, opts.maxChars ?? 800));
  const includeSuperseded = opts.includeSuperseded === true;
  const now = opts.now ?? Date.now();
  const ids = new Set();
  for (const gram of new Set(tokensOf(query))) {
    for (const id of index.postings?.[gram] ?? []) ids.add(id);
  }

  const candidates = [];
  for (const id of [...ids].sort(lexical)) {
    const event = state.byId?.[id];
    if (!event) continue;
    const status = state.status?.[id]?.status ?? 'active';
    if (status !== 'active' && !includeSuperseded) continue;
    if (status === 'retracted') continue;
    if (opts.kinds && !opts.kinds.includes(event.kind)) continue;
    if (opts.since && Date.parse(event.ts) < Date.parse(opts.since)) continue;
    const parts = scoreEvent(state, index, event, query, { now, includeSuperseded });
    if (parts.score < 1.0) continue;
    candidates.push({ event, parts });
  }
  candidates.sort(ranked);

  const natural = candidates.slice(0, limit);
  let displacedId;
  const prefixes = new Map();
  if (!opts.kinds && limit > 0) {
    // L0 是工作区级通道；global 只参与按需召回，不能冒充已经常驻。
    const residentIds = pinnedIds(localState, { now: new Date(now), health: {} });
    const naturalIds = new Set(natural.map((candidate) => candidate.event.id));
    const seat = activeRuleCandidates(state)
      .filter((event) => !naturalIds.has(event.id) && !residentIds.has(event.id))
      .map((event) => ({
        event,
        parts: scoreEvent(state, index, event, query, { now }),
        base: baseScore(event, query, index).base,
      }))
      .filter((candidate) => candidate.base >= 1.0)
      .sort(ranked)[0];
    if (seat) {
      if (natural.length >= limit) {
        displacedId = natural[natural.length - 1].event.id;
        natural[natural.length - 1] = seat;
      }
      else natural.push(seat);
      prefixes.set(seat.event.id, '[红线] ');
    }
  }

  const protectedId = [...prefixes.keys()][0];
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
  }));
  return result;
}
