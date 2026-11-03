import { MemoryError, FIX_KINDS, normalizeText } from '../schema.js';
import { appendEvent, readEvents } from '../storage/event-log.js';
import { DEFAULTS, rootForScope } from '../config.js';
import { sessionId } from './common.js';

export async function memFix(config, args, context = {}) {
  if (!FIX_KINDS.includes(args.op)) throw new MemoryError('E_SCHEMA', 'mem_fix.op 必须是 revise/retract/close');
  if (!Array.isArray(args.refs) || args.refs.length < 1 || args.refs.length > 3) {
    throw new MemoryError('E_SCHEMA', 'mem_fix.refs 必须含 1–3 个 id');
  }
  const text = normalizeText(args.text);
  if (args.op === 'revise' && !text) throw new MemoryError('E_SCHEMA', 'revise 必须提供 text');
  const existing = new Map(readEvents(rootForScope(config, DEFAULTS.defaultScope)).events.map((event) => [event.id, event]));
  const missing = args.refs.filter((id) => !existing.has(id));
  if (missing.length) throw new MemoryError('E_REF_NOT_FOUND', `找不到引用：${missing.join(', ')}`, { missing });
  if (args.op === 'close') {
    const wrong = args.refs.filter((id) => existing.get(id).kind !== 'todo');
    if (wrong.length) throw new MemoryError('E_REF_KIND', `close 只能关闭 todo：${wrong.join(', ')}`, { wrong });
  }

  const written = await appendEvent(config, {
    kind: args.op,
    refs: args.refs,
    text: text || `${new Date().toISOString().slice(0, 10)} ${args.op === 'close' ? '关闭待办。' : '撤销该记忆。'}`,
    sess: sessionId(context),
  });
  return { id: written.id, status: 'written', affected: [...args.refs] };
}
