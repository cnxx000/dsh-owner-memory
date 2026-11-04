import { tokensOf } from './tokenize.js';

function lexical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function eventSearchText(event) {
  if (['confirm', 'symptom'].includes(event?.kind)) return '';
  return [
    event.text ?? '',
    event.key ?? '',
    ...(event.tags ?? []),
  ].join(' ');
}

export function recallSearchText(state, event, opts = {}) {
  const original = eventSearchText(event);
  if (opts.symptomsInRecall !== true || !original) return original;
  return [
    original,
    ...(state.symptoms?.[event.id] ?? []),
    ...(state.asks?.[event.id] ?? []),
  ].join(' ');
}

export function buildIndex(state, opts = {}) {
  const temporary = new Map();
  const ids = Object.keys(state.byId ?? {}).sort(lexical);

  for (const id of ids) {
    const event = state.byId[id];
    if (['confirm', 'symptom'].includes(event.kind)) continue;
    const grams = [...new Set(tokensOf(recallSearchText(state, event, opts)))].sort(lexical);
    for (const gram of grams) {
      if (!temporary.has(gram)) temporary.set(gram, []);
      temporary.get(gram).push(id);
    }
  }

  const postings = {};
  const df = {};
  for (const gram of [...temporary.keys()].sort(lexical)) {
    postings[gram] = temporary.get(gram);
    df[gram] = postings[gram].length;
  }
  return { postings, df };
}
