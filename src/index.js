import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAblation } from './ablation.js';
import { configForAgent, configForExec, resolveConfig } from './config.js';
import { deriveState } from './derive.js';
import { createTools } from './host.js';
import { renderPinned } from './l0.js';
import { initRoot, persistPinnedHealth, readJson, updateHealth } from './storage/files.js';
import { readArchiveEvents, readEvents } from './storage/event-log.js';

/**
 * 加载探针。
 *
 * 为什么留在代码里：这套插件在真宿主上失败过两次「彻底静默」——没工具、没日志、没报错。
 * 而 Electron 主进程的 stdout 拿不到，`--dump-config` 又被 desktop profile 独占挡住，
 * 排查时没有任何抓手。这一行把「模块被 import 了」「apply 进来了」写在固定文件里，
 * 不依赖任何日志系统，重启一次就能知道卡在哪一步。开销是一次 appendFileSync（几毫秒）。
 * 想关掉就设 DSH_OWNER_MEM_PROBE=off。
 */
const PROBE_DIR = process.env.DSH_OWNER_MEM_PROBE_DIR
  ?? path.join(os.tmpdir(), 'dsh-owner-memory');
const PROBE_FILE = path.join(PROBE_DIR, 'load-probe.log');
function probe(stage, extra = '') {
  if (String(process.env.DSH_OWNER_MEM_PROBE ?? '').toLowerCase() === 'off') return;
  try {
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    fs.appendFileSync(PROBE_FILE, `${new Date().toISOString()} ${stage} pid=${process.pid} cwd=${process.cwd()} ${extra}\n`);
  } catch {
    // 探针写不进去绝不影响加载
  }
}
probe('import');

export const name = 'dsh-owner-memory';

/**
 * 只声明宿主作用域真有的服务。
 *
 * 2026-11-02 试装踩的坑：初版写的是 `inject = ['systemPrompt', 'tools']`，结果插件
 * **彻底静默**——没有工具、没有日志、没有报错，`.dsh-mem` 也没被创建。
 * 原因：`systemPrompt` 是 **agent 作用域**的服务，插件作用域里不可达；而 cordis 的
 * inject 是静态声明，服务不可达时插件是「无限等待」，不是「报错退出」。
 * 对照 dsh-fish（工具能在 agent 里看见的那个）：它的 inject 是
 * `['sessionController', 'tools', 'webServer', 'connection']`，同样不含 systemPrompt，
 * 提示词相关的段与变量全部在 `agent/created` 钩子里用 `agent.ctx.systemPrompt` 挂。
 * 所以这里只留 tools，systemPrompt 改走每 agent 的钩子。
 */
export const inject = ['tools'];

const VARIABLE_NAME_FALLBACK = 'owner_memory';
const SECTION_NAME = 'owner-memory';
/** 排在宿主的部署人设段之后（order 越大越靠后）；数值只影响顺序，不影响正确性。 */
const SECTION_ORDER = 900;
const PERSONA_SECTIONS = new Set([
  'deployment:persona-prefix',
  'deployment:persona-suffix',
]);
const INJECTION_TTL_MS = 30 * 60 * 1000;
const INJECTION_MAX_ENTRIES = 32;

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/u)[0]?.trim() ?? '';
}

function agentIdFor(agent) {
  const value = agent?.id ?? agent?.session?.id ?? agent?.session?.header?.id;
  return value == null || value === '' ? null : String(value);
}

function injectionKeyForAgent(agent) {
  const agentId = agentIdFor(agent);
  return agentId === null ? null : `${process.pid}:${agentId}`;
}

function personaSegments(assembly) {
  if (!assembly || typeof assembly !== 'object') return [];
  return [...(assembly.sections ?? []), ...(assembly.contexts ?? [])]
    .filter((item) => PERSONA_SECTIONS.has(item?.name));
}

function referencesVariable(segment, variableName) {
  return typeof segment?.text === 'string'
    && segment.text.includes(`{{${variableName}}}`);
}

function personaHash(segments) {
  const stable = segments.map((segment) => ({
    name: segment.name,
    text: String(segment.text ?? ''),
    interpolate: segment.interpolate !== false,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

/**
 * 只根据 system-prompt/assemble 可见的确定证据判定。
 * complete section 会在 waterfall 返回后恢复，因此段消失只能 deferred，不能判 missing。
 */
export function judgeInjection({
  input,
  output,
  variableName = VARIABLE_NAME_FALLBACK,
  observation,
  pinnedHead = '',
  stickyOk = new Set(),
} = {}) {
  const inputPersona = personaSegments(input);
  const referenced = inputPersona.filter((segment) => referencesVariable(segment, variableName));
  const hash = referenced.length > 0 ? personaHash(referenced) : null;
  const base = { personaHash: hash, references: referenced.length > 0 };

  if (referenced.length === 0) {
    return { ...base, verdict: 'n/a', reason: 'no_reference', writable: false };
  }
  if (observation?.called && !observation.error && observation.empty) {
    return { ...base, verdict: 'n/a', reason: 'provider_empty', writable: false };
  }
  if (!Object.hasOwn(input?.variables ?? {}, variableName)) {
    return { ...base, verdict: 'missing', reason: 'not_registered', writable: true };
  }
  if (referenced.some((segment) => segment.interpolate === false)) {
    return { ...base, verdict: 'missing', reason: 'interpolate_off', writable: true };
  }
  if (observation?.error) {
    return { ...base, verdict: 'missing', reason: 'provider_error', writable: true };
  }

  const outputPersona = personaSegments(output);
  const head = observation?.head || pinnedHead;
  const outputHasHead = head.length > 0
    && outputPersona.some((segment) => String(segment.text ?? '').includes(head));
  const referencedNames = new Set(referenced.map((segment) => segment.name));
  const outputNames = new Set(outputPersona.map((segment) => segment.name));
  const referencedStillPresent = [...referencedNames].every((name) => outputNames.has(name));

  if (
    observation?.called
    && !observation.error
    && !observation.empty
    && head.length > 0
    && String(observation.value ?? '').includes(head)
    && referencedStillPresent
  ) {
    return { ...base, verdict: 'ok', reason: 'provider_observed', writable: true };
  }
  if (hash && stickyOk.has(hash)) {
    return { ...base, verdict: 'ok', reason: 'cached', writable: true };
  }
  if (outputHasHead) {
    return { ...base, verdict: 'ok', reason: 'output_contains_head', writable: true };
  }

  const disappeared = referenced.some((segment) => !outputNames.has(segment.name));
  return {
    ...base,
    verdict: 'deferred',
    reason: disappeared ? 'persona_disappeared' : 'no_positive_evidence',
    writable: false,
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows 上 EPERM 表示进程存在但当前用户无权发信号；只有 ESRCH 才能证明不存在。
    return error?.code !== 'ESRCH';
  }
}

function persistInjectionVerdict(root, key, result) {
  const now = Date.now();
  const ts = new Date(now).toISOString();
  return updateHealth(root, (health) => {
    const source = health.injection && typeof health.injection === 'object'
      ? health.injection
      : {};
    const deadPids = new Set();
    for (const entry of Object.values(source)) {
      if (!processIsAlive(entry?.pid)) deadPids.add(entry?.pid);
    }
    const entries = Object.fromEntries(Object.entries(source).filter(([, entry]) => (
      entry
      && !deadPids.has(entry.pid)
      && Number.isFinite(Date.parse(entry.ts))
      && now - Date.parse(entry.ts) <= INJECTION_TTL_MS
    )));
    entries[key] = {
      personaHash: result.personaHash,
      verdict: result.verdict,
      reason: result.reason,
      ts,
      pid: process.pid,
    };
    const ordered = Object.entries(entries)
      .sort(([, left], [, right]) => Date.parse(right.ts) - Date.parse(left.ts))
      .slice(0, INJECTION_MAX_ENTRIES);
    const injection = Object.fromEntries(ordered);
    const missingCount = ordered.filter(([, entry]) => entry.verdict === 'missing').length;
    return {
      ...health,
      injection,
      injection_missing: missingCount > 0,
      injection_missing_count: missingCount,
    };
  });
}

/**
 * 安全地取一个宿主的服务。
 *
 * 2026-11-03 真桌面抓到的坑：cordis 的 ctx 是代理，**没有 inject 的服务在属性访问时就抛**，
 * 不是返回 undefined。所以 `ctx?.systemPrompt` 这种写法等于没保护。
 * 症状：apply 在 register-done 之后直接断，没有 apply-done、没有 agent/created，
 * 已注册的六个工具随插件作用域一起被销毁——外面只看到「一个工具都没有」。
 */
function safeGet(ctx, name) {
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

function loadState(config) {
  initRoot(config.localRoot);
  const stored = readJson(path.join(config.localRoot, 'state.json'), null);
  if (stored?.byId && stored?.status) return stored;
  const events = [
    ...readArchiveEvents(config.localRoot).events,
    ...readEvents(config.localRoot).events,
  ].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.id.localeCompare(right.id));
  return deriveState(events);
}

function addPendingWarning(config, result, agent) {
  if (!result || typeof result !== 'object') return result;
  const key = injectionKeyForAgent(agent);
  if (key === null) return result;
  const health = readJson(path.join(config.localRoot, 'health.json'), {});
  if (health.injection?.[key]?.verdict !== 'missing') return result;
  return {
    ...result,
    warnings: [
      ...(Array.isArray(result.warnings) ? result.warnings : []),
      '主人记忆未进入最终系统提示；请检查 persona 是否包含 {{owner_memory}}。',
    ],
  };
}

/** 读取记忆正文（带横幅）。文件为空时也要给路径，别让 agent 靠猜。 */
function makeProvider(config) {
  return () => {
    const memoryPath = path.join(config.localRoot, 'events.jsonl');
    const health = {};
    const ablation = readAblation(config.localRoot);
    const rendered = renderPinned(loadState(config), { health, ablation });
    // 配额指标必须落盘，否则 audit 永远读到默认值（见 files.js persistPinnedHealth）。
    try {
      persistPinnedHealth(config.localRoot, health);
    } catch {
      // health 写不进去不影响这一轮的注入
    }
    if (ablation === 'off') return '';
    return `【长期记忆 · ${memoryPath}】\n${rendered}`;
  };
}

/**
 * 注册到某个 tools 服务；同一个服务只注册一次（宿主级与 agent 级可能指向同一个）。
 *
 * 2026-11-03 改：逐个工具 try/catch + 探针。
 * 之前 `register()` 抛错（缺 `output`）会中断整个 apply，而宿主不给我们看日志，
 * 外面只看到「什么都没发生」。现在一个工具坏了不拖累其他五个，且名字和原因都落盘。
 */
function registerTools(toolsService, tools, config, seen) {
  if (!toolsService) return false;
  // 真宿主是 `register`（dsh-whale-loli memory.js:612 / dsh-fish 各工具）；
  // `registerTool` 只作为形状兼容保留，别让测试夹具反过来教坏实现。
  const register = typeof toolsService.register === 'function'
    ? toolsService.register.bind(toolsService)
    : typeof toolsService.registerTool === 'function'
      ? toolsService.registerTool.bind(toolsService)
      : null;
  if (!register) return false;
  if (seen.has(toolsService)) return true;
  seen.add(toolsService);
  let ok = 0;
  for (const tool of tools) {
    try {
      register({
        ...tool,
        // 健康告警按发起者工作区算，并按发起者 agent 判断它的人设到底接没接线。
        execute: async (...args) => addPendingWarning(
          configForExec(config, args[1]),
          await tool.execute(...args),
          args[1]?.agent,
        ),
      });
      ok += 1;
    } catch (error) {
      probe('register-throw', `tool=${tool.name} err=${error?.message ?? error}`);
    }
  }
  probe('register-done', `ok=${ok}/${tools.length}`);
  return ok > 0;
}

/**
 * 往一个 agent 上挂提示词注入 + 注入自检。
 *
 * 用 `agent.ctx.systemPrompt`（不是插件作用域的），因为提示词组装发生在 agent 作用域内。
 * 优先 `variable`（persona 里写 `{{owner_memory}}`），没有就退化成独立 section。
 */
function attachToAgent(agent, config, variableName, warn) {
  const sp = agent?.ctx?.systemPrompt;
  if (!sp) {
    warn('agent 上没有 systemPrompt，记忆注入已跳过。');
    return;
  }
  // 注入和自检都按这条会话自己的工作区算，不能再用 apply 时的 profile 目录。
  const bound = configForAgent(config, agent);
  const provider = makeProvider(bound);
  const providerObservations = new WeakMap();
  const agentId = agentIdFor(agent) ?? 'unknown';
  const healthKey = injectionKeyForAgent(agent) ?? `${process.pid}:unknown`;
  const checkState = {
    references: false,
    missing: false,
    head: '',
    okPersonaHashes: new Set(),
  };
  let suffixHinted = false;

  const read = (context) => {
    const observation = {
      called: true,
      error: null,
      value: undefined,
      head: '',
      empty: false,
      pending: null,
    };
    try {
      const value = provider();
      observation.value = value;
      observation.head = firstLine(value);
      observation.empty = value == null || String(value).trim() === '';
      checkState.head = observation.head;
      return value;
    } catch (error) {
      observation.error = error;
      // provider 先于 assemble；先挂起，等同一 context 的输入 assembly 给出引用证据。
      observation.pending = { verdict: 'deferred', reason: 'provider_error_unconfirmed' };
      // 保留 undefined，让宿主最终插值继续 fail-loud，同时允许中间件完成判定。
      return undefined;
    } finally {
      if ((typeof context === 'object' && context !== null) || typeof context === 'function') {
        providerObservations.set(context, observation);
      }
    }
  };

  try {
    if (typeof sp.variable === 'function') {
      sp.variable(variableName, read);
      probe('inject-variable', `name=${variableName}`);
    } else if (typeof sp.section === 'function') {
      sp.section({ name: SECTION_NAME, order: SECTION_ORDER, text: read });
      probe('inject-section', `name=${SECTION_NAME}`);
    } else {
      warn('agent.systemPrompt 既没有 variable 也没有 section，记忆注入已跳过。');
      return;
    }
  } catch (error) {
    warn(`挂载记忆注入失败：${error?.message ?? error}`);
    return;
  }

  const commit = (result) => {
    checkState.references = result.references;
    checkState.missing = result.verdict === 'missing';
    if (result.verdict === 'ok' && result.personaHash) {
      checkState.okPersonaHashes.add(result.personaHash);
    }
    if (!result.writable) return result;
    try {
      persistInjectionVerdict(bound.localRoot, healthKey, result);
      probe(
        'inject-verdict',
        `agent=${agentId} verdict=${result.verdict} reason=${result.reason}`,
      );
    } catch {
      // health 写不进去不影响这一轮
    }
    return result;
  };

  const install = () => {
    try {
      if (typeof agent.ctx.on === 'function') {
        agent.ctx.on('system-prompt/assemble', async (input, context, next) => {
          const output = await next();
          try {
            const inputPersona = personaSegments(input);
            const suffixReferenced = inputPersona.some((segment) => (
              segment.name === 'deployment:persona-suffix'
              && referencesVariable(segment, variableName)
            ));
            if (suffixReferenced && !suffixHinted) {
              suffixHinted = true;
              probe(
                'inject-suffix',
                `agent=${agentId} 建议把 {{${variableName}}} 移到 deployment:persona-prefix`,
              );
            }
            const canKeyContext = (
              (typeof context === 'object' && context !== null)
              || typeof context === 'function'
            );
            commit(judgeInjection({
              input,
              output,
              variableName,
              observation: canKeyContext ? providerObservations.get(context) : undefined,
              pinnedHead: checkState.head,
              stickyOk: checkState.okPersonaHashes,
            }));
          } catch {
            // 自检失败不许影响组装
          }
          return output;
        });
        return true;
      }
    } catch {
      // 静默降级
    }
    return false;
  };

  if (!install()) warn('宿主的提示词组装没有可挂的回调，注入自检不可用（注入本身照常）。');
}

export function apply(ctx, options = {}) {
  // 先各自安全取一次，下面都用取到的引用，别在 if 里再摸 ctx 的属性。
  const toolsService = safeGet(ctx, 'tools');
  const pluginPrompt = safeGet(ctx, 'systemPrompt');
  const on = safeGet(ctx, 'on');
  probe('apply-enter', `hasTools=${typeof toolsService?.register === 'function'} hasOn=${typeof on === 'function'}`);
  let config;
  try {
    config = resolveConfig({ ...options, probe });
  } catch (error) {
    probe('apply-throw', `stage=resolveConfig err=${error?.message ?? error}`);
    throw error;
  }
  // 兜底：插件作用域拿不到「会话工作区」，`root: '.dsh-mem'` 会按宿主进程 cwd 解析。
  // 万一 cwd 落在程序安装目录（Program Files / app.asar 里），往那儿写会 EPERM 或被下次升级抹掉。
  // 这种情况退到 ~/.dsh/owner-memory-local 并告警，至少不写到程序目录里。
  const appDir = path.dirname(process.execPath ?? '');
  const inInstallDir = appDir && (config.localRoot.startsWith(appDir) || config.localRoot.includes('app.asar'));
  if (inInstallDir) {
    const fallback = path.join(os.homedir(), '.dsh', 'owner-memory-local');
    console.warn(`[dsh-owner-memory] localRoot 落在程序安装目录（${config.localRoot}），改用 ${fallback}`);
    // 这是固定的兜底位置，不能再被「按会话工作区重算」拉回安装目录。
    config = {
      ...config,
      localRoot: fallback,
      localRootRelative: false,
      localRelative: fallback,
      ...(!config.aliasesPathExplicit ? { aliasesPath: path.join(fallback, 'aliases.json') } : {}),
    };
  }
  const variableName = options.variableName ?? config.variableName ?? VARIABLE_NAME_FALLBACK;
  // 一次性路径播报：装错地方时靠这行日志能看出来。
  console.log(`[dsh-owner-memory] localRoot=${config.localRoot} globalRoot=${config.globalRoot}`);
  probe('apply-config', `localRoot=${config.localRoot}`);

  const warn = (message) => console.warn(`[dsh-owner-memory] ${message}`);
  if (options.autoCreate === false && !fs.existsSync(config.localRoot)) {
    warn('autoCreate=false 且记忆目录不存在，本工作区不启用。');
    return;
  }

  const tools = createTools(config);
  const seen = new WeakSet();

  // 主通道：宿主作用域的 tools（dsh-fish 同款，agent 能看见）
  const hostRegistered = registerTools(toolsService, tools, config, seen);
  if (!hostRegistered) warn('ctx.tools.register 不可用，宿主级工具注册失败。');

  // 有的宿主把 systemPrompt 也放在插件作用域（预设里就是），能挂就顺手挂上
  if (pluginPrompt?.variable) {
    try {
      pluginPrompt.variable(variableName, makeProvider(config));
    } catch (error) {
      warn(`插件作用域挂变量失败：${error?.message ?? error}`);
    }
  }

  // 每个 agent 建好后：补挂到 agent 作用域（若与宿主不同）+ 挂提示词注入
  if (typeof on === 'function') {
    try {
      // 2026-11-03 第三次真桌面事故：宿主的事件 payload 是 `{ agent, source, signal }`，
      // 不是 agent 本身（契约见 agent/created 的 signature）。初版把 payload 当 agent 用，
      // 于是 `agent.ctx` 恒为 undefined → attachToAgent 直接跳过，注入一次都没挂上，
      // 探针里只留下 `agent-created ... cwd=?`。夹具当时也是直接传 agent，所以全绿。
      // 这次按契约解构；payload 形状不对就落一行探针，不再静默。
      on.call(ctx, 'agent/created', (payload) => {
        const agent = payload?.agent;
        if (!agent) {
          probe('agent-created-throw', `payload=${typeof payload}`);
          warn('agent/created 的 payload 里没有 agent，这一条会话的记忆注入已跳过。');
          return;
        }
        try {
          const bound = configForAgent(config, agent);
          probe('agent-created', `cwd=${bound.workspace || '?'} root=${bound.localRoot}`);
          registerTools(safeGet(safeGet(agent, 'ctx'), 'tools'), tools, config, seen);
          attachToAgent(agent, config, variableName, warn);
        } catch (error) {
          probe('agent-throw', `err=${error?.message ?? error}`);
          warn(`agent/created 处理失败：${error?.message ?? error}`);
        }
      });
    } catch (error) {
      warn(`注册 agent/created 失败：${error?.message ?? error}`);
    }
  } else {
    warn('ctx.on 不可用：无法在 agent 创建时挂载记忆注入，只有工具会生效。');
  }

  // 不返回任何东西：cordis 会把返回值当 effect disposer 去调用。
  probe('apply-done');
}

export default { name, inject, apply };
