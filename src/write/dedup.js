import { DEFAULTS } from '../config.js';
import { confirmText, MemoryError } from '../schema.js';
import { appendEventToRoot } from '../storage/event-log.js';
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
  const replacedIds = new Set(input.replaces ?? []);
  const candidates = Object.values(state?.byId ?? {})
    .filter((event) => {
      const age = nowMs - Date.parse(event.ts);
      return event.kind === input.kind
        && !replacedIds.has(event.id)
        && age >= 0
        && age <= windowMs;
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
  await appendEventToRoot(root, {
    ts: new Date(now).toISOString(),
    kind: 'confirm',
    text: confirmText(id),
    refs: [id],
    scope: options.confirmScope ?? 'local',
    src: 'agent',
    sess: options.confirmSess ?? 'dedup-confirm',
  }, {
    ...options,
    lockName: 'dedup-confirm',
    beforeAppend(state) {
      if (!state?.byId?.[id]) {
        throw new MemoryError('E_REF_NOT_FOUND', `去重候选已不存在：${id}`);
      }
      // appendEventToRoot 在同一把根锁内完成校验、追加和派生，计数只从事件流计算。
      count = (state.confirmCount[id] ?? 0) + 1;
    },
  });
  return count;
}
