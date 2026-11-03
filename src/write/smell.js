import { normalizeForSearch } from '../tokenize.js';

function keyParts(key) {
  const [object, aspect] = String(key).split('.');
  return {
    key,
    object: normalizeForSearch(object),
    aspect: normalizeForSearch(aspect),
  };
}

function existingKeys(state) {
  return Object.keys(state?.byKey ?? {}).sort().map(keyParts);
}

export function factSmellWarnings(state, text, writtenId) {
  const normalized = normalizeForSearch(text);
  return existingKeys(state)
    .filter(({ object, aspect }) => (
      object && aspect && normalized.includes(object) && normalized.includes(aspect)
    ))
    .map(({ key }) => (
      `这句像 ${key} 这个已有事实键的新值，若是请改用 mem_fact(key='${key}')；`
      + `原条已写入 ${writtenId}，可用 mem_fix(op='retract') 撤销`
    ));
}

export function suspectedShouldBeFact(state) {
  const aspects = [...new Set(existingKeys(state).map(({ aspect }) => aspect).filter(Boolean))];
  return Object.values(state?.byId ?? {})
    .filter((event) => (
      event.kind === 'note'
      && aspects.some((aspect) => normalizeForSearch(event.text).includes(aspect))
    ))
    .sort((left, right) => (
      Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id)
    ))
    .map((event) => event.id);
}
