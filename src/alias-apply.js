import crypto from 'node:crypto';
import path from 'node:path';
import { proposalPath } from './alias-proposals.js';
import { resolveConfig } from './config.js';
import { atomicWrite, readJson } from './storage/files.js';
import { appendEvent, rebuildState } from './storage/event-log.js';
import { withLock } from './storage/lock.js';

function proposalKey(proposal) {
  return `${proposal.phrase}\u0000${proposal.target?.id ?? ''}`;
}

export function deterministicAliasId(targetId, phrase) {
  const hash = crypto.createHash('sha256').update(`${targetId}\u0000${phrase}`).digest('hex');
  return `m_a${hash.slice(0, 10)}_${hash.slice(10, 14)}`;
}

export function redactAliasQuote(quote) {
  return String(quote ?? '')
    .replace(/\r?\n+/gu, ' ')
    .replace(/[A-Za-z0-9+/=]{20,}/gu, '[redacted]')
    .slice(0, 200);
}

function latestTarget(state, initialId) {
  let id = initialId;
  const seen = new Set();
  while (!seen.has(id)) {
    seen.add(id);
    const status = state.status?.[id];
    if (status?.status !== 'superseded' || !status.supersededBy) break;
    id = status.supersededBy;
  }
  const status = state.status?.[id]?.status;
  return {
    id,
    event: state.byId?.[id],
    retracted: status === 'retracted',
  };
}

function aliasTable(value) {
  if (value?.version === 1 && Array.isArray(value.entries)) return value;
  return { version: 1, entries: [] };
}

export async function applyAliasProposals(root, options = {}) {
  const config = options.config ?? resolveConfig({
    workspace: path.dirname(root),
    root,
    aliasesPath: options.aliasesPath ?? path.join(root, 'aliases.json'),
    ...(options.globalRoot ? { globalRoot: options.globalRoot } : {}),
  });
  const proposals = readJson(proposalPath(root), []);
  if (!Array.isArray(proposals)) return { events: 0, table: 0, rejected: 0, voided: 0 };
  let state = await rebuildState(root, { ...config, recordRebuild: false });
  const updates = new Map();
  const tableAdds = [];
  const rejectedAdds = [];
  let events = 0;
  let voided = 0;

  for (const proposal of proposals) {
    if (!['event', 'table', 'reject'].includes(proposal.decision) || proposal.result) continue;
    const key = proposalKey(proposal);
    const target = latestTarget(state, proposal.target?.id);
    if (!target.event) {
      updates.set(key, { result: 'void:target_missing' });
      voided += 1;
      continue;
    }
    if (target.retracted) {
      updates.set(key, { result: 'void:target_retracted', resolvedTarget: target.id });
      voided += 1;
      continue;
    }

    if (proposal.decision === 'event') {
      const id = deterministicAliasId(target.id, proposal.phrase);
      if (!state.byId[id]) {
        await appendEvent(config, {
          id,
          kind: 'alias',
          text: `俗称审核通过：${proposal.phrase}`,
          refs: [target.id],
          aliases: [proposal.phrase],
          quote: redactAliasQuote(proposal.quote),
          proposal: {
            signal: proposal.signal,
            sess: proposal.sess,
            proposedAt: proposal.proposedAt,
          },
          scope: target.event.scope ?? 'local',
          src: 'review',
          sess: proposal.sess || 'alias-review',
        });
        state = await rebuildState(root, { ...config, recordRebuild: false });
        events += 1;
      }
      updates.set(key, { result: 'applied:event', resolvedTarget: target.id, eventId: id });
    } else if (proposal.decision === 'table') {
      tableAdds.push({
        phrase: proposal.phrase,
        terms: [target.event.key ?? target.event.text],
      });
      updates.set(key, { result: 'applied:table', resolvedTarget: target.id });
    } else {
      rejectedAdds.push({ ...proposal, resolvedTarget: target.id, rejectedAt: new Date().toISOString() });
      updates.set(key, { result: 'applied:reject', resolvedTarget: target.id });
    }
  }

  await withLock(root, 'apply-aliases', () => {
    const aliasesFile = options.aliasesPath ?? path.join(root, 'aliases.json');
    const aliases = aliasTable(readJson(aliasesFile, { version: 1, entries: [] }));
    for (const entry of tableAdds) {
      if (!aliases.entries.some((existing) => existing.phrase === entry.phrase)) {
        aliases.entries.push(entry);
      }
    }
    if (tableAdds.length > 0) {
      atomicWrite(aliasesFile, `${JSON.stringify(aliases, null, 2)}\n`);
    }

    const rejectedFile = path.join(root, 'alias-rejected.json');
    const rejectedValue = readJson(rejectedFile, []);
    const rejected = Array.isArray(rejectedValue) ? rejectedValue : [];
    for (const entry of rejectedAdds) {
      if (!rejected.some((existing) => proposalKey(existing) === proposalKey(entry))) {
        rejected.push(entry);
      }
    }
    if (rejectedAdds.length > 0) {
      atomicWrite(rejectedFile, `${JSON.stringify(rejected, null, 2)}\n`);
    }

    const currentValue = readJson(proposalPath(root), []);
    const current = Array.isArray(currentValue) ? currentValue : [];
    const kept = [];
    for (const proposal of current) {
      const update = updates.get(proposalKey(proposal));
      if (!update) {
        kept.push(proposal);
        continue;
      }
      if (proposal.decision === 'reject') continue;
      kept.push({ ...proposal, ...update });
    }
    atomicWrite(proposalPath(root), `${JSON.stringify(kept, null, 2)}\n`);
  }, config);

  return {
    events,
    table: tableAdds.length,
    rejected: rejectedAdds.length,
    voided,
  };
}
