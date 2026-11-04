import path from 'node:path';
import { proposeWriteAliases } from '../alias-proposals.js';
import { DEFAULTS, rootForScope } from '../config.js';
import {
  MemoryError,
  validateHeadline,
  validateKey,
  validateVerifiedAt,
} from '../schema.js';
import { readJson } from '../storage/files.js';
import { appendEvent } from '../storage/event-log.js';
import { assertGlobalAllowed, commonInput } from './common.js';

export async function memFact(config, args, context = {}) {
  let verifiedAt;
  if (args.verifiedAt !== undefined) {
    verifiedAt = validateVerifiedAt(args.verifiedAt);
    if (Date.parse(verifiedAt) > Date.now() + 60_000) {
      throw new MemoryError('E_FUTURE_TIME', '验证时间不能晚于现在');
    }
  }
  const event = {
    kind: 'fact',
    key: validateKey(args.key),
    ...(args.headline !== undefined ? { headline: validateHeadline(args.headline) } : {}),
    ...(verifiedAt !== undefined ? { verifiedAt } : {}),
    ...commonInput(args, context),
  };
  assertGlobalAllowed(event);
  const written = await appendEvent(config, event);
  const root = rootForScope(config, written.scope ?? DEFAULTS.defaultScope);
  const state = readJson(path.join(root, 'state.json'), {});
  const warnings = await proposeWriteAliases(config, {
    targetId: written.id,
    text: written.text,
    aliases: args.aliases,
    aliasQuote: args.aliasQuote,
    sess: written.sess,
    state,
  });
  return {
    id: written.id,
    status: 'written',
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
