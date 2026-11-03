import os from 'node:os';
import path from 'node:path';

// 默认值只在这里出现，避免宿主配置、工具实现和测试各自形成一套事实。
export const DEFAULTS = Object.freeze({
  localRoot: '.dsh-mem',
  globalRoot: path.join('~', '.dsh', 'owner-memory'),
  injectMaxChars: 1200,
  recallLimit: 4,
  recallMaxChars: 800,
  foldAtLines: 20_000,
  foldAtBytes: 8 * 1024 * 1024,
  foldRetentionMs: 180 * 24 * 60 * 60 * 1000,
  staleLockMs: 15_000,
  retryDelaysMs: Object.freeze([0, 20, 60, 120, 240]),
  // 440ms 只够空闲机器走一轮；2000ms 允许高负载调度，且远小于 15s 陈旧阈值。
  lockMaxWaitMs: 2_000,
  // 交接等待独立于退避节奏，避免当前进程释放后立刻再次抢回锁。
  handoffMs: 60,
  dedupWindowMs: 7 * 24 * 60 * 60 * 1000,
  dedupDuplicateThreshold: 0.85,
  dedupWarningThreshold: 0.55,
  maxTextChars: 200,
  maxTags: 5,
  maxRefs: 3,
  defaultScope: 'local',
  defaultSrc: 'agent',
  defaultWeight: 2,
  // 哪些 agent preset 本来就应该引用 {{owner_memory}}。只有名单里的 preset 才会在
  // 「没引用变量」时判为注入缺失——否则创造模式这类不接线的 preset 会一直误报。
  wiredPresets: Object.freeze([]),
});

export function expandHome(value, home = os.homedir()) {
  if (value === '~') return home;
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
}

export function resolveConfig(options = {}) {
  const workspace = path.resolve(options.workspace ?? process.cwd());
  const localSetting = options.root ?? DEFAULTS.localRoot;
  const globalSetting = options.globalRoot ?? DEFAULTS.globalRoot;

  return Object.freeze({
    ...DEFAULTS,
    ...options,
    workspace,
    // 相对 root 表示「每个会话各自一份」；绝对 root 是主人指定的固定位置。
    localRootRelative: !path.isAbsolute(localSetting),
    localRelative: localSetting,
    localRoot: path.isAbsolute(localSetting)
      ? path.normalize(localSetting)
      : path.resolve(workspace, localSetting),
    globalRoot: path.resolve(expandHome(globalSetting, options.home ?? os.homedir())),
    retryDelaysMs: [...(options.retryDelaysMs ?? DEFAULTS.retryDelaysMs)],
    wiredPresets: [...(options.wiredPresets ?? DEFAULTS.wiredPresets)],
  });
}

/**
 * 2026-11-03 落点修正：插件 `apply` 跑在宿主进程里，`process.cwd()` 是 profile 目录
 * （`~/.dsh/profiles/desktop`），不是会话工作区。所以 `root: '.dsh-mem'` 会在 apply
 * 那一刻被解析成 `profiles/desktop/.dsh-mem`——设计里写的是「相对工作区」。
 *
 * 会话工作区要到 agent 建出来才有（`agent.session.header.cwd`），而且会话中途还能换。
 * 所以不在这里做一次性解析，而是把「按 agent 重算」做成纯函数：工具执行和提示词注入
 * 各自在拿到 agent 的那一刻调一次。绝对 root 不动（那是主人显式指定的位置）。
 */
export function configForWorkspace(config, workspace) {
  if (!config?.localRootRelative || !workspace) return config;
  const resolved = path.resolve(workspace);
  if (resolved === config.workspace) return config;
  return Object.freeze({
    ...config,
    workspace: resolved,
    localRoot: path.resolve(resolved, config.localRelative ?? DEFAULTS.localRoot),
  });
}

/** 会话的工作目录；三种字段名是不同宿主版本留下的，照 dsh-fish 的兜底顺序取。 */
export function agentWorkspace(agent) {
  return agent?.session?.header?.cwd ?? agent?.header?.cwd ?? agent?.session?.cwd ?? '';
}

export function configForAgent(config, agent) {
  return configForWorkspace(config, agentWorkspace(agent));
}

/** 工具执行上下文里的 `exec.agent` 是本次调用的发起者；没有就不改根。 */
export function configForExec(config, exec) {
  return configForAgent(config, exec?.agent);
}

export function rootForScope(config, scope = 'local') {
  return scope === 'global' ? config.globalRoot : config.localRoot;
}
