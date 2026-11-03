import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, rootForScope } from './config.js';
import { buildIndex } from './indexer.js';
import { readReceipts } from './recall-log.js';
import { MemoryError } from './schema.js';
import { scoreEvent } from './score.js';
import { readJson } from './storage/files.js';
import { rebuildState } from './storage/event-log.js';
import { suspectedShouldBeFact } from './write/smell.js';

const DAY_MS = 86_400_000;

function actualSourceHash(root) {
  const bytes = fs.readFileSync(path.join(root, 'events.jsonl'));
  const lines = bytes.toString('utf8').split(/\r?\n/u).filter(Boolean);
  let lastId = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      lastId = JSON.parse(lines[index]).id ?? null;
      break;
    } catch {
      // 坏行不应遮住最后一个可用事件 id。
    }
  }
  return {
    lines: lines.length,
    lastId,
    sha16: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    bytes: bytes.length,
  };
}

function sourceHashMatches(state, actual) {
  return ['lines', 'lastId', 'sha16'].every((field) => state.sourceHash?.[field] === actual[field]);
}

function statusEntry(state, event) {
  return { ...event, status: structuredClone(state.status?.[event.id] ?? { status: 'active' }) };
}

function contradictions(state) {
  const grouped = new Map();
  for (const event of Object.values(state.byId ?? {})) {
    if (event.kind !== 'fact' || state.status?.[event.id]?.status !== 'active') continue;
    const values = grouped.get(event.key) ?? [];
    values.push(event.id);
    grouped.set(event.key, values);
  }
  return [...grouped.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, ids]) => ({ key, ids: ids.sort() }));
}

function lastPickedById(receipts) {
  const picked = new Map();
  for (const receipt of receipts) {
    for (const id of receipt.picked ?? []) {
      const previous = picked.get(id);
      if (!previous || Date.parse(receipt.ts) > Date.parse(previous)) picked.set(id, receipt.ts);
    }
  }
  return picked;
}

function fadingEntries(state, receipts, now) {
  const index = buildIndex(state);
  const picked = lastPickedById(receipts);
  return Object.values(state.byId ?? {})
    .filter((event) => state.status?.[event.id]?.status === 'active')
    .map((event) => ({
      id: event.id,
      decay: scoreEvent(state, index, event, '', { now }).decay,
      lastPickedAt: picked.get(event.id) ?? null,
    }))
    .filter((item) => (
      item.decay < 0.25
      && (!item.lastPickedAt || now - Date.parse(item.lastPickedAt) > 90 * DAY_MS)
    ))
    .sort((left, right) => left.decay - right.decay || left.id.localeCompare(right.id))
    .slice(0, 10);
}

function almostSolid(state) {
  return Object.entries(state.byKey ?? {})
    .flatMap(([key, id]) => {
      const count = state.confirmCount?.[key] ?? state.confirmCount?.[id] ?? 0;
      return count === 2 ? [{ key, id, confirmCount: count }] : [];
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function replacedRecently(state, now) {
  return Object.values(state.byId ?? {})
    .flatMap((event) => {
      const status = state.status?.[event.id] ?? {};
      if (!['superseded', 'revised'].includes(status.status)) return [];
      if (now - Date.parse(event.ts) > 30 * DAY_MS) return [];
      const by = status.supersededBy ?? status.revisedBy ?? null;
      return [{ id: event.id, status: status.status, by }];
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function healthAudit(root, state, now) {
  const actual = actualSourceHash(root);
  const health = readJson(path.join(root, 'health.json'), {});
  const receipts = readReceipts(root, { limit: 200 });
  return {
    contradictions: contradictions(state),
    fading: fadingEntries(state, receipts, now),
    almost_solid: almostSolid(state),
    superseded: replacedRecently(state, now),
    suspected_should_be_fact: suspectedShouldBeFact(state),
    metrics: {
      corruptLines: health.corruptLines ?? 0,
      lock_stolen: health.lock_stolen ?? 0,
      rebuilt: health.rebuilt ?? 0,
      sourceHashMatches: sourceHashMatches(state, actual),
      eventLines: actual.lines,
      eventBytes: actual.bytes,
      linesUntilFold: Math.max(0, DEFAULTS.foldAtLines - actual.lines),
      bytesUntilFold: Math.max(0, DEFAULTS.foldAtBytes - actual.bytes),
      rules_overflow: Boolean(health.rules_overflow),
      rules_truncated_hard: Boolean(health.rules_truncated_hard),
      injection_missing: Boolean(health.injection_missing),
    },
  };
}

function keyAudit(state, key) {
  const ids = new Set(Object.values(state.byId ?? {})
    .filter((event) => event.kind === 'fact' && event.key === key)
    .map((event) => event.id));
  const items = Object.values(state.byId ?? {})
    .filter((event) => ids.has(event.id) || event.refs?.some((id) => ids.has(id)))
    .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id))
    .map((event) => statusEntry(state, event));
  return { key, items };
}

function idAudit(state, id) {
  if (!state.byId?.[id]) throw new MemoryError('E_REF_NOT_FOUND', `找不到记忆：${id}`);
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of Object.values(state.byId)) {
      if (!ids.has(event.id) && event.refs?.some((ref) => ids.has(ref))) {
        ids.add(event.id);
        changed = true;
      }
      if (ids.has(event.id)) {
        for (const ref of event.refs ?? []) {
          if (!ids.has(ref)) {
            ids.add(ref);
            changed = true;
          }
        }
      }
    }
  }
  return {
    id,
    items: [...ids]
      .flatMap((itemId) => state.byId[itemId] ? [statusEntry(state, state.byId[itemId])] : [])
      .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id)),
  };
}

export async function memAudit(config, args = {}) {
  const root = rootForScope(config, args.scope ?? DEFAULTS.defaultScope);
  const what = args.what;
  if (what === 'recall') {
    const receipts = readReceipts(root, { limit: 200 });
    const receipt = args.receipt_id
      ? receipts.find((item) => item.receipt_id === args.receipt_id)
      : receipts[0];
    if (!receipt) throw new MemoryError('E_REF_NOT_FOUND', '找不到召回回执');
    return receipt;
  }

  const state = await rebuildState(root, { ...config, recordRebuild: false });
  if (what === 'health') return healthAudit(root, state, new Date(args.now ?? Date.now()).getTime());
  if (what === 'key') {
    if (!args.key) throw new MemoryError('E_SCHEMA', 'mem_audit(what="key") 必须提供 key');
    return keyAudit(state, args.key);
  }
  if (what === 'id') {
    if (!args.id) throw new MemoryError('E_SCHEMA', 'mem_audit(what="id") 必须提供 id');
    return idAudit(state, args.id);
  }
  if (what === 'status') {
    const actual = actualSourceHash(root);
    return {
      enabled: !fs.existsSync(path.join(root, 'disabled')),
      root,
      sourceHashMatches: sourceHashMatches(state, actual),
      eventLines: actual.lines,
    };
  }
  throw new MemoryError('E_SCHEMA', 'mem_audit.what 必须是 recall/health/key/id/status');
}
