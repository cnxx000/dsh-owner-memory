import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { rootForScope } from '../config.js';
import { deriveState } from '../derive.js';
import { MemoryError, normalizeEventInput, validateEvent } from '../schema.js';
import { atomicWrite, initRoot, preserveCorruptLine, readJson, updateHealth } from './files.js';
import { withLock } from './lock.js';

function localIso(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, -1);
  return `${local}${sign}${hours}:${minutes}`;
}

export function generateId(now = Date.now()) {
  return `m_${now.toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
}

function lastNonEmptyLine(content) {
  const lines = content.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]) return { raw: lines[index], number: index + 1 };
  }
  return { raw: '', number: 0 };
}

function parseEventContent(root, content, options = {}) {
  const events = [];
  let corruptLines = 0;

  content.split(/\r?\n/u).forEach((raw, index) => {
    if (!raw) return;
    try {
      const event = JSON.parse(raw);
      validateEvent(event);
      events.push(event);
    } catch {
      corruptLines += 1;
      preserveCorruptLine(root, index + 1, raw, options.now);
    }
  });

  if (corruptLines > 0) {
    updateHealth(root, (health) => ({
      ...health,
      // 同一坏行会在每次重建时再次被看见；指标表示坏行数，不能因重复扫描虚增。
      corruptLines: Math.max(health.corruptLines ?? 0, corruptLines),
    }));
  }
  return { events, corruptLines };
}

export function readEvents(root, options = {}) {
  initRoot(root);
  return parseEventContent(root, fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8'), options);
}

export function readArchiveEvents(root, options = {}) {
  initRoot(root);
  const archiveRoot = path.join(root, 'archive');
  const events = [];
  let corruptLines = 0;
  for (const name of fs.readdirSync(archiveRoot).filter((item) => /^\d{4}-Q[1-4]\.jsonl$/u.test(item)).sort()) {
    const parsed = parseEventContent(root, fs.readFileSync(path.join(archiveRoot, name), 'utf8'), options);
    events.push(...parsed.events);
    corruptLines += parsed.corruptLines;
  }
  return { events, corruptLines };
}

function calculateMetaFromBytes(bytes) {
  const content = bytes.toString('utf8');
  const physicalLines = content.split(/\r?\n/u).filter(Boolean);
  let lastId = null;
  for (let index = physicalLines.length - 1; index >= 0; index -= 1) {
    try {
      const candidate = JSON.parse(physicalLines[index]);
      validateEvent(candidate);
      lastId = candidate.id;
      break;
    } catch {
      // meta 描述可用事件的尾部；坏行由 corrupt 证据链单独记录。
    }
  }
  const meta = {
    lines: physicalLines.length,
    lastId,
    sha16: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16),
  };
  return meta;
}

function calculateMeta(root) {
  return calculateMetaFromBytes(fs.readFileSync(path.join(root, 'events.jsonl')));
}

export function rebuildMeta(root) {
  const meta = calculateMeta(root);
  // §4.1 把 meta 标成 ★，但它只由 events 内容计算得出；这里按可重建派生校验文件处理。
  atomicWrite(path.join(root, 'events.jsonl.meta'), `${JSON.stringify(meta)}\n`);
  return meta;
}

function metaIsCurrent(root) {
  const stored = readJson(path.join(root, 'events.jsonl.meta'), null);
  if (!stored) return false;
  const actual = calculateMeta(root);
  return stored.lines === actual.lines
    && stored.lastId === actual.lastId
    && stored.sha16 === actual.sha16;
}

function stateIsCurrent(root) {
  const state = readJson(path.join(root, 'state.json'), null);
  if (!state?.sourceHash) return false;
  const actual = calculateMeta(root);
  return state.sourceHash.lines === actual.lines
    && state.sourceHash.lastId === actual.lastId
    && state.sourceHash.sha16 === actual.sha16;
}

function derivedFilesAreCurrent(root) {
  return stateIsCurrent(root) && metaIsCurrent(root);
}

export async function rebuildState(root, options = {}) {
  initRoot(root);
  if (derivedFilesAreCurrent(root)) return readJson(path.join(root, 'state.json'), null);

  let rebuilt;
  await withLock(root, 'rebuild-state', () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = fs.readFileSync(path.join(root, 'events.jsonl'));
      const sourceHash = calculateMetaFromBytes(before);
      const { events } = parseEventContent(root, before.toString('utf8'));
      const archived = readArchiveEvents(root).events;
      const complete = [...archived, ...events].sort((left, right) => (
        Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id)
      ));
      const candidate = deriveState(complete, { sourceHash });
      const after = fs.readFileSync(path.join(root, 'events.jsonl'));
      const afterLines = calculateMetaFromBytes(after).lines;
      if (afterLines !== sourceHash.lines) {
        if (attempt === 0) continue;
        throw new MemoryError('E_DERIVE_RACE', 'derive 期间事件行数连续两次变化，未写入 state.json');
      }
      atomicWrite(path.join(root, 'state.json'), `${JSON.stringify(candidate, null, 2)}\n`);
      atomicWrite(path.join(root, 'events.jsonl.meta'), `${JSON.stringify(sourceHash)}\n`);
      if (options.recordRebuild !== false) {
        updateHealth(root, (health) => ({
          ...health,
          rebuilt: (health.rebuilt ?? 0) + 1,
        }));
      }
      rebuilt = candidate;
      return;
    }
  }, { ...options, skipIf: () => derivedFilesAreCurrent(root) });
  return rebuilt ?? readJson(path.join(root, 'state.json'), null);
}

function verifyTail(root) {
  const file = path.join(root, 'events.jsonl');
  const tail = lastNonEmptyLine(fs.readFileSync(file, 'utf8'));
  try {
    const parsed = JSON.parse(tail.raw);
    validateEvent(parsed);
    return parsed;
  } catch (error) {
    preserveCorruptLine(root, tail.number, tail.raw);
    updateHealth(root, (health) => ({
      ...health,
      corruptLines: (health.corruptLines ?? 0) + 1,
    }));
    const failure = new MemoryError('E_APPEND_VERIFY', '追加后末行校验失败，原始 logLine 已留证', {
      logLine: tail.raw,
      cause: error.message,
    });
    throw failure;
  }
}

function eventFromInput(input) {
  const normalized = normalizeEventInput(input);
  const ts = input.ts ?? localIso();
  const event = {
    id: input.id ?? generateId(),
    ts,
    kind: normalized.kind,
    text: normalized.text,
    ...(normalized.key !== undefined ? { key: normalized.key } : {}),
    ...(normalized.headline !== undefined ? { headline: normalized.headline } : {}),
    ...(normalized.kind === 'fact' ? { verifiedAt: normalized.verifiedAt ?? ts } : {}),
    ...(normalized.tags !== undefined ? { tags: normalized.tags } : {}),
    weight: normalized.weight,
    ...(normalized.refs !== undefined ? { refs: normalized.refs } : {}),
    ...(normalized.replaces !== undefined ? { replaces: normalized.replaces } : {}),
    ...(normalized.clearKey !== undefined ? { clearKey: normalized.clearKey } : {}),
    ...(normalized.aliases !== undefined ? { aliases: normalized.aliases } : {}),
    ...(normalized.symptoms !== undefined ? { symptoms: normalized.symptoms } : {}),
    ...(normalized.asks !== undefined ? { asks: normalized.asks } : {}),
    ...(normalized.quote !== undefined ? { quote: normalized.quote } : {}),
    ...(normalized.proposal !== undefined ? { proposal: normalized.proposal } : {}),
    scope: normalized.scope,
    src: normalized.src,
    ...(normalized.pin !== undefined ? { pin: normalized.pin } : {}),
    ...(normalized.ownerQuote !== undefined ? { ownerQuote: normalized.ownerQuote } : {}),
    sess: normalized.sess,
  };
  validateEvent(event);
  return event;
}

export async function appendEventToRoot(root, input, options = {}) {
  initRoot(root);
  if (fs.existsSync(path.join(root, 'disabled'))) {
    throw new MemoryError('E_DISABLED', '本工作区记忆写入已关闭；删除 .dsh-mem/disabled 后可打开');
  }
  const event = eventFromInput(input);

  await withLock(root, options.lockName ?? 'append-event', () => {
    const before = fs.readFileSync(path.join(root, 'events.jsonl'));
    const sourceBefore = calculateMetaFromBytes(before);
    const live = parseEventContent(root, before.toString('utf8'), options).events;
    const archived = readArchiveEvents(root, options).events;
    const currentEvents = [...archived, ...live].sort((left, right) => (
      Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id)
    ));
    const currentState = deriveState(currentEvents, { sourceHash: sourceBefore });
    options.beforeAppend?.(currentState, event);

    const complete = [...currentEvents, event].sort((left, right) => (
      Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id)
    ));
    const line = JSON.stringify(event);
    fs.appendFileSync(path.join(root, 'events.jsonl'), `${line}\n`, 'utf8');
    verifyTail(root);

    const sourceHash = calculateMeta(root);
    const candidate = deriveState(complete, { sourceHash });
    atomicWrite(path.join(root, 'state.json'), `${JSON.stringify(candidate, null, 2)}\n`);
    atomicWrite(path.join(root, 'events.jsonl.meta'), `${JSON.stringify(sourceHash)}\n`);
  }, options);
  return event;
}

export async function appendEvent(config, input) {
  const normalized = normalizeEventInput(input);
  const root = rootForScope(config, normalized.scope);
  return appendEventToRoot(root, input, config);
}

export { appendEvent as append_event };
