import { MemoryError, FIX_KINDS, normalizeText, validateKey } from '../schema.js';
import { appendEvent, rebuildState } from '../storage/event-log.js';
import { DEFAULTS, rootForScope } from '../config.js';
import { normalizeForSearch } from '../tokenize.js';
import { sessionId } from './common.js';

const NEGATED_STATUSES = new Set(['retracted', 'revised', 'closed']);

function hasRestorablePrevious(state, target) {
  const events = Object.values(state.byId ?? {});
  const targetIndex = events.findIndex((event) => event.id === target.id);
  for (let index = targetIndex - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (candidate.key !== target.key) continue;
    if (!NEGATED_STATUSES.has(state.status?.[candidate.id]?.status)) return true;
  }
  return false;
}

function assertCompleteStatement(text, key) {
  const normalizedText = normalizeForSearch(text);
  const object = normalizeForSearch(key).split('.')[0];
  const forbidden = /(?:应为|改为|更正|补充)/u;
  const predicate = /(?:是|为|在|使用|已|未|支持|禁止|位于|存在|存于|采用|启用|停用|允许|需要|必须)/u;
  const statementBody = object ? normalizedText.replace(object, '') : normalizedText;
  if (!object || !normalizedText.includes(object) || forbidden.test(normalizedText) || !predicate.test(statementBody)) {
    throw new MemoryError(
      'E_REVISE_NOT_STATEMENT',
      `revise 继承 ${key} 时必须写包含对象名和状态谓词的完整陈述，不能写增量补丁`,
      { key },
    );
  }
}

export async function memFix(config, args, context = {}) {
  if (!FIX_KINDS.includes(args.op)) throw new MemoryError('E_SCHEMA', 'mem_fix.op 必须是 revise/retract/close');
  if (!Array.isArray(args.refs) || args.refs.length < 1 || args.refs.length > 3) {
    throw new MemoryError('E_SCHEMA', 'mem_fix.refs 必须含 1–3 个 id');
  }
  const text = normalizeText(args.text);
  const clearKey = args.clearKey?.map((key) => validateKey(key));
  if (args.op === 'revise' && !text) throw new MemoryError('E_SCHEMA', 'revise 必须提供 text');
  const root = rootForScope(config, DEFAULTS.defaultScope);
  const state = await rebuildState(root, { ...config, recordRebuild: false });
  const missing = args.refs.filter((id) => !state.byId?.[id]);
  if (missing.length) throw new MemoryError('E_REF_NOT_FOUND', `找不到引用：${missing.join(', ')}`, { missing });
  const targets = args.refs.map((id) => state.byId[id]);
  const keyedTargets = targets.filter((event) => event.key !== undefined);
  if (args.op === 'revise' && keyedTargets.length > 1) {
    throw new MemoryError('E_REVISE_MULTI_KEY', 'revise 一次只能修订一个带 key 的事实', {
      refs: keyedTargets.map((event) => event.id),
    });
  }

  let inherited;
  if (
    args.op === 'revise'
    && args.refs.length === 1
    && keyedTargets.length === 1
    && state.byKey?.[keyedTargets[0].key] === keyedTargets[0].id
  ) {
    inherited = keyedTargets[0];
    assertCompleteStatement(text, inherited.key);
  }

  if (args.op === 'retract') {
    if (targets.some((event) => event.kind === 'decision')) {
      throw new MemoryError(
        'E_RETRACT_FORBIDDEN',
        'decision 不能 retract；新陈述取代旧决策请用 mem_note(replaces)，当时记错请用 revise',
      );
    }
    const hasRule = targets.some((event) => event.kind === 'rule');
    const mixed = hasRule && targets.some((event) => event.kind !== 'rule');
    if (hasRule && (mixed || typeof args.ownerQuote !== 'string' || !args.ownerQuote.trim())) {
      throw new MemoryError(
        'E_RULE_RETRACT_FORBIDDEN',
        mixed ? 'rule 不能与其它 kind 混合 retract' : 'rule 撤销必须提供主人原话 ownerQuote',
        { mixed },
      );
    }

    const requiredClearKeys = new Set();
    const unnecessaryClearKeys = new Set();
    for (const target of targets) {
      if (target.key === undefined || state.byKey?.[target.key] !== target.id) continue;
      if (hasRestorablePrevious(state, target)) unnecessaryClearKeys.add(target.key);
      else requiredClearKeys.add(target.key);
    }
    const suppliedClearKeys = new Set(clearKey ?? []);
    const notNeeded = [...suppliedClearKeys].filter((key) => !requiredClearKeys.has(key));
    if (notNeeded.length > 0 || [...unnecessaryClearKeys].some((key) => suppliedClearKeys.has(key))) {
      throw new MemoryError('E_CLEARKEY_NOT_NEEDED', `这些键不需要 clearKey：${notNeeded.join(', ') || [...unnecessaryClearKeys].join(', ')}`, {
        keys: notNeeded.length > 0 ? notNeeded : [...unnecessaryClearKeys],
      });
    }
    const missingClearKeys = [...requiredClearKeys].filter((key) => !suppliedClearKeys.has(key));
    if (missingClearKeys.length > 0) {
      throw new MemoryError('E_KEY_WOULD_CLEAR', `撤销会清空事实键，必须显式传 clearKey：${missingClearKeys.join(', ')}`, {
        keys: missingClearKeys,
      });
    }
  } else if (clearKey !== undefined) {
    throw new MemoryError('E_CLEARKEY_NOT_NEEDED', `${args.op} 不需要 clearKey`);
  }
  if (args.op === 'close') {
    const wrong = args.refs.filter((_id, index) => targets[index].kind !== 'todo');
    if (wrong.length) throw new MemoryError('E_REF_KIND', `close 只能关闭 todo：${wrong.join(', ')}`, { wrong });
  }

  const written = await appendEvent(config, {
    kind: args.op,
    refs: args.refs,
    text: text || `${new Date().toISOString().slice(0, 10)} ${args.op === 'close' ? '关闭待办。' : '撤销该记忆。'}`,
    ...(inherited ? {
      key: inherited.key,
      weight: Math.max(inherited.weight ?? DEFAULTS.defaultWeight, DEFAULTS.defaultWeight),
      ...(inherited.tags !== undefined ? { tags: inherited.tags } : {}),
      ...(inherited.pin !== undefined ? { pin: inherited.pin } : {}),
    } : {}),
    ...(args.ownerQuote !== undefined ? { ownerQuote: args.ownerQuote } : {}),
    ...(clearKey !== undefined ? { clearKey } : {}),
    sess: sessionId(context),
  });
  return { id: written.id, status: 'written', affected: [...args.refs] };
}
