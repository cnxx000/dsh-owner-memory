import path from 'node:path';
import { selectTodos } from './l0.js';
import { MemoryError } from './schema.js';
import { atomicWrite, readJson } from './storage/files.js';
import { withLock } from './storage/lock.js';

const SUBSTANTIVE_KINDS = new Set(['rule', 'decision', 'todo', 'fact']);
const EMPTY_CARRY = Object.freeze({ text: '', sess: null, ids: [] });

function chronological(left, right) {
  return Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id);
}

function renderLine(event) {
  const original = String(event.text);
  const text = original.length > 120 ? `${original.slice(0, 120)}…` : original;
  return `[${String(event.ts).slice(0, 10)}] ${text} (${event.id})`;
}

function active(state, event) {
  return state.status?.[event.id]?.status === 'active';
}

export function buildCarry(localState, options = {}) {
  const excludedSession = options.excludeSess;
  const substantive = Object.values(localState.byId ?? {})
    .filter((event) => SUBSTANTIVE_KINDS.has(event.kind) && event.sess !== excludedSession);
  if (substantive.length === 0) return structuredClone(EMPTY_CARRY);

  const latestBySession = new Map();
  for (const event of substantive) {
    const previous = latestBySession.get(event.sess);
    if (!previous || chronological(previous, event) < 0) latestBySession.set(event.sess, event);
  }
  const sourceSession = [...latestBySession.entries()]
    .sort((left, right) => chronological(right[1], left[1]))[0]?.[0];
  if (!sourceSession) return structuredClone(EMPTY_CARRY);

  // pinned.md 的在办段已经无条件可见；carry 再带一次只会浪费上下文。
  const l0TodoIds = new Set(selectTodos(localState, { limit: 5 }).map((event) => event.id));
  const sessionEvents = substantive
    .filter((event) => (
      event.sess === sourceSession
      && active(localState, event)
      && !(event.kind === 'todo' && l0TodoIds.has(event.id))
    ))
    .sort(chronological)
    .slice(-6);
  const selectedIds = new Set(sessionEvents.map((event) => event.id));
  const extraTodos = Object.values(localState.byId ?? {})
    .filter((event) => (
      event.kind === 'todo'
      && active(localState, event)
      && !l0TodoIds.has(event.id)
      && !selectedIds.has(event.id)
    ))
    .sort((left, right) => chronological(right, left))
    .slice(0, 5)
    .sort(chronological);

  const kept = [...sessionEvents, ...extraTodos];
  let lines = kept.map(renderLine);
  while (lines.join('\n').length > 800 && lines.length > 0) {
    lines.pop();
    kept.pop();
  }
  return {
    text: lines.join('\n'),
    sess: sourceSession,
    ids: kept.map((event) => event.id),
  };
}

function writeCarriedState(file, state, sess, now) {
  state.carriedSessions = { ...(state.carriedSessions ?? {}) };
  if (state.carriedSessions[sess]) return false;
  state.carriedSessions[sess] = new Date(now).toISOString();
  atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
  return true;
}

export async function markCarried(root, sess, options = {}) {
  if (typeof sess !== 'string' || !sess) throw new MemoryError('E_SCHEMA', 'carry sess 必须是非空字符串');
  let marked = false;
  await withLock(root, 'mark-carried', () => {
    const file = path.join(root, 'state.json');
    const state = readJson(file, null);
    if (!state) throw new MemoryError('E_SCHEMA', 'state.json 不存在，无法登记 carry');
    marked = writeCarriedState(file, state, sess, options.now ?? Date.now());
  }, options);
  return marked;
}

export async function carryOnce(localState, options = {}) {
  const { root, sess } = options;
  if (typeof root !== 'string' || !root) throw new MemoryError('E_SCHEMA', 'carryOnce 必须提供 root');
  if (typeof sess !== 'string' || !sess) throw new MemoryError('E_SCHEMA', 'carryOnce 必须提供 sess');

  let result = structuredClone(EMPTY_CARRY);
  await withLock(root, 'carry-once', () => {
    const file = path.join(root, 'state.json');
    const current = readJson(file, null);
    if (!current) throw new MemoryError('E_SCHEMA', 'state.json 不存在，无法生成 carry');
    if (current.carriedSessions?.[sess]) return;

    result = buildCarry(localState, { ...options, excludeSess: sess });
    // 即使没有可搬内容也登记；否则全新工作区会在每轮重复执行“首轮”逻辑。
    writeCarriedState(file, current, sess, options.now ?? Date.now());
  }, options);
  return result;
}
