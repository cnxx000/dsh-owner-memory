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

function matchingKeys(keys, text) {
  const normalized = normalizeForSearch(text);
  return keys.filter(({ object, aspect }) => (
    object && aspect && normalized.includes(object) && normalized.includes(aspect)
  ));
}

export function factSmellWarnings(state, text, writtenId) {
  return matchingKeys(existingKeys(state), text)
    .map(({ key }) => (
      `这句像 ${key} 这个已有事实键的新值，若是请改用 mem_fact(key='${key}')；`
      + `原条已写入 ${writtenId}，可用 mem_fix(op='retract') 撤销`
    ));
}

// 与 factSmellWarnings 同口径：正文要同时含某个键的 object 和 aspect；只撞上「状态」「位置」这类 aspect 词是噪音。
export function suspectedShouldBeFact(state) {
  const keys = existingKeys(state);
  return Object.values(state?.byId ?? {})
    .filter((event) => event.kind === 'note' && matchingKeys(keys, event.text).length > 0)
    .sort((left, right) => (
      Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id)
    ))
    .map((event) => event.id);
}
