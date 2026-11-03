// 只保留高频虚词与低信息短语；词表刻意维持在约 1KB，避免引入大型分词词典。
const STOP_WORDS = new Set(`
的 了 是 在 有 和 就 也 都 而 及 与 或 但 被 把 给 让 对 从 到 于 为 以
吗 呢 吧 啊 呀 哦 嗯 着 过 地 得 很 太 更 最 又 再 还 已 经 将 会 能 可
我 你 他 她 它 我们 你们 他们 她们 这个 那个 这些 那些 一个 一些 什么
怎么 为什么 哪里 哪个 谁 何时 时候 目前 现在 然后 如果 因为 所以 但是
并且 而且 或者 以及 其中 通过 关于 对于 由于 需要 可以 可能 应该 已经
没有 不是 还是 只是 进行 使用 里面 外面 上面 下面 之前 之后 今天 昨天
明天 本次 这次 那次 每次 一下 一点 一样 这样 那样 的话 来说 这里 那里
是否 如何 相关 这种 那种 某个 某些 其他 其它 比较 非常 真的 其实 仍然
`.trim().split(/\s+/u));

export function normalizeForSearch(input) {
  return String(input ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

export function tokensOf(input) {
  const normalized = normalizeForSearch(input);
  if (!normalized) return [];
  const onlySingleHan = /^\p{Script=Han}$/u.test(normalized);
  const tokens = [];
  const runs = normalized.match(/[\p{Script=Han}]+|[a-z0-9][a-z0-9._/\\:@+-]*/gu) ?? [];

  for (const run of runs) {
    if (/^\p{Script=Han}+$/u.test(run)) {
      if (run.length === 1) {
        if (onlySingleHan && !STOP_WORDS.has(run)) tokens.push(run);
        continue;
      }
      for (let index = 0; index < run.length - 1; index += 1) {
        const gram = run.slice(index, index + 2);
        if (!STOP_WORDS.has(gram)) tokens.push(gram);
      }
    } else if (!STOP_WORDS.has(run)) {
      tokens.push(run);
    }
  }
  return tokens;
}

export { STOP_WORDS };
