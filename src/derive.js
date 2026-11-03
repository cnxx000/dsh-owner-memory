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

export function deriveState(events, opts = {}) {
  const byId = {};
  const byKey = {};
  const status = {};
  const factsByKey = new Map();
  const migratedIds = [];

  for (const sourceEvent of events) {
    const event = structuredClone(sourceEvent);
    if (!event?.id || byId[event.id]) {
      throw new MemoryError('E_SCHEMA', `事件 id 缺失或重复：${event?.id ?? '(空)'}`);
    }

    if (['revise', 'retract', 'close'].includes(event.kind)) {
      if (!Array.isArray(event.refs) || event.refs.length === 0) {
        throw new MemoryError('E_SCHEMA', `${event.kind} 必须带 refs`);
      }
      const missing = event.refs.filter((id) => !byId[id]);
      if (missing.length) {
        throw new MemoryError('E_REF_NOT_FOUND', `找不到引用：${missing.join(', ')}`, { missing });
      }
    }

    byId[event.id] = event;
    status[event.id] = activeStatus();
    if (event.src === 'migrate:loli') migratedIds.push(event.id);

    if (event.kind === 'fact') {
      const history = factsByKey.get(event.key) ?? [];
      const previous = byKey[event.key];
      if (previous && status[previous]?.status === 'active') {
        mark(status, previous, 'superseded', 'supersededBy', event.id);
      }
      history.push(event.id);
      factsByKey.set(event.key, history);
      byKey[event.key] = event.id;
      continue;
    }

    if (!['revise', 'retract', 'close'].includes(event.kind)) continue;
    const targetStatus = {
      revise: ['revised', 'revisedBy'],
      retract: ['retracted', 'retractedBy'],
      close: ['closed', 'closedBy'],
    }[event.kind];

    for (const ref of event.refs) {
      mark(status, ref, targetStatus[0], targetStatus[1], event.id);
      const target = byId[ref];
      if (target.kind !== 'fact' || byKey[target.key] !== ref) continue;

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
  }

  return {
    byId,
    byKey,
    status,
    ...(migratedIds.length > 0 ? { migratedIds: migratedIds.sort() } : {}),
    sourceHash: structuredClone(opts.sourceHash ?? calculatedSourceHash(events)),
  };
}
