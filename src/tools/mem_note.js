import path from 'node:path';
import { proposeWriteAliases } from '../alias-proposals.js';
import { DEFAULTS, rootForScope } from '../config.js';
import {
  MemoryError,
  NOTE_KINDS,
  validateAsks,
  validateSymptoms,
} from '../schema.js';
import { readJson } from '../storage/files.js';
import { appendEvent, rebuildState } from '../storage/event-log.js';
import { inspectDedup, recordDuplicate } from '../write/dedup.js';
import { factSmellWarnings } from '../write/smell.js';
import { assertGlobalAllowed, commonInput } from './common.js';

export async function memNote(config, args, context = {}) {
  if (!NOTE_KINDS.includes(args.kind)) {
    throw new MemoryError('E_SCHEMA', 'mem_note.kind 必须是 note/rule/decision/todo，且无默认值');
  }
  if (args.symptom !== undefined) {
    validateSymptoms(args.symptom, 'symptom');
  }
  if (args.ask !== undefined) {
    validateAsks(args.ask, 'ask');
  }
  if (
    (args.symptom !== undefined || args.ask !== undefined)
    && (args.kind !== 'note' || !Array.isArray(args.tags) || !args.tags.includes('坑'))
  ) {
    throw new MemoryError('E_SYMPTOM_KIND', 'symptom/ask 只对带 tags:["坑"] 的 note 生效');
  }
  if (
    args.replaces !== undefined
    && (
      !Array.isArray(args.replaces)
      || args.replaces.length < 1
      || args.replaces.length > 3
      || args.replaces.some((id) => typeof id !== 'string' || !id)
    )
  ) {
    throw new MemoryError('E_SCHEMA', 'mem_note.replaces 必须含 1–3 个 id');
  }
  if (args.replaces !== undefined && new Set(args.replaces).size !== args.replaces.length) {
    throw new MemoryError('E_REPLACES_TARGET', 'mem_note.replaces 不能包含重复 id', {
      ids: args.replaces,
    });
  }
  const event = {
    kind: args.kind,
    ...commonInput(args, context),
    ...(args.replaces !== undefined ? { replaces: args.replaces } : {}),
  };
  assertGlobalAllowed(event);
  const root = rootForScope(config, event.scope ?? DEFAULTS.defaultScope);
  const now = new Date();
  const state = await rebuildState(root, { ...config, recordRebuild: false });
  if (event.replaces !== undefined) {
    const missingOrInactive = event.replaces.filter((id) => (
      !state.byId?.[id] || state.status?.[id]?.status !== 'active'
    ));
    if (missingOrInactive.length > 0) {
      throw new MemoryError(
        'E_REPLACES_TARGET',
        `replaces 目标不存在或不是 active：${missingOrInactive.join(', ')}`,
        { ids: missingOrInactive },
      );
    }
    const wrongKind = event.replaces.filter((id) => {
      const target = state.byId[id];
      return target.key !== undefined || target.kind !== event.kind;
    });
    if (wrongKind.length > 0) {
      throw new MemoryError(
        'E_REPLACES_KIND',
        `replaces 只能取代同 kind 的非 fact 条目：${wrongKind.join(', ')}`,
        { ids: wrongKind },
      );
    }
  }
  const dedup = inspectDedup(state, event, { now });
  if (dedup.duplicate) {
    await recordDuplicate(root, dedup.id, now, {
      ...config,
      confirmScope: event.scope ?? DEFAULTS.defaultScope,
      confirmSess: context.sessionId ?? 'dedup-confirm',
    });
    return {
      duplicate: true,
      id: dedup.id,
      ts: dedup.ts,
      message: dedup.message,
    };
  }

  const warnings = dedup.warning ? [dedup.warning] : [];
  const written = await appendEvent(config, event);
  if (args.symptom !== undefined || args.ask !== undefined) {
    const used = Object.values(state.byId ?? {})
      .filter((candidate) => candidate.kind === 'symptom' && candidate.sess === written.sess)
      .reduce((count, candidate) => count + new Set(candidate.symptoms ?? []).size, 0);
    const requested = [...new Set(args.symptom ?? [])];
    const accepted = requested.slice(0, Math.max(0, 3 - used));
    const discarded = requested.slice(accepted.length);
    const asks = [...new Set(args.ask ?? [])];
    if (accepted.length > 0 || asks.length > 0) {
      await appendEvent(config, {
        kind: 'symptom',
        text: [
          ...(accepted.length > 0 ? [`症状词：${accepted.join('、')}`] : []),
          ...(asks.length > 0 ? [`问法：${asks.join('、')}`] : []),
        ].join('；'),
        refs: [written.id],
        ...(accepted.length > 0 ? { symptoms: accepted } : {}),
        ...(asks.length > 0 ? { asks } : {}),
        scope: written.scope,
        src: 'agent',
        sess: written.sess,
      });
    }
    if (discarded.length > 0) {
      warnings.push(`本会话症状词最多新增 3 个，已丢弃：${discarded.join('、')}`);
    }
  }
  const writtenState = readJson(path.join(root, 'state.json'), {});
  warnings.push(...factSmellWarnings(writtenState, written.text, written.id));
  warnings.push(...await proposeWriteAliases(config, {
    targetId: written.id,
    text: written.text,
    aliases: args.aliases,
    aliasQuote: args.aliasQuote,
    sess: written.sess,
    state: writtenState,
    now,
  }));
  return {
    id: written.id,
    status: 'written',
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
