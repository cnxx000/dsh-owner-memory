import path from 'node:path';
import { buildIndex } from './indexer.js';
import { atomicWrite, initRoot, readJson } from './storage/files.js';
import { withLock } from './storage/lock.js';
import { tokensOf } from './tokenize.js';

const WRITE_STOP_WORDS = Object.freeze([
  '那个', '上次', '之前', '这个', '插件', '工具', '东西',
]);

export function proposalPath(root) {
  return path.join(root, 'alias-proposals.json');
}

function proposalKey(proposal) {
  return `${proposal.phrase}\u0000${proposal.target?.id ?? ''}`;
}

function proposalArray(value) {
  return Array.isArray(value) ? value : [];
}

export async function mergeAliasProposals(root, incoming, options = {}) {
  initRoot(root);
  const accepted = [];
  const limited = [];
  await withLock(root, 'alias-proposals', () => {
    const file = proposalPath(root);
    const existing = proposalArray(readJson(file, []));
    const byKey = new Map(existing.map((proposal) => [proposalKey(proposal), proposal]));
    const writeCounts = new Map();
    for (const proposal of existing) {
      if (proposal.signal !== 'write') continue;
      writeCounts.set(proposal.sess, (writeCounts.get(proposal.sess) ?? 0) + 1);
    }

    for (const proposal of incoming) {
      const key = proposalKey(proposal);
      const previous = byKey.get(key);
      if (previous) {
        const decision = previous.decision;
        Object.assign(previous, proposal);
        if (decision !== null && decision !== undefined) previous.decision = decision;
        continue;
      }
      if (proposal.signal === 'write') {
        const count = writeCounts.get(proposal.sess) ?? 0;
        if (count >= (options.maxWritePerSession ?? 3)) {
          limited.push(proposal);
          continue;
        }
        writeCounts.set(proposal.sess, count + 1);
      }
      existing.push(proposal);
      byKey.set(key, proposal);
      accepted.push(proposal);
    }
    atomicWrite(file, `${JSON.stringify(existing, null, 2)}\n`);
  }, options);
  return { accepted, limited };
}

function writeAliasFailure(phrase, reason) {
  return `俗称提案“${String(phrase)}”已丢弃：${reason}`;
}

function validateWritePhrase(phrase, quote, text, index, totalEntries) {
  if (typeof phrase !== 'string' || [...phrase].length < 3 || [...phrase].length > 20) {
    return '须为 3–20 字';
  }
  if (typeof quote !== 'string' || !quote.includes(phrase)) return '不在 aliasQuote 原句中';
  const informative = WRITE_STOP_WORDS.reduce(
    (value, stopWord) => value.replaceAll(stopWord, ''),
    phrase,
  );
  const hanCount = [...informative].filter((character) => /\p{Script=Han}/u.test(character)).length;
  if (hanCount < 2) return '去停用词后不足 2 个汉字';
  if (String(text).includes(phrase)) return '已出现在条目正文';
  const bigrams = [...new Set(tokensOf(phrase).filter((token) => (
    [...token].length === 2 && /^\p{Script=Han}{2}$/u.test(token)
  )))];
  if (
    bigrams.length > 0
    && bigrams.some((gram) => (index.df?.[gram] ?? 0) > totalEntries * 0.1)
  ) {
    return 'bigram 文档频率超过 10%';
  }
  return null;
}

export async function proposeWriteAliases(config, input) {
  if (!Array.isArray(input.aliases) || input.aliases.length === 0) return [];
  const root = config.localRoot;
  const state = input.state;
  const index = buildIndex(state);
  const totalEntries = Object.keys(state.byId ?? {}).length;
  const warnings = [];
  const proposals = [];
  const seen = new Set();
  const proposedAt = new Date(input.now ?? Date.now()).toISOString();

  for (const phrase of input.aliases) {
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    const reason = validateWritePhrase(
      phrase,
      input.aliasQuote,
      input.text,
      index,
      totalEntries,
    );
    if (reason) {
      warnings.push(writeAliasFailure(phrase, reason));
      continue;
    }
    proposals.push({
      phrase,
      target: { id: input.targetId },
      signal: 'write',
      quote: input.aliasQuote,
      sess: input.sess,
      proposedAt,
      decision: null,
    });
  }

  if (proposals.length === 0) return warnings;
  try {
    const merged = await mergeAliasProposals(root, proposals, config);
    for (const proposal of merged.limited) {
      warnings.push(writeAliasFailure(proposal.phrase, '本会话 write 提案已达 3 条'));
    }
  } catch (error) {
    warnings.push(`俗称提案写入失败：${error?.message ?? error}`);
  }
  return warnings;
}

export { WRITE_STOP_WORDS };
