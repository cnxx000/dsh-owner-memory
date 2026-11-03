const DAY_MS = 86_400_000;
const LIMITS = Object.freeze({
  total: 1200,
  rulesChars: 260,
  todosChars: 280,
  factsChars: 380,
  decisionsChars: 120,
});

function activeEntries(state, kind) {
  return Object.values(state.byId ?? {}).filter((event) => (
    event.kind === kind && state.status?.[event.id]?.status === 'active'
  ));
}

function descendingTime(left, right) {
  return Date.parse(right.ts) - Date.parse(left.ts) || left.id.localeCompare(right.id);
}

export function selectRules(state, { limit = 6 } = {}) {
  const sorted = activeEntries(state, 'rule').sort((left, right) => (
    (right.weight ?? 2) - (left.weight ?? 2)
    || descendingTime(left, right)
  ));
  return { selected: sorted.slice(0, limit), overflow: sorted.slice(limit) };
}

export function selectTodos(state, { limit = 5 } = {}) {
  return activeEntries(state, 'todo').sort(descendingTime).slice(0, limit);
}

function keyOrder(left, right) {
  if (left.key === right.key) return 0;
  return left.key < right.key ? -1 : 1;
}

export function selectFacts(state, { limit = 8, now = new Date() } = {}) {
  const candidates = [];
  for (const [key, id] of Object.entries(state.byKey ?? {})) {
    const event = state.byId?.[id];
    if (!event || event.kind !== 'fact' || state.status?.[id]?.status !== 'active') continue;
    const ageDays = (now.getTime() - Date.parse(event.ts)) / DAY_MS;
    const score = 0.8
      + 0.2 * (event.weight ?? 2)
      + (ageDays >= 0 && ageDays <= 30 ? 0.2 : 0)
      + (event.pin === true ? 0.3 : 0);
    const confirmCount = state.confirmCount?.[key] ?? state.confirmCount?.[id] ?? 0;
    candidates.push({ event, key, score, confirmCount });
  }
  return candidates
    .sort((left, right) => (
      right.score - left.score
      || right.confirmCount - left.confirmCount
      || keyOrder(left, right)
    ))
    .slice(0, limit)
    .map(({ event }) => event);
}

export function selectDecisions(state, { limit = 3 } = {}) {
  return activeEntries(state, 'decision').sort(descendingTime).slice(0, limit);
}

export function truncateLine(text, id, maxTextChars = 32) {
  const value = String(text);
  return value.length > maxTextChars
    ? `${value.slice(0, maxTextChars)}…(${id})`
    : `${value}(${id})`;
}

function renderLine(label, event, maxTextChars = 32) {
  const date = String(event.ts).slice(0, 10);
  const body = truncateLine(event.text, event.id, maxTextChars);
  return `[${label}] ${date} ${body}`;
}

function fitSection(label, events, maxChars) {
  const kept = [...events];
  const render = () => kept.map((event) => renderLine(label, event));
  let lines = render();
  while (kept.length > 0 && lines.join('\n').length > maxChars) {
    kept.pop();
    lines = render();
  }
  return { kept, lines };
}

function buildPinned(state, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  const health = opts.health ?? {};
  const rules = selectRules(state, { limit: 6 });
  const fullRuleChars = rules.selected
    .map((event) => renderLine('红线', event, Number.MAX_SAFE_INTEGER))
    .join('\n').length;
  let ruleTextLimit = 32;
  let ruleLines = rules.selected.map((event) => renderLine('红线', event, ruleTextLimit));
  health.rules_overflow = rules.overflow.length > 0
    || fullRuleChars > LIMITS.rulesChars
    || rules.selected.some((event) => String(event.text).length > ruleTextLimit);
  health.rules_truncated_hard = false;

  const todos = fitSection('在办', selectTodos(state), LIMITS.todosChars);
  const facts = fitSection('事实', selectFacts(state, { now }), LIMITS.factsChars);
  const decisions = fitSection('决策', selectDecisions(state), LIMITS.decisionsChars);
  const title = `## 关于主人（截至 ${now.toISOString().slice(0, 10)}）`;
  let footer = rules.overflow.length > 0
    ? `> 另有 ${rules.overflow.length} 条红线未常驻；任何写文件/改配置/跑命令之前，必须先 mem_recall(kinds=['rule'])。`
    : health.rules_overflow
      ? `> 红线内容已截断；任何写文件/改配置/跑命令之前，必须先 mem_recall(kinds=['rule'])。`
    : '> 更多细节用 mem_recall 查。';

  const compose = () => [
    title,
    ...ruleLines,
    ...todos.lines,
    ...facts.lines,
    ...decisions.lines,
    ...(footer ? [footer] : []),
  ].join('\n');

  let output = compose();
  // 保障顺序从低到高淘汰；红线不截断也不删除，无法满足时由硬断言拒绝输出。
  for (const section of [decisions, facts, todos]) {
    while (output.length > LIMITS.total && section.lines.length > 0) {
      section.lines.pop();
      output = compose();
    }
  }

  for (const hardLimit of [16, 8]) {
    if (output.length <= LIMITS.total) break;
    ruleTextLimit = hardLimit;
    ruleLines = rules.selected.map((event) => renderLine('红线', event, ruleTextLimit));
    health.rules_truncated_hard = true;
    output = compose();
  }

  if (output.length > LIMITS.total) {
    const withoutFooter = [
      title,
      ...ruleLines,
      ...todos.lines,
      ...facts.lines,
      ...decisions.lines,
    ].join('\n');
    const available = LIMITS.total - withoutFooter.length - 1;
    footer = available > 0
      ? `${footer.slice(0, Math.max(0, available - 1))}…`
      : '';
    output = compose();
  }

  if (output.length > LIMITS.total) {
    // 病态超长 id 仍可能顶穿预算；保留每条红线的存在性，但压缩其展示标识。
    const lineBudget = Math.max(
      '[红线] …'.length,
      Math.floor((LIMITS.total - title.length - rules.selected.length) / Math.max(1, rules.selected.length)),
    );
    ruleLines = rules.selected.map((event) => {
      const prefix = '[红线] ';
      const id = String(event.id);
      const room = Math.max(0, lineBudget - prefix.length - 1);
      return `${prefix}${id.slice(0, room)}…`;
    });
    footer = '';
    health.rules_truncated_hard = true;
    output = compose().slice(0, LIMITS.total);
  }
  // 文本和结构化 id 必须来自同一次选择与裁剪，否则召回层会把正文中的伪 id 当成常驻项。
  const ids = new Set([
    ...rules.selected.map((event) => event.id),
    ...todos.kept.slice(0, todos.lines.length).map((event) => event.id),
    ...facts.kept.slice(0, facts.lines.length).map((event) => event.id),
    ...decisions.kept.slice(0, decisions.lines.length).map((event) => event.id),
  ]);
  return { output, ids };
}

export function renderPinned(state, opts = {}) {
  return buildPinned(state, opts).output;
}

export function pinnedIds(state, opts = {}) {
  return buildPinned(state, opts).ids;
}

export function verifyInjection(systemPromptText, pinned) {
  const feature = String(pinned).split(/\r?\n/u)[0]?.trim() ?? '';
  const ok = feature.length > 0 && String(systemPromptText).includes(feature);
  return { ok, missing: !ok };
}

/**
 * 把一次 assembly 按宿主的方式渲染成文本，供注入自检判断。
 *
 * 2026-11-03 真桌面查明的假警报：`system-prompt/assemble` 是**结构化 assembly** 的
 * waterfall（sections / contexts / tools / variables），不是最终文本；`{{变量}}` 的插值
 * 发生在渲染阶段，assembly.sections[].text 里还是字面量。之前把 assembly 整个
 * `String()` 掉得到 `[object Object]`，includes 永远为假，于是 `injection_missing`
 * 每轮都报「主人记忆未进入系统提示」——其实提示里明明有。
 *
 * 这里照着宿主的插值规则（只认 `{{name}}`，interpolate:false 保持字面量）做一遍宽容渲染：
 * 未注册的变量原样保留，让自检以「没进去」为结果，而不是抛异常。
 */
export function renderAssemblyText(assembly) {
  if (assembly == null) return '';
  if (typeof assembly === 'string') return assembly;
  if (typeof assembly.text === 'string') return assembly.text;
  const variables = assembly.variables ?? {};
  const renderOne = (item) => {
    const text = String(item?.text ?? '');
    if (item?.interpolate === false) return text;
    return text.replace(/\{\{\s*([^{}\s]+)\s*\}\}/gu, (whole, name) => (
      Object.hasOwn(variables, name) ? String(variables[name] ?? '') : whole
    ));
  };
  const parts = [];
  for (const section of assembly.sections ?? []) parts.push(renderOne(section));
  for (const context of assembly.contexts ?? []) parts.push(renderOne(context));
  return parts.filter((text) => text.length > 0).join('\n\n');
}

/**
 * 这条 assembly 有没有引用某个 `{{变量}}`。
 *
 * 2026-11-03 的第二个坑：`injection_missing` 是**按工作区**存的，但「这条会话的
 * 人设有没有用记忆」是**按 agent** 的。创造模式的人设本来就没有 `{{owner_memory}}`，
 * 它每轮自检都如实报缺失，把鲸鱼娘那边刚写好的 false 又盖回 true；反过来也一样。
 * 所以先看这条 assembly 到底引用没引用：没引用的 preset 不予评判，也不写 health。
 */
export function assemblyReferencesVariable(assembly, variableName) {
  if (!assembly || typeof assembly !== 'object' || !variableName) return false;
  const escaped = String(variableName).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`\\{\\{\\s*${escaped}\\s*\\}\\}`, 'u');
  const items = [...(assembly.sections ?? []), ...(assembly.contexts ?? [])];
  return items.some((item) => typeof item?.text === 'string' && pattern.test(item.text));
}
