import { validateKey } from '../schema.js';
import { appendEvent } from '../storage/event-log.js';
import { assertGlobalAllowed, commonInput } from './common.js';

export async function memFact(config, args, context = {}) {
  const event = {
    kind: 'fact',
    key: validateKey(args.key),
    ...commonInput(args, context),
  };
  assertGlobalAllowed(event);
  const written = await appendEvent(config, event);
  return { id: written.id, status: 'written' };
}
