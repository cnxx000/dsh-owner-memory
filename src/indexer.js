import { tokensOf } from './tokenize.js';

function lexical(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function eventSearchText(event) {
  return [
    event.text ?? '',
    event.key ?? '',
    ...(event.tags ?? []),
  ].join(' ');
}

export function buildIndex(state) {
  const temporary = new Map();
  const ids = Object.keys(state.byId ?? {}).sort(lexical);

  for (const id of ids) {
    const event = state.byId[id];
    const grams = [...new Set([
      ...tokensOf(event.text ?? ''),
      ...tokensOf(event.key ?? ''),
      ...(event.tags ?? []).flatMap((tag) => tokensOf(tag)),
    ])].sort(lexical);
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
