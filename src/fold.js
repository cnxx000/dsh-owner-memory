import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, rootForScope } from './config.js';
import { deriveState } from './derive.js';
import { generateId, readArchiveEvents } from './storage/event-log.js';
import { atomicWrite, initRoot, readJson, updateHealth } from './storage/files.js';
import { withLock } from './storage/lock.js';
import { validateEvent } from './schema.js';

function timestampName(date) {
  return date.toISOString().replace(/[:.]/gu, '-');
}

function quarterName(date) {
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}.jsonl`;
}

function sourceHash(bytes) {
  const lines = bytes.toString('utf8').split(/\r?\n/u).filter(Boolean);
  return {
    lines: lines.length,
    lastId: lines.length ? JSON.parse(lines.at(-1)).id : null,
    sha16: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16),
  };
}

function parsedLines(bytes) {
  return bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line) => {
    const event = JSON.parse(line);
    validateEvent(event);
    return { line, event };
  });
}

function fsyncAppend(file, lines) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeFileSync(fd, `${lines.join('\n')}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export async function foldEvents(config, options = {}) {
  const root = rootForScope(config, 'local');
  const now = new Date(options.now ?? Date.now());
  const retentionMs = options.retentionMs ?? config.foldRetentionMs ?? DEFAULTS.foldRetentionMs;
  initRoot(root);
  let result = { folded: 0, snapshot: null, archive: null, foldEvent: null };

  await withLock(root, 'fold-events', () => {
    const eventFile = path.join(root, 'events.jsonl');
    const originalBytes = fs.readFileSync(eventFile);
    const original = parsedLines(originalBytes);
    const persistedState = readJson(path.join(root, 'state.json'), null);
    const beforeEvents = [
      ...readArchiveEvents(root).events,
      ...original.map(({ event }) => event),
    ].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id));
    const currentState = deriveState(beforeEvents);
    for (const field of ['confirmCount', 'lastSeenAt', 'carriedSessions']) {
      if (persistedState?.[field] !== undefined) currentState[field] = structuredClone(persistedState[field]);
    }
    const moved = original.filter(({ event }) => {
      const status = currentState.status?.[event.id]?.status ?? 'active';
      const oldEnough = now.getTime() - Date.parse(event.ts) > retentionMs;
      return ['superseded', 'revised', 'retracted', 'closed'].includes(status) && oldEnough;
    });
    if (moved.length === 0) return;

    const archiveRoot = path.join(root, 'archive');
    const snapshot = path.join(archiveRoot, `snapshot-${timestampName(now)}.jsonl`);
    const archiveName = quarterName(now);
    const archiveFile = path.join(archiveRoot, archiveName);
    const archiveExisted = fs.existsSync(archiveFile);
    const archiveBefore = archiveExisted ? fs.readFileSync(archiveFile) : null;
    atomicWrite(snapshot, originalBytes);

    try {
      fsyncAppend(archiveFile, moved.map(({ line }) => line));
      const movedIds = moved.map(({ event }) => event.id);
      const movedBytes = `${moved.map(({ line }) => line).join('\n')}\n`;
      const foldEvent = {
        id: generateId(now.getTime()),
        ts: now.toISOString(),
        kind: 'fold',
        text: `折叠 ${moved.length} 条事件至 archive/${archiveName}。`,
        weight: 2,
        scope: 'local',
        src: 'fold',
        sess: 'fold',
        foldedCount: moved.length,
        into: `archive/${archiveName}`,
        sha256: crypto.createHash('sha256').update(movedBytes).digest('hex'),
        idRange: [movedIds[0], movedIds.at(-1)],
      };
      validateEvent(foldEvent);

      // 严格保留“先追加 fold，再原子重写”这两个独立耐久步骤，崩溃时快照仍可恢复。
      fsyncAppend(eventFile, [JSON.stringify(foldEvent)]);
      const movedSet = new Set(movedIds);
      const kept = original.filter(({ event }) => !movedSet.has(event.id));
      const finalLines = [...kept.map(({ line }) => line), JSON.stringify(foldEvent)];
      const finalBytes = Buffer.from(`${finalLines.join('\n')}\n`);
      atomicWrite(eventFile, finalBytes);

      const finalEvents = parsedLines(finalBytes).map(({ event }) => event);
      const finalOriginalIds = new Set(finalEvents.filter((event) => event.kind !== 'fold').map((event) => event.id));
      const restoredIds = new Set([...finalOriginalIds, ...movedIds]);
      const originalIds = new Set(original.map(({ event }) => event.id));
      if (
        finalOriginalIds.size + movedIds.length !== original.length
        || restoredIds.size !== originalIds.size
        || [...originalIds].some((id) => !restoredIds.has(id))
      ) {
        throw new Error('折叠条目数或 id 并集校验失败');
      }

      const archived = readArchiveEvents(root).events;
      const complete = [...archived, ...finalEvents].sort((left, right) => (
        Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id)
      ));
      const meta = sourceHash(finalBytes);
      const nextState = deriveState(complete, { sourceHash: meta });
      for (const field of ['confirmCount', 'lastSeenAt', 'carriedSessions']) {
        if (currentState?.[field] !== undefined) nextState[field] = structuredClone(currentState[field]);
      }
      atomicWrite(path.join(root, 'state.json'), `${JSON.stringify(nextState, null, 2)}\n`);
      atomicWrite(path.join(root, 'events.jsonl.meta'), `${JSON.stringify(meta)}\n`);
      result = {
        folded: moved.length,
        snapshot,
        archive: archiveFile,
        foldEvent,
      };
    } catch (error) {
      atomicWrite(eventFile, originalBytes);
      if (archiveExisted) atomicWrite(archiveFile, archiveBefore);
      else fs.rmSync(archiveFile, { force: true });
      updateHealth(root, (health) => ({
        ...health,
        fold_failed: {
          ts: now.toISOString(),
          reason: error.message,
          snapshot,
        },
      }));
      throw error;
    }
  }, config);
  return result;
}
