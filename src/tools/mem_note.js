import path from 'node:path';
import { DEFAULTS, rootForScope } from '../config.js';
import { MemoryError, NOTE_KINDS } from '../schema.js';
import { readJson } from '../storage/files.js';
import { appendEvent, rebuildState } from '../storage/event-log.js';
import { inspectDedup, recordDuplicate } from '../write/dedup.js';
import { factSmellWarnings } from '../write/smell.js';
import { assertGlobalAllowed, commonInput } from './common.js';

export async function memNote(config, args, context = {}) {
  if (!NOTE_KINDS.includes(args.kind)) {
    throw new MemoryError('E_SCHEMA', 'mem_note.kind 必须是 note/rule/decision/todo，且无默认值');
  }
  const event = { kind: args.kind, ...commonInput(args, context) };
  assertGlobalAllowed(event);
  const root = rootForScope(config, event.scope ?? DEFAULTS.defaultScope);
  const now = new Date();
  const state = await rebuildState(root, { ...config, recordRebuild: false });
  const dedup = inspectDedup(state, event, { now });
  if (dedup.duplicate) {
    await recordDuplicate(root, dedup.id, now, config);
    return {
      duplicate: true,
      id: dedup.id,
      ts: dedup.ts,
      message: dedup.message,
    };
  }

  const warnings = dedup.warning ? [dedup.warning] : [];
  const written = await appendEvent(config, event);
  const writtenState = readJson(path.join(root, 'state.json'), {});
  warnings.push(...factSmellWarnings(writtenState, written.text, written.id));
  return {
    id: written.id,
    status: 'written',
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
