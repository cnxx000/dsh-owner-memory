import { memAudit } from './audit.js';
import { DEFAULTS, configForExec, resolveConfig } from './config.js';
import { buildIndex } from './indexer.js';
import { recall } from './recall.js';
import { rebuildState } from './storage/event-log.js';
import { memFact } from './tools/mem_fact.js';
import { memFix } from './tools/mem_fix.js';
import { memNote } from './tools/mem_note.js';

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
  tags: { type: 'array', items: { type: 'string', enum: ['偏好', '约定', '红线', '决策', '状态', '待办', '路径', '命令', '坑', '验证'] }, maxItems: 5 },
  weight: { type: 'integer', minimum: 1, maximum: 5 },
  scope: { type: 'string', enum: ['local', 'global'] },
  pin: { type: 'boolean' },
};

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
          ...commonProperties,
        },
      },
      output: writtenOutput('事实已记下'),
      execute: (args, exec) => memFact(configForExec(config, exec), args, exec),
    },
    {
      name: 'mem_note',
      description: '只新增无键事件，不会原地改写。问“以后会有新版本使当前说法变假吗？”不会才用它。正例：踩坑记录、关键决策、红线；反例：当前包管理器、当前路径、当前偏好；会变化的事实必须用带同一 key 的 mem_fact。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text'],
        properties: {
          kind: { type: 'string', enum: ['note', 'rule', 'decision', 'todo'] },
          text: { type: 'string', minLength: 1, maxLength: DEFAULTS.maxTextChars },
          ...commonProperties,
        },
      },
      // 重复分支返回 { duplicate, id, ts, message }，没有 status，所以不能锁 required。
      output: detailOutput,
      execute: (args, exec) => memNote(configForExec(config, exec), args, exec),
    },
    {
      name: 'mem_fix',
      description: '只新增纠正动作，不会原地改写。旧记录当时就错了用 revise，整条作废用 retract，待办结束用 close。事实后来变化必须用同 key 的 mem_fact；正例：纠错、撤销、关待办；反例：新偏好、新路径、新版本。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'refs'],
        properties: {
          op: { type: 'string', enum: ['revise', 'retract', 'close'] },
          refs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
          text: { type: 'string', maxLength: DEFAULTS.maxTextChars },
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
        const localState = await rebuildState(bound.localRoot, { ...bound, recordRebuild: false });
        const globalState = await rebuildState(bound.globalRoot, { ...bound, recordRebuild: false });
        const ruleChannel = Array.isArray(args.kinds) && args.kinds.length === 1 && args.kinds[0] === 'rule';
        return recall(localState, buildIndex(localState), args.query ?? '', {
          ...args,
          ...(!ruleChannel ? {
            limit: args.limit ?? bound.recallLimit,
            maxChars: args.maxChars ?? bound.recallMaxChars,
          } : {}),
          global: { state: globalState, index: buildIndex(globalState) },
          log: bound.localRoot,
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
