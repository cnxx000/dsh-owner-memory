import { DEFAULTS } from './config.js';

export const KINDS = Object.freeze([
  'fact', 'rule', 'decision', 'todo', 'note', 'revise', 'retract', 'close', 'fold',
]);
export const NOTE_KINDS = Object.freeze(['note', 'rule', 'decision', 'todo']);
export const FIX_KINDS = Object.freeze(['revise', 'retract', 'close']);
export const TAGS = Object.freeze(['偏好', '约定', '红线', '决策', '状态', '待办', '路径', '命令', '坑', '验证', '迁移残留']);

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

function validateStringArray(value, field, maxLength) {
  if (!Array.isArray(value) || value.length > maxLength || value.some((item) => typeof item !== 'string' || !item)) {
    fail('E_SCHEMA', `${field} 必须是至多 ${maxLength} 个非空字符串的数组`);
  }
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

  if (event.kind === 'fact') {
    if (event.key === undefined) fail('E_BAD_KEY', 'fact 必须提供 key');
    validateKey(event.key);
  } else if (event.key !== undefined) {
    fail('E_SCHEMA', '只有 fact 可以带 key');
  }

  if (FIX_KINDS.includes(event.kind)) {
    validateStringArray(event.refs, 'refs', DEFAULTS.maxRefs);
    if (event.refs.length < 1) fail('E_SCHEMA', '纠正类事件至少需要一个 refs');
  } else if (event.refs !== undefined) {
    validateStringArray(event.refs, 'refs', DEFAULTS.maxRefs);
  }

  if (event.tags !== undefined) {
    validateStringArray(event.tags, 'tags', DEFAULTS.maxTags);
    if (event.tags.some((tag) => !TAGS.includes(tag))) fail('E_SCHEMA', 'tags 含约定词表之外的值');
  }
  if (event.weight !== undefined && (!Number.isInteger(event.weight) || event.weight < 1 || event.weight > 5)) {
    fail('E_SCHEMA', 'weight 必须是 1–5 的整数');
  }
  if (event.scope !== undefined && !['local', 'global'].includes(event.scope)) fail('E_SCHEMA', 'scope 无效');
  if (event.src !== undefined && !['agent', 'user', 'migrate:loli', 'fold'].includes(event.src)) fail('E_SCHEMA', 'src 无效');
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
  return output;
}
