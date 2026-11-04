import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryError, supersedeText, validateEvent } from '../schema.js';
import { rebuildState } from '../storage/event-log.js';
import { initRoot } from '../storage/files.js';
import { withLock } from '../storage/lock.js';

export const P0_SUPERSEDE_PAIRS = Object.freeze([
  Object.freeze(['m_mw04dvx1_ef2e', 'm_mw07406r_e503']),
  Object.freeze(['m_mw04dvyh_c92b', 'm_mw074084_2ebf']),
  Object.freeze(['m_mw0de7kd_b3ff', 'm_mw0e2fk9_825d']),
  Object.freeze(['m_mw0e2fk9_825d', 'm_mw0sofv5_4f93']),
]);

export const P0_FACT_REPAIRS = Object.freeze([
  Object.freeze({
    sourceId: 'm_mw0sjom4_cbe7',
    key: 'bili账号.cookie位置',
    text: 'B站 cookie 存于 ~/.dsh-bili/cookie.txt，登录有效；账号 level=0 未转正，发言被拒（-107），bili_say 暂不可用。',
    tags: Object.freeze(['路径', '验证']),
    weight: 4,
  }),
  Object.freeze({
    sourceId: 'm_mw06tca2_cea9',
    key: 'injection-check.判定作用域',
    text: '注入自检按 agent 记 verdict（ok/missing/deferred）；只有 persona 段引用 owner_memory 才判，missing 只认 not_registered、interpolate_off、provider_error 三种确定信号。',
    tags: Object.freeze(['验证']),
    weight: 3,
  }),
]);

const ALLOWED_IDS = new Set([
  ...P0_SUPERSEDE_PAIRS.flat(),
  ...P0_FACT_REPAIRS.map((repair) => repair.sourceId),
]);
const ALLOWED_PAIRS = new Set(P0_SUPERSEDE_PAIRS.map(([oldId, newId]) => `${oldId}|${newId}`));
const FACT_BY_SOURCE = new Map(P0_FACT_REPAIRS.map((repair) => [repair.sourceId, repair]));

function migrationId(seed) {
  return `m_mig_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 10)}`;
}

function assertAllowedId(id) {
  if (!ALLOWED_IDS.has(id)) {
    throw new MemoryError('E_MIGRATE_WHITELIST', `P0 历史迁移拒绝白名单外 id：${id}`, { id });
  }
}

export function createSupersedeEvent(oldId, newId, ts = new Date().toISOString()) {
  assertAllowedId(oldId);
  assertAllowedId(newId);
  if (!ALLOWED_PAIRS.has(`${oldId}|${newId}`)) {
    throw new MemoryError('E_MIGRATE_WHITELIST', `P0 历史迁移拒绝未批准的取代关系：${oldId} -> ${newId}`, {
      oldId,
      newId,
    });
  }
  const event = {
    id: migrationId(`${oldId}|${newId}`),
    ts,
    kind: 'supersede',
    text: supersedeText(oldId, newId),
    weight: 2,
    refs: [oldId, newId],
    scope: 'local',
    src: 'migrate:p0',
    sess: 'migrate:p0',
  };
  return validateEvent(event);
}

export function createFactRepairEvent(sourceId, ts = new Date().toISOString()) {
  assertAllowedId(sourceId);
  const repair = FACT_BY_SOURCE.get(sourceId);
  if (!repair) {
    throw new MemoryError('E_MIGRATE_WHITELIST', `P0 历史迁移没有批准该 id 的事实修复：${sourceId}`, {
      sourceId,
    });
  }
  const event = {
    id: migrationId(`fact|${sourceId}`),
    ts,
    kind: 'fact',
    text: repair.text,
    key: repair.key,
    tags: [...repair.tags],
    weight: repair.weight,
    refs: [sourceId],
    scope: 'local',
    src: 'migrate:p0',
    sess: 'migrate:p0',
  };
  return validateEvent(event);
}

function physicalLineCount(bytes) {
  return bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).length;
}

function parseJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function persistedEvents(root) {
  const events = parseJsonl(path.join(root, 'events.jsonl'));
  const archiveRoot = path.join(root, 'archive');
  for (const name of fs.readdirSync(archiveRoot).filter((item) => /^\d{4}-Q[1-4]\.jsonl$/u.test(item)).sort()) {
    events.push(...parseJsonl(path.join(archiveRoot, name)));
  }
  return events;
}

function sameMigrationPayload(left, right) {
  return left.id === right.id
    && left.kind === right.kind
    && left.text === right.text
    && left.key === right.key
    && JSON.stringify(left.refs ?? null) === JSON.stringify(right.refs ?? null)
    && left.src === right.src;
}

export function plannedP0Events(ts = new Date().toISOString()) {
  return [
    ...P0_SUPERSEDE_PAIRS.map(([oldId, newId]) => createSupersedeEvent(oldId, newId, ts)),
    ...P0_FACT_REPAIRS.map(({ sourceId }) => createFactRepairEvent(sourceId, ts)),
  ];
}

export async function migrateP0History(root, options = {}) {
  if (typeof root !== 'string' || !root) {
    throw new MemoryError('E_SCHEMA', 'P0 历史迁移必须显式提供 --root');
  }
  const resolvedRoot = path.resolve(root);
  initRoot(resolvedRoot);
  const ts = new Date(options.now ?? Date.now()).toISOString();
  const planned = plannedP0Events(ts);
  let result;

  await withLock(resolvedRoot, 'migrate-p0-history', () => {
    const eventFile = path.join(resolvedRoot, 'events.jsonl');
    const before = fs.readFileSync(eventFile);
    const persisted = persistedEvents(resolvedRoot);
    const byId = new Map(persisted.filter((event) => event?.id).map((event) => [event.id, event]));
    const missingSources = [...ALLOWED_IDS].filter((id) => !byId.has(id));
    if (missingSources.length > 0) {
      throw new MemoryError('E_REF_NOT_FOUND', `P0 历史迁移缺少白名单源事件：${missingSources.join(', ')}`, {
        missing: missingSources,
      });
    }

    const added = [];
    const skipped = [];
    for (const event of planned) {
      const existing = byId.get(event.id);
      if (existing) {
        if (!sameMigrationPayload(existing, event)) {
          throw new MemoryError('E_MIGRATE_CONFLICT', `迁移 id 已存在但内容不符：${event.id}`, {
            id: event.id,
          });
        }
        skipped.push(event.id);
      } else {
        added.push(event);
      }
    }

    if (added.length > 0) {
      const separator = before.length > 0 && before.at(-1) !== 0x0a ? '\n' : '';
      const lines = added.map((event) => JSON.stringify(event)).join('\n');
      fs.appendFileSync(eventFile, `${separator}${lines}\n`, 'utf8');
    }
    const after = fs.readFileSync(eventFile);
    result = {
      root: resolvedRoot,
      beforeLines: physicalLineCount(before),
      afterLines: physicalLineCount(after),
      added,
      skipped,
    };
  }, options);

  const state = await rebuildState(resolvedRoot, { ...options, recordRebuild: false });
  return { ...result, state };
}

function cliRoot(argv) {
  if (argv.length !== 2 || argv[0] !== '--root' || !argv[1]) {
    throw new MemoryError('E_SCHEMA', '用法：node src/migrate/p0-history.js --root <副本中的 .dsh-mem 目录>');
  }
  return argv[1];
}

async function main() {
  const result = await migrateP0History(cliRoot(process.argv.slice(2)));
  for (const event of result.added) console.log(JSON.stringify(event));
  console.log(JSON.stringify({
    beforeLines: result.beforeLines,
    afterLines: result.afterLines,
    added: result.added.length,
    skipped: result.skipped.length,
  }));
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(JSON.stringify({ code: error.code ?? 'E_MIGRATE', message: error.message }));
    process.exitCode = 1;
  });
}
