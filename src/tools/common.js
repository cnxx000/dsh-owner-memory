import { MemoryError, normalizeText, viewKind } from '../schema.js';
import { DEFAULTS } from '../config.js';

/**
 * 2026-11-03：真宿主的 `ToolRunContext` 没有 `sessionId` 字段
 * （契约见 ToolExecutionInput：callId / name / arguments / agent / signal），
 * 会话 id 只能从 `exec.agent` 上取。之前只认 `context.sessionId`，夹具里塞得进去、
 * 真机第一次写入就会抛「宿主必须提供 sessionId」。
 */
export function sessionId(context = {}) {
  const value = context.sessionId ?? context.sess
    ?? context.agent?.session?.header?.id
    ?? context.agent?.id;
  if (typeof value !== 'string' || !value) throw new MemoryError('E_SCHEMA', '宿主必须提供 sessionId');
  return value;
}

export function commonInput(args, context) {
  return {
    text: normalizeText(args.text),
    ...(args.tags !== undefined ? { tags: args.tags } : {}),
    ...(args.weight !== undefined ? { weight: args.weight } : {}),
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.pin !== undefined ? { pin: args.pin } : {}),
    ...(args.src !== undefined ? { src: args.src } : {}),
    sess: sessionId(context),
  };
}

export function assertGlobalAllowed(event) {
  if (event.scope !== 'global') return;
  if (viewKind(event) === 'rule') return;
  if (viewKind(event) === 'fact' && (event.weight ?? DEFAULTS.defaultWeight) >= 4) return;
  throw new MemoryError('E_GLOBAL_KIND', 'global 只接受 rule 或 weight>=4 的 fact');
}
