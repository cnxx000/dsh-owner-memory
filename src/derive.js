import crypto from 'node:crypto';
import { MemoryError } from './schema.js';

function calculatedSourceHash(events) {
  const bytes = events.map((event) => JSON.stringify(event)).join('\n');
  const content = bytes ? `${bytes}\n` : '';
  return {
    lines: events.length,
    lastId: events.at(-1)?.id ?? null,
    sha16: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16),
  };
}

function activeStatus() {
  return { status: 'active' };
}

function mark(status, id, value, field, by) {
  status[id] = { status: value, [field]: by };
}

function mergeAliases(stateAliases, id, values, detail = {}) {
  if (!Array.isArray(values) || values.length === 0) return;
  const current = stateAliases[id] ?? { aliases: [] };
  const seen = new Set(current.aliases);
  for (const alias of values) {
    if (!seen.has(alias)) {
      current.aliases.push(alias);
      seen.add(alias);
    }
  }
  if (detail.quote !== undefined) current.quote = detail.quote;
  if (detail.proposal !== undefined) current.proposal = structuredClone(detail.proposal);
  stateAliases[id] = current;
}

export function deriveState(events, opts = {}) {
  const byId = {};
  const byKey = {};
  const status = {};
  const aliases = {};
  const directSymptoms = {};
  const directAsks = {};
  const symptomParents = {};
  const confirmCount = {};
  const lastSeenAt = {};
  const factsByKey = new Map();
  const migratedIds = [];

  for (const sourceEvent of events) {
    const event = structuredClone(sourceEvent);
    if (!event?.id || byId[event.id]) {
      throw new MemoryError('E_SCHEMA', `事件 id 缺失或重复：${event?.id ?? '(空)'}`);
    }

    if (['revise', 'retract', 'close', 'supersede', 'alias', 'confirm', 'symptom'].includes(event.kind)) {
      if (!Array.isArray(event.refs) || event.refs.length === 0) {
        throw new MemoryError('E_SCHEMA', `${event.kind} 必须带 refs`);
      }
      const missing = event.refs.filter((id) => !byId[id]);
      if (missing.length) {
        throw new MemoryError('E_REF_NOT_FOUND', `找不到引用：${missing.join(', ')}`, { missing });
      }
    }
    if (event.replaces !== undefined) {
      const missing = event.replaces.filter((id) => !byId[id]);
      if (missing.length) {
        throw new MemoryError('E_REF_NOT_FOUND', `找不到被取代条目：${missing.join(', ')}`, { missing });
      }
    }

    byId[event.id] = event;
    status[event.id] = activeStatus();
    if (event.src === 'migrate:loli') migratedIds.push(event.id);
    if (['fact', 'note'].includes(event.kind)) {
      mergeAliases(aliases, event.id, event.aliases);
    }

    if (event.kind === 'alias') {
      mergeAliases(aliases, event.refs[0], event.aliases, {
        quote: event.quote,
        proposal: event.proposal,
      });
      continue;
    }

    if (event.kind === 'confirm') {
      const targetId = event.refs[0];
      confirmCount[targetId] = (confirmCount[targetId] ?? 0) + 1;
      lastSeenAt[targetId] = event.ts;
      continue;
    }

    if (event.kind === 'symptom') {
      const targetId = event.refs[0];
      const target = byId[targetId];
      if (target.kind !== 'note' || !(target.tags ?? []).includes('坑')) {
        throw new MemoryError('E_SYMPTOM_KIND', `symptom 只能指向带“坑”tag 的 note：${targetId}`);
      }
      for (const [field, direct] of [
        ['symptoms', directSymptoms],
        ['asks', directAsks],
      ]) {
        const values = direct[targetId] ?? [];
        const seen = new Set(values);
        for (const value of event[field] ?? []) {
          if (!seen.has(value)) {
            values.push(value);
            seen.add(value);
          }
        }
        if (values.length > 0) direct[targetId] = values;
      }
      continue;
    }

    if (event.kind === 'fact') {
      const history = factsByKey.get(event.key) ?? [];
      const previous = byKey[event.key];
      if (previous && status[previous]?.status === 'active') {
        confirmCount[event.key] = (confirmCount[event.key] ?? 0) + 1;
        lastSeenAt[event.key] = event.ts;
        mark(status, previous, 'superseded', 'supersededBy', event.id);
      }
      history.push(event.id);
      factsByKey.set(event.key, history);
      byKey[event.key] = event.id;
      continue;
    }

    if (event.kind === 'supersede') {
      const [oldId, newId] = event.refs;
      const prevStatus = structuredClone(status[oldId] ?? activeStatus());
      status[oldId] = {
        status: 'superseded',
        supersededBy: newId,
        prevStatus,
      };
      continue;
    }

    for (const replacedId of event.replaces ?? []) {
      const prevStatus = structuredClone(status[replacedId] ?? activeStatus());
      status[replacedId] = {
        status: 'superseded',
        supersededBy: event.id,
        prevStatus,
      };
      mergeAliases(aliases, event.id, aliases[replacedId]?.aliases);
      const parents = symptomParents[event.id] ?? [];
      if (!parents.includes(replacedId)) parents.push(replacedId);
      symptomParents[event.id] = parents;
    }

    if (!['revise', 'retract', 'close'].includes(event.kind)) continue;
    const targetStatus = {
      revise: ['revised', 'revisedBy'],
      retract: ['retracted', 'retractedBy'],
      close: ['closed', 'closedBy'],
    }[event.kind];

    const inheritedKey = event.kind === 'revise'
      && event.refs.length === 1
      && event.key !== undefined
      && byId[event.refs[0]]?.key === event.key
      && byKey[event.key] === event.refs[0];

    for (const ref of event.refs) {
      mark(status, ref, targetStatus[0], targetStatus[1], event.id);
    }
    if (event.kind === 'revise') symptomParents[event.id] = [...event.refs];

    if (inheritedKey) {
      mergeAliases(aliases, event.id, aliases[event.refs[0]]?.aliases);
      const history = factsByKey.get(event.key) ?? [];
      history.push(event.id);
      factsByKey.set(event.key, history);
      byKey[event.key] = event.id;
      continue;
    }

    for (const ref of event.refs) {
      // 带 key 的 revise 表示它曾试图继承当前事实；并发下目标已过期时只能留下修订关系，
      // 不能把后来写入的当前值回退掉。
      if (event.kind === 'revise' && event.key !== undefined) continue;
      const target = byId[ref];
      if (target.key === undefined || byKey[target.key] !== ref) continue;

      const history = factsByKey.get(target.key) ?? [];
      const targetIndex = history.lastIndexOf(ref);
      let restored;
      for (let index = targetIndex - 1; index >= 0; index -= 1) {
        const candidate = history[index];
        if (!['retracted', 'revised', 'closed'].includes(status[candidate]?.status)) {
          restored = candidate;
          break;
        }
      }
      if (restored) {
        status[restored] = activeStatus();
        byKey[target.key] = restored;
      } else {
        delete byKey[target.key];
      }
    }

    if (event.kind === 'retract') {
      for (const ref of event.refs) {
        const replacedIds = new Set(byId[ref]?.replaces ?? []);
        for (const relation of Object.values(byId)) {
          if (relation.kind === 'supersede' && relation.refs?.[1] === ref && relation.refs[0]) {
            replacedIds.add(relation.refs[0]);
          }
        }
        for (const replacedId of replacedIds) {
          const current = status[replacedId];
          if (current?.status !== 'superseded' || current.supersededBy !== ref) continue;
          status[replacedId] = structuredClone(current.prevStatus ?? activeStatus());
        }
      }
    }
  }

  const resolveInherited = (direct) => {
    const resolved = {};
    const resolving = new Set();
    const resolve = (id) => {
      if (resolved[id]) return resolved[id];
      if (resolving.has(id)) return [];
      resolving.add(id);
      const values = [];
      const seen = new Set();
      for (const parentId of symptomParents[id] ?? []) {
        for (const value of resolve(parentId)) {
          if (!seen.has(value)) {
            values.push(value);
            seen.add(value);
          }
        }
      }
      for (const value of direct[id] ?? []) {
        if (!seen.has(value)) {
          values.push(value);
          seen.add(value);
        }
      }
      resolving.delete(id);
      resolved[id] = values;
      return values;
    };
    for (const id of Object.keys(byId)) {
      if (['alias', 'confirm', 'symptom'].includes(byId[id].kind)) continue;
      if (status[id]?.status === 'retracted') continue;
      if (resolve(id).length === 0) delete resolved[id];
    }
    return resolved;
  };
  const symptoms = resolveInherited(directSymptoms);
  const asks = resolveInherited(directAsks);

  return {
    byId,
    byKey,
    status,
    aliases,
    symptoms,
    asks,
    confirmCount,
    lastSeenAt,
    ...(migratedIds.length > 0 ? { migratedIds: migratedIds.sort() } : {}),
    sourceHash: structuredClone(opts.sourceHash ?? calculatedSourceHash(events)),
  };
}
