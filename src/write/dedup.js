import path from 'node:path';
import { DEFAULTS } from '../config.js';
import { MemoryError } from '../schema.js';
import { atomicWrite, readJson } from '../storage/files.js';
import { withLock } from '../storage/lock.js';
import { tokensOf } from '../tokenize.js';

function tokenSet(text) {
  return new Set(tokensOf(text));
}

export function bigramJaccard(leftText, rightText) {
  const left = tokenSet(leftText);
  const right = tokenSet(rightText);
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

export function dedupSimilarity(leftText, rightText) {
  const left = tokenSet(leftText);
  const right = tokenSet(rightText);
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const jaccard = intersection / (left.size + right.size - intersection);
  // A27 的新增“修法”会显著扩大并集；覆盖率只扩宽提示带，真正阻断仍严格使用 Jaccard。
  const coverage = intersection / Math.min(left.size, right.size);
  return Math.max(jaccard, coverage);
}

function byFirstOccurrence(left, right) {
  return Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id);
}

export function inspectDedup(state, input, options = {}) {
  const nowMs = new Date(options.now ?? Date.now()).getTime();
  const windowMs = options.windowMs ?? DEFAULTS.dedupWindowMs;
  const duplicateThreshold = options.duplicateThreshold ?? DEFAULTS.dedupDuplicateThreshold;
  const warningThreshold = options.warningThreshold ?? DEFAULTS.dedupWarningThreshold;
  const candidates = Object.values(state?.byId ?? {})
    .filter((event) => {
      const age = nowMs - Date.parse(event.ts);
      return event.kind === input.kind && age >= 0 && age <= windowMs;
    })
    .map((event) => ({
      event,
      jaccard: bigramJaccard(input.text, event.text),
      similarity: dedupSimilarity(input.text, event.text),
    }));
  const duplicate = candidates
    .filter((candidate) => candidate.jaccard >= duplicateThreshold)
    // 阈值内都已是重复；选最早一条，避免历史上存在多条时返回 id 随措辞轻微变化而抖动。
    .sort((left, right) => byFirstOccurrence(left.event, right.event))[0];
  if (duplicate) {
    return {
      duplicate: true,
      id: duplicate.event.id,
      ts: duplicate.event.ts,
      similarity: duplicate.jaccard,
      message: `这条已经记过了（${duplicate.event.id}，${String(duplicate.event.ts).slice(0, 10)}）`,
    };
  }

  const best = candidates.sort((left, right) => (
    right.similarity - left.similarity
    || right.jaccard - left.jaccard
    || byFirstOccurrence(left.event, right.event)
  ))[0];
  if (!best) return { duplicate: false };
  if (best.similarity >= warningThreshold) {
    return {
      duplicate: false,
      similarity: best.similarity,
      similarId: best.event.id,
      warning: `与 ${best.event.id} 相似（${best.similarity.toFixed(2)}），若是更正请改用 mem_fix(op='revise')，若是补充可忽略`,
    };
  }
  return { duplicate: false, similarity: best.similarity };
}

export async function recordDuplicate(root, id, now = new Date(), options = {}) {
  let count;
  await withLock(root, 'dedup-confirm', () => {
    const file = path.join(root, 'state.json');
    const state = readJson(file, null);
    if (!state?.byId?.[id]) {
      throw new MemoryError('E_REF_NOT_FOUND', `去重候选已不存在：${id}`);
    }
    state.confirmCount = { ...(state.confirmCount ?? {}) };
    state.lastSeenAt = { ...(state.lastSeenAt ?? {}) };
    count = (state.confirmCount[id] ?? 0) + 1;
    state.confirmCount[id] = count;
    state.lastSeenAt[id] = new Date(now).toISOString();
    // 确认次数不是事件事实；保留在派生层，接受全量重建后归零的既定取舍。
    atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
  }, options);
  return count;
}
