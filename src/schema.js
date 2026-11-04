import { DEFAULTS } from './config.js';

export const KINDS = Object.freeze([
  'fact', 'rule', 'decision', 'todo', 'note', 'revise', 'retract', 'close', 'fold', 'supersede',
  'alias', 'confirm', 'symptom',
]);
export const NOTE_KINDS = Object.freeze(['note', 'rule', 'decision', 'todo']);
export const FIX_KINDS = Object.freeze(['revise', 'retract', 'close']);
export const TAGS = Object.freeze([
  '偏好', '约定', '红线', '决策', '状态', '待办', '路径', '命令', '坑', '验证', '迁移残留', '提议撤红线',
]);

export class MemoryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new MemoryError(code, message, details);
}

export function normalizeKey(key) {
  return String(key ?? '')
    .trim()
    .replaceAll('。', '.')
    .replace(/[A-Z]+/g, (part) => part.toLowerCase());
}

export function normalizeText(text) {
  return String(text ?? '').trim().replace(/\r?\n+/g, ' ');
}

export function viewKind(event) {
  return event?.key !== undefined ? 'fact' : event?.kind;
}

export function supersedeText(oldId, newId) {
  return `历史迁移：${oldId} 已被 ${newId} 取代。`;
}

export function confirmText(id) {
  return `确认：${id} 再次被想起。`;
}

export function validateKey(input) {
  const key = normalizeKey(input);
  const parts = key.split('.');
  if (parts.length !== 2 || parts.some((part) => !part.trim())) {
    fail('E_BAD_KEY', `事实键必须是“对象.方面”两段：${key || '(空)'}`);
  }

  const [object, aspect] = parts;
  // 数字、时间词和“用某物”通常就是值；放进键会让新值永远无法取代旧值。
  const valueLike = /\d/.test(key)
    || /(?:今天|昨天|明天|本周|本月|今年)/u.test(key)
    || /^用/u.test(aspect)
    || /喜欢的东西/u.test(aspect);
  if (valueLike) {
    fail('E_BAD_KEY', `事实键疑似包含具体值：${key}`, { suspiciousPart: /\d/.test(object) ? object : aspect });
  }
  return key;
}

export function validateVerifiedAt(value) {
  if (
    typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    fail('E_SCHEMA', 'verifiedAt 必须是带时区的 ISO8601');
  }
  return value;
}

export function validateHeadline(value) {
  if (
    typeof value !== 'string'
    || [...value].length < 1
    || [...value].length > 18
    || /[\r\n]/u.test(value)
  ) {
    fail('E_SCHEMA', 'headline 必须是 1–18 字且不含换行');
  }
  return value;
}

function validateStringArray(value, field, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength || value.some((item) => typeof item !== 'string' || !item)) {
    fail('E_SCHEMA', `${field} 必须是至多 ${maxLength} 个非空字符串的数组`);
  }
}

function validateAliases(value) {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 3
    || value.some((item) => (
      typeof item !== 'string'
      || [...item].length < 2
      || [...item].length > 20
      || /[\r\n]/u.test(item)
    ))
  ) {
    fail('E_SCHEMA', 'aliases 必须含 1–3 条、每条 2–20 字且不含换行');
  }
}

export function validateSymptoms(value, field = 'symptoms') {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 2
    || value.some((item) => (
      typeof item !== 'string'
      || [...item].length < 2
      || [...item].length > 8
      || /[\r\n]/u.test(item)
    ))
  ) {
    fail('E_SCHEMA', `${field} 必须含 1–2 条、每条 2–8 字且不含换行`);
  }
  return value;
}

export function validateAsks(value, field = 'asks') {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > 3
    || value.some((item) => (
      typeof item !== 'string'
      || [...item].length < 6
      || [...item].length > 40
      || /[\r\n]/u.test(item)
    ))
  ) {
    fail('E_SCHEMA', `${field} 必须含 1–3 条、每条 6–40 字且不含换行`);
  }
  return value;
}

export function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail('E_SCHEMA', '事件必须是对象');
  if (typeof event.id !== 'string' || !/^m_(?:mig_[0-9a-f]{10}|[0-9a-z]+_[0-9a-f]{4})$/i.test(event.id)) {
    fail('E_SCHEMA', 'id 格式无效');
  }
  if (typeof event.ts !== 'string' || Number.isNaN(Date.parse(event.ts)) || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(event.ts)) {
    fail('E_SCHEMA', 'ts 必须是带时区的 ISO8601');
  }
  if (!KINDS.includes(event.kind)) fail('E_SCHEMA', `kind 无效：${event.kind}`);
  if (typeof event.text !== 'string' || event.text.length < 1) fail('E_SCHEMA', 'text 必须是非空字符串');
  if (event.text.length > DEFAULTS.maxTextChars) fail('E_TEXT_TOO_LONG', 'text 超过 200 字符，请拆成多条');
  if (event.text.includes('\n') || event.text.includes('\r')) fail('E_SCHEMA', 'text 不能含裸换行');
  if (typeof event.sess !== 'string' || !event.sess) fail('E_SCHEMA', 'sess 必填');

  if (event.kind === 'fact' && event.key === undefined) {
    fail('E_BAD_KEY', 'fact 必须提供 key');
  }
  if (event.key !== undefined) {
    if (!['fact', 'revise'].includes(event.kind)) fail('E_SCHEMA', '只有 fact 或 revise 可以带 key');
    validateKey(event.key);
  }
  if (event.verifiedAt !== undefined) {
    if (event.kind !== 'fact') fail('E_SCHEMA', '只有 fact 可以带 verifiedAt');
    validateVerifiedAt(event.verifiedAt);
  }
  if (event.headline !== undefined) {
    if (event.kind !== 'fact') fail('E_SCHEMA', '只有 fact 可以带 headline');
    validateHeadline(event.headline);
  }

  if (FIX_KINDS.includes(event.kind)) {
    validateStringArray(event.refs, 'refs', DEFAULTS.maxRefs);
    if (event.refs.length < 1) fail('E_SCHEMA', '纠正类事件至少需要一个 refs');
  } else if (event.refs !== undefined) {
    validateStringArray(event.refs, 'refs', DEFAULTS.maxRefs);
  }
  if (event.kind === 'supersede') {
    if (!Array.isArray(event.refs) || event.refs.length !== 2) fail('E_SCHEMA', 'supersede.refs 必须恰好含旧、新两个 id');
    if (event.text !== supersedeText(event.refs[0], event.refs[1])) fail('E_SCHEMA', 'supersede.text 必须使用固定模板');
  }
  if (event.kind === 'confirm') {
    if (!Array.isArray(event.refs) || event.refs.length !== 1) fail('E_SCHEMA', 'confirm.refs 必须恰好含一个目标 id');
    if (event.text !== confirmText(event.refs[0])) fail('E_SCHEMA', 'confirm.text 必须使用固定模板');
  }
  if (event.kind === 'symptom') {
    if (!Array.isArray(event.refs) || event.refs.length !== 1) fail('E_SCHEMA', 'symptom.refs 必须恰好含一个目标 id');
    if (event.symptoms === undefined && event.asks === undefined) {
      fail('E_SYMPTOM_EMPTY', 'symptom 事件必须至少包含 symptoms 或 asks');
    }
    if (event.symptoms !== undefined) validateSymptoms(event.symptoms);
    if (event.asks !== undefined) validateAsks(event.asks);
    if (!['agent', 'review'].includes(event.src)) fail('E_SCHEMA', 'symptom 事件必须使用 src=agent/review');
  } else if (
    event.symptoms !== undefined
    || event.symptom !== undefined
    || event.asks !== undefined
    || event.ask !== undefined
  ) {
    fail('E_SYMPTOM_KIND', '症状词和问法只允许写入内部 symptom 事件');
  }
  if (event.kind === 'alias') {
    if (!Array.isArray(event.refs) || event.refs.length !== 1) fail('E_SCHEMA', 'alias.refs 必须恰好含一个目标 id');
    if (
      typeof event.quote !== 'string'
      || event.quote.length < 1
      || event.quote.length > 200
      || /[\r\n]/u.test(event.quote)
    ) {
      fail('E_SCHEMA', 'alias.quote 必须是 1–200 字且不含换行');
    }
    if (event.src !== 'review') fail('E_SCHEMA', 'alias 事件必须使用 src=review');
    if (event.proposal !== undefined) {
      const proposal = event.proposal;
      const keys = proposal && typeof proposal === 'object' && !Array.isArray(proposal)
        ? Object.keys(proposal)
        : [];
      if (
        keys.length !== 3
        || !['signal', 'sess', 'proposedAt'].every((key) => keys.includes(key))
        || [proposal?.signal, proposal?.sess, proposal?.proposedAt].some(
          (value) => typeof value !== 'string' || !value,
        )
        || Number.isNaN(Date.parse(proposal.proposedAt))
      ) {
        fail('E_SCHEMA', 'alias.proposal 必须是 {signal, sess, proposedAt}');
      }
    }
  } else {
    if (event.quote !== undefined) fail('E_SCHEMA', '只有 alias 事件可以带 quote');
    if (event.proposal !== undefined) fail('E_SCHEMA', '只有 alias 事件可以带 proposal');
  }

  if (event.aliases !== undefined) {
    if (!['fact', 'note', 'alias'].includes(event.kind)) {
      fail('E_SCHEMA', '只有 fact/note/alias 可以带 aliases');
    }
    validateAliases(event.aliases);
  } else if (event.kind === 'alias') {
    fail('E_SCHEMA', 'alias 事件必须带 aliases');
  }

  if (event.ownerQuote !== undefined) {
    if (event.kind !== 'retract') fail('E_SCHEMA', '只有 retract 可以带 ownerQuote');
    if (
      typeof event.ownerQuote !== 'string'
      || event.ownerQuote.trim().length < 1
      || event.ownerQuote.length > 200
      || /[\r\n]/u.test(event.ownerQuote)
    ) {
      fail('E_SCHEMA', 'ownerQuote 必须是 1–200 字且不含换行');
    }
  }
  if (event.replaces !== undefined) {
    if (!NOTE_KINDS.includes(event.kind)) fail('E_SCHEMA', '只有 note/rule/decision/todo 可以带 replaces');
    validateStringArray(event.replaces, 'replaces', 3);
    if (event.replaces.length < 1) fail('E_SCHEMA', 'replaces 必须含 1–3 个 id');
  }
  if (event.clearKey !== undefined) {
    if (!['revise', 'retract'].includes(event.kind)) fail('E_SCHEMA', '只有 revise/retract 可以带 clearKey');
    validateStringArray(event.clearKey, 'clearKey', DEFAULTS.maxRefs);
    if (event.clearKey.length < 1) fail('E_SCHEMA', 'clearKey 至少需要一个事实键');
    for (const key of event.clearKey) validateKey(key);
  }

  if (event.tags !== undefined) {
    validateStringArray(event.tags, 'tags', DEFAULTS.maxTags);
    if (event.tags.some((tag) => !TAGS.includes(tag))) fail('E_SCHEMA', 'tags 含约定词表之外的值');
  }
  if (event.weight !== undefined && (!Number.isInteger(event.weight) || event.weight < 1 || event.weight > 5)) {
    fail('E_SCHEMA', 'weight 必须是 1–5 的整数');
  }
  if (event.scope !== undefined && !['local', 'global'].includes(event.scope)) fail('E_SCHEMA', 'scope 无效');
  if (event.src !== undefined && !['agent', 'user', 'migrate:loli', 'migrate:p0', 'fold', 'review'].includes(event.src)) fail('E_SCHEMA', 'src 无效');
  if (event.src === 'review' && !['alias', 'symptom'].includes(event.kind)) {
    fail('E_SCHEMA', 'src=review 只允许 alias/symptom 事件');
  }
  if (event.pin !== undefined && typeof event.pin !== 'boolean') fail('E_SCHEMA', 'pin 必须是布尔值');
  if (event.kind === 'fold') {
    if (!Number.isInteger(event.foldedCount) || event.foldedCount < 0) fail('E_SCHEMA', 'foldedCount 必须是非负整数');
    if (typeof event.into !== 'string' || !event.into) fail('E_SCHEMA', 'fold.into 必填');
    if (typeof event.sha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(event.sha256)) fail('E_SCHEMA', 'fold.sha256 无效');
    if (!Array.isArray(event.idRange) || event.idRange.length !== 2) fail('E_SCHEMA', 'fold.idRange 必须含首尾 id');
  }
  return event;
}

export function normalizeEventInput(input) {
  const output = {
    ...input,
    text: normalizeText(input.text),
    scope: input.scope ?? DEFAULTS.defaultScope,
    src: input.src ?? DEFAULTS.defaultSrc,
    weight: input.weight ?? DEFAULTS.defaultWeight,
  };
  if (input.key !== undefined) output.key = validateKey(input.key);
  if (input.headline !== undefined) output.headline = validateHeadline(input.headline);
  if (Array.isArray(input.clearKey)) output.clearKey = input.clearKey.map((key) => validateKey(key));
  if (Array.isArray(input.aliases)) output.aliases = [...input.aliases];
  if (Array.isArray(input.symptoms)) output.symptoms = [...input.symptoms];
  if (Array.isArray(input.asks)) output.asks = [...input.asks];
  if (input.quote !== undefined) output.quote = String(input.quote);
  if (input.proposal !== undefined) output.proposal = structuredClone(input.proposal);
  return output;
}
