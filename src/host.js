import path from 'node:path';
import { memAudit } from './audit.js';
import { DEFAULTS, configForExec, resolveConfig } from './config.js';
import { buildIndex } from './indexer.js';
import { loadAliasTable, recall } from './recall.js';
import { rebuildState } from './storage/event-log.js';
import { memFact } from './tools/mem_fact.js';
import { memFix } from './tools/mem_fix.js';
import { memNote } from './tools/mem_note.js';
import { readJson, updateHealth } from './storage/files.js';
import { vectorClientFor } from './vector/client.mjs';
import {
  cosineById,
  inspectVecIndex,
  scheduleVecIndexBuild,
} from './vector/vec-index.mjs';

/**
 * 关于 `output` 的历史坑（2026-11-03，真宿主上栽的）：
 *
 * 宿主的 `ctx.tools.register(definition)` 第一件事就是校验
 *   output must be `{ schema, render, presentationMeta? }`，
 * 缺了直接 `throw new TypeError`；而 `apply` 里没有兜住，错误被宿主吞掉，
 * 表现是「进程加载了、apply 进来了、六个工具一个都没有」——探针只停在 apply-enter。
 *
 * 我的假宿主测试只校验了 `tools.register` 存在，所以 88 个用例全绿，照样骗过了我。
 * 结论：**每个工具都必须声明 output**，`render` 返回 content parts（现由 dsh 投影成文本）。
 * 形状照 dsh-fish 的 her_recall 抄（它是本机唯一跑通的第三方工具）。
 */

/** 把工具返回值渲染成给模型看的文本；对象走 JSON，避免"看不见的字段"。 */
function textRender(out) {
  const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
  return [{ type: 'text', text }];
}

/**
 * 通用输出：不锁字段名。
 * 必须 `additionalProperties: true`：`index.js` 会在 execute 外面补一个 `warnings`，
 * 而 mem_note 的重复分支、mem_audit/mem_migrate 的多个分支返回的形状都不一样。
 */
const detailOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, out) => textRender(out),
};

/** 写入类：仓库里所有写入都收敛成 `{ id, status }`，把 id 摆在最前面（后面要拿它 revise/retract）。 */
function writtenOutput(prefix) {
  return {
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'status'],
      additionalProperties: true,
    },
    render: (_args, out) => [{ type: 'text', text: `${prefix}（${out.status}）id=${out.id}${Array.isArray(out.warnings) && out.warnings.length ? `\n提醒：${out.warnings.join('；')}` : ''}` }],
  };
}

const commonProperties = {
  tags: { type: 'array', items: { type: 'string', enum: ['偏好', '约定', '红线', '决策', '状态', '待办', '路径', '命令', '坑', '验证', '提议撤红线'] }, maxItems: 5 },
  weight: { type: 'integer', minimum: 1, maximum: 5 },
  scope: { type: 'string', enum: ['local', 'global'] },
  pin: { type: 'boolean' },
};
const aliasesProperty = {
  type: 'array',
  items: { type: 'string', minLength: 3, maxLength: 20, pattern: '^[^\\r\\n]+$' },
  minItems: 1,
  maxItems: 3,
};
const aliasQuoteProperty = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: '^[^\\r\\n]+$',
};

function recordVectorHealth(root, patch) {
  try {
    const current = readJson(path.join(root, 'health.json'), {});
    if (Object.entries(patch).every(([key, value]) => Object.is(current[key], value))) return;
    updateHealth(root, (health) => ({ ...health, ...patch }));
  } catch {
    // 向量健康状态写不进去不能拖垮字面召回。
  }
}

export async function prepareRecallVector(config, query) {
  const vectorConfig = { ...DEFAULTS.vector, ...(config.vector ?? {}) };
  if (vectorConfig.enabled === false || !query) return null;
  const runtime = config.vectorRuntime ?? {};
  const inspect = runtime.inspectVecIndex ?? inspectVecIndex;
  const schedule = runtime.scheduleVecIndexBuild ?? scheduleVecIndexBuild;
  const getCosines = runtime.cosineById ?? cosineById;
  const client = runtime.client ?? vectorClientFor({ modelDir: vectorConfig.modelDir });

  try {
    const inspected = await inspect(config.localRoot);
    if (inspected.status !== 'current') {
      recordVectorHealth(config.localRoot, { vec_index_stale: true });
      const build = schedule(config.localRoot, {
        encode: (texts, options) => client.encode(texts, options),
      });
      Promise.resolve(build).then((rebuilt) => {
        if (rebuilt) {
          recordVectorHealth(config.localRoot, {
            vec_index_stale: false,
            vector_disabled: null,
          });
        } else if (client.disabledReason) {
          recordVectorHealth(config.localRoot, {
            vector_disabled: client.disabledReason,
          });
        }
      }).catch((error) => {
        recordVectorHealth(config.localRoot, {
          vector_disabled: error?.message ?? String(error),
        });
      });
      return null;
    }

    const encoded = await client.encode([query], { query: true });
    if (!encoded?.[0]) {
      recordVectorHealth(config.localRoot, {
        vector_disabled: client.disabledReason ?? 'encoder unavailable',
      });
      return null;
    }
    const configuredFloor = vectorConfig.floor;
    const floor = Number.isFinite(configuredFloor)
      ? configuredFloor
      : inspected.index.metadata.cosineFloorP90;
    if (!Number.isFinite(floor)) throw new Error('vector index has no calibrated cosine floor');
    recordVectorHealth(config.localRoot, {
      vec_index_stale: false,
      vector_disabled: null,
    });
    return {
      cosById: getCosines(inspected.index, encoded[0]),
      floor,
      beta: vectorConfig.beta,
    };
  } catch (error) {
    recordVectorHealth(config.localRoot, {
      vector_disabled: error?.message ?? String(error),
    });
    return null;
  }
}

export function createTools(options = {}) {
  // `localRootRelative` 是 resolveConfig 的产物：带这个字段就说明已经是解析好的 config，
  // 不能再拿默认值重解析一遍（会把安装目录兜底那种显式 root 丢掉）。
  const config = options.localRootRelative === undefined ? resolveConfig(options) : options;
  return [
    {
      name: 'mem_fact',
      description: '只新增可变事实，不会原地改写。问“以后会有新版本使当前说法变假吗？”会就用它；改变事实时沿用同一 key。key 必须是「对象.方面」两段式（点号分隔，例如 cursor子代理.断线规律），不能只用连字符拼成一段。正例：包管理器、安装路径、作息；反例：历史坑、关键决策、红线。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'text'],
        properties: {
          key: { type: 'string', description: '事实键，必须“对象.方面”两段、点号分隔；不要把具体值写进键。' },
          text: { type: 'string', minLength: 1, maxLength: DEFAULTS.maxTextChars },
          headline: { type: 'string', minLength: 1, maxLength: 18, description: '可选结论，1–18 字且不含换行；提供后 L0 直接展示结论。不要在 headline 里写日期（日期由 L0 渲染负责，跨年会自动切 MM-DD/YY-MM-DD），也不要重复对象名（对象已由标签承载）。' },
          verifiedAt: { type: 'string', description: '可选验证时间，必须是带时区的 ISO8601；不能晚于当前时刻（容忍 60 秒时钟偏差）。' },
          aliases: aliasesProperty,
          aliasQuote: aliasQuoteProperty,
          ...commonProperties,
        },
      },
      output: writtenOutput('事实已记下'),
      execute: (args, exec) => memFact(configForExec(config, exec), args, exec),
    },
    {
      name: 'mem_note',
      description: '只新增无键事件，不会原地改写。带 tags:["坑"] 的 note 可提供 1–2 个 symptom（每个 2–8 字），用于报错前的坑类索引；写坑时顺手给 1–3 句 ask（用户会怎么问，每句 6–40 字），用于检索扩写，不写就只能靠症状词命中。两者仅限坑类 note，其它 kind 禁止提供。replaces 可取代 1–3 条 active、同 kind、非 fact 条目；目标无效报 E_REPLACES_TARGET，kind 不同或含 fact 报 E_REPLACES_KIND。会变化的事实必须用带同一 key 的 mem_fact。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text'],
        properties: {
          kind: { type: 'string', enum: ['note', 'rule', 'decision', 'todo'] },
          text: { type: 'string', minLength: 1, maxLength: DEFAULTS.maxTextChars },
          replaces: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
          symptom: {
            type: 'array',
            items: { type: 'string', minLength: 2, maxLength: 8, pattern: '^[^\\r\\n]+$' },
            minItems: 1,
            maxItems: 2,
          },
          ask: {
            type: 'array',
            items: { type: 'string', minLength: 6, maxLength: 40, pattern: '^[^\\r\\n]+$' },
            minItems: 1,
            maxItems: 3,
            description: '仅坑类 note：1–3 句用户口吻问法，每句 6–40 字，用于检索扩写。',
          },
          aliases: aliasesProperty,
          aliasQuote: aliasQuoteProperty,
          ...commonProperties,
        },
      },
      // 重复分支返回 { duplicate, id, ts, message }，没有 status，所以不能锁 required。
      output: detailOutput,
      execute: (args, exec) => memNote(configForExec(config, exec), args, exec),
    },
    {
      name: 'mem_fix',
      description: '只新增纠正动作，不会原地改写。旧记录当时就错了用 revise，整条作废用 retract，待办结束用 close。decision 不能 retract，请用 replaces 或 revise；rule 只有带主人原话 ownerQuote 才能 retract。retract 若会清空事实键，必须用 clearKey 显式确认。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'refs'],
        properties: {
          op: { type: 'string', enum: ['revise', 'retract', 'close'] },
          refs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
          text: { type: 'string', maxLength: DEFAULTS.maxTextChars },
          ownerQuote: { type: 'string', minLength: 1, maxLength: 200 },
          clearKey: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
        },
      },
      output: writtenOutput('纠正已记下'),
      execute: (args, exec) => memFix(configForExec(config, exec), args, exec),
    },
    {
      name: 'mem_recall',
      description: '按需召回，不修改记忆。不要无差别调用：仅在具体名词缺解释、用户回指“上次/之前”、副作用操作前有红线溢出、或追问历史原因时使用；闲聊、问候和纯代码生成不要调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          kinds: { type: 'array', items: { type: 'string' } },
          since: { type: 'string' },
          limit: { type: 'integer', minimum: 0, maximum: 12 },
          maxChars: { type: 'integer', minimum: 0, maximum: 1200 },
          includeSuperseded: { type: 'boolean' },
        },
      },
      output: detailOutput,
      execute: async (args = {}, exec) => {
        const bound = configForExec(config, exec);
        const sess = exec?.sessionId
          ?? exec?.sess
          ?? exec?.agent?.session?.header?.id
          ?? exec?.agent?.id;
        const localState = await rebuildState(bound.localRoot, { ...bound, recordRebuild: false });
        const globalState = await rebuildState(bound.globalRoot, { ...bound, recordRebuild: false });
        const aliases = loadAliasTable(bound.aliasesPath, { probe: bound.probe });
        const ruleChannel = Array.isArray(args.kinds) && args.kinds.length === 1 && args.kinds[0] === 'rule';
        const vec = ruleChannel ? null : await prepareRecallVector(bound, args.query ?? '');
        return recall(localState, buildIndex(localState, {
          symptomsInRecall: bound.symptomsInRecall,
        }), args.query ?? '', {
          ...args,
          ...(typeof sess === 'string' && sess ? { sess } : {}),
          aliases,
          symptomsInRecall: bound.symptomsInRecall,
          ...(!ruleChannel ? {
            limit: args.limit ?? bound.recallLimit,
            maxChars: args.maxChars ?? bound.recallMaxChars,
          } : {}),
          global: {
            state: globalState,
            index: buildIndex(globalState, { symptomsInRecall: bound.symptomsInRecall }),
          },
          log: bound.localRoot,
          ...(vec ? { vec } : {}),
        });
      },
    },
    {
      name: 'mem_audit',
      description: '只读审计，不修改记忆。查看最近召回回执、六类健康清单、某个 key 时间线、某个 id 引用链或开关状态。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['what'],
        properties: {
          what: { type: 'string', enum: ['recall', 'health', 'key', 'id', 'status'] },
          receipt_id: { type: 'string' },
          key: { type: 'string' },
          id: { type: 'string' },
          scope: { type: 'string', enum: ['local', 'global'] },
        },
      },
      output: detailOutput,
      execute: (args, exec) => memAudit(configForExec(config, exec), args),
    },
  ];
}

export function registerOwnerMemory(host, options = {}) {
  const tools = createTools(options);
  for (const tool of tools) host.registerTool(tool);
  return tools;
}
