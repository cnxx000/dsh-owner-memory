# dsh-owner-memory

给 DeepSeek Harness（DSH）用的本地长期记忆插件。五个工具、每轮注入一小块 L0、全部派生品可重建。

记忆正文只存在**你自己的工作区**里（`<workspace>/.dsh-mem/events.jsonl`），本仓库不含任何记忆内容，也没有任何网络请求：所有工具都在宿主进程内直接读写本地文件。

## 它解决什么问题

模型的上下文是有限的，长期记忆不能整本塞进去。这个插件把「记得住」拆成三层：

| 层 | 是什么 | 谁来决定 |
|---|---|---|
| L1 | 真相源 `events.jsonl`，只追加 | 每次 `mem_*` 写入 |
| L0 | 每轮都要知道的：红线 / 在办 / 高分事实 / 最近决策，硬上限 **1200 字符** | 渲染时按预算仲裁 |
| L2 | 这次问话才需要的：`mem_recall` 按需召回 | 查询与打分 |

L0 通过 persona 的 `{{owner_memory}}` 变量进系统提示；L2 靠工具调用。三层各自独立，删掉派生品（`state.json` / `index.json` / `pinned.md`）只影响当前这一轮的效果，不影响任何事实。

## 五个工具

| 工具 | 读写 | 作用 |
|---|---|---|
| `mem_fact` | 写 | 带键的事实，**同键覆盖**（`对象.方面` 两段式） |
| `mem_note` | 写 | 无键追加：`note` / `rule` / `decision` / `todo` |
| `mem_fix` | 写 | 纠正：`revise` / `retract` / `close`，必带 `refs` |
| `mem_recall` | 读 | 按需召回，返回带回执编号 |
| `mem_audit` | 读 | 审计：召回回执 / 六类体检 / 键时间线 / id 引用链 / 开关状态 |

**可选参数**（2026-11-04 新增）：

| 参数 | 用在 | 说明 |
|---|---|---|
| `aliases` + `aliasQuote` | `mem_fact` / `mem_note` | 给条目挂「俗称」（1–3 条）。**只生成提案**，不会立刻影响召回；主人审过之后才由 `scripts/apply-aliases.mjs` 落成 `kind=alias` 事件 |
| `replaces` | `mem_note` | 声明本条取代哪些旧条目（同 kind、不含 `fact`、目标须 active）。它不是「引用」：不给被取代方加分，被取代方变 `superseded`，撤销新条时自动复活 |
| `ownerQuote` | `mem_fix` | 撤一条 `rule` 时必须带主人的原话（≤200 字），否则 `E_RULE_RETRACT_FORBIDDEN` |
| `clearKey` | `mem_fix` | 当一次撤销会让某个键失去当前值、且没有更早的值可回退时，必须显式声明要清空哪个键 |

## 别名与俗称

两条互补的路，管的是不同的失败模式：

| | 文件 / 字段 | 管什么 | 怎么生效 |
|---|---|---|---|
| 别名表 | `.dsh-mem/aliases.json`（真相源，手工维护） | 「人话 → 代码标识符」，例如 `养鱼的插件 → dsh-fish` | 查询命中短语后，把目标词的 bigram 以 0.8 折并入召回词元 |
| 俗称 | 事件上的 `aliases` 字段 / 内部 `kind=alias` 事件 | 同一条目在自然语言里的别叫法 | 只对**已批准**的俗称生效：查询整句包含该短语时加 `min(8, 2L)` |

俗称的完整流程：写入时带 `aliases` + `aliasQuote` → 只进 `.dsh-mem/alias-proposals.json`（每会话最多 3 条，失败只给 warning、正文照常写）→ 主人审 → `node scripts/apply-aliases.mjs` 落盘。挖历史 miss 用 `node scripts/mine-aliases.mjs`，它按「换说法 / 空召回 / 只撞旧条目 / 弱命中」四类信号产提案。

`.dsh-mem/` 里还有三种**内部事件**，不注册成工具、不进召回候选：`supersede`（历史迁移用）、`alias`（俗称）、`confirm`（去重命中时的确认，derive 累计成 `confirmCount`）。

## L0 预算（硬约束）

总预算 1200 字符，分段配额合计恰好 1200：

| 段 | 条数 | 字符 | 溢出时 |
|---|---|---|---|
| 红线 `rule` | 6 | 300 | 按 `weight` 取前 6，其余进 `mem_recall(kinds=['rule'])` 强制通道 |
| 在办 `todo` | 5 | 280 | 保留最近的 |
| 事实 `fact` | 8 | 340 | 低分先出局（打分见下） |
| 决策 `decision` | 3 | 120 | 保留最近的 |
| 标题 + 尾注 | — | 160 | — |

- 事实行有两种：带 `headline` 的渲染成 `[主人|项目] <日期> <对象简称>.<方面段>：<headline>`（结论可见、不带 id）；不带的沿用旧格式 `[项目] YY-MM-DD <正文前 32 字>…(<id>)`；
- 淘汰顺序 **决策 → 事实 → 在办**，红线永不缺省；真顶穿时红线正文会被压到 16 / 8 字符（记 `rules_truncated_hard`）；
- 事实段不套召回公式：`score = 0.8 + 0.2×weight + 0.2(30 天内) + 0.3(pin)`，同分按 `confirmCount` 降序、`ts` 升序、`id` 升序兜底（保证同一份库每轮渲染结果稳定，不打穿 prompt cache）；
- **`fact_overflow` 记两类键**：排名第 9 起的，以及前 8 名里因为字数/总预算没被渲染出来的——后者以前是静默蒸发的。

## 健康指标

`mem_audit(what="health")` 里的关键字段：

| 字段 | 什么时候为 `true` | 该做什么 |
|---|---|---|
| `rules_overflow` | 有红线被挤出前 6，或红线全文字符超预算，或任一条超 32 字 | 看 L0 尾注分辨是「溢出」还是「截断」；前者先 `mem_recall(kinds=['rule'])` |
| `rules_truncated_hard` | 红线正文被压到 16 / 8 字符 | 红线写太长了，删/合并或把细节挪进 `note` |
| `injection_missing` | 当前 agent 的注入判定为 `missing`（人设引用了变量，但变量没注册、或引用段 `interpolate=false`、或 provider 抛错） | 先看 `mem_audit(what="health")` 里的 per-agent 明细与 `reason`；`deferred` 不算缺失 |
| `vec_index_stale` | `events.jsonl` 与向量索引版本不一致 | 当前轮自动退回纯字面；后台重建成功后下一轮恢复（向量默认关闭，一般不会出现） |
| `vector_disabled` | 模型缺失、加载失败或启动超时 | 当前轮自动退回纯字面；按记录的原因修模型安装（向量默认关闭） |
| `fact_overflow` | 有事实键没进 L0（第 9 名起，或前 8 名被字数挤掉） | 给这些键补 `headline` 或降权；值本身仍可用 `mem_recall` 取 |
| `fact_headline_missing` | 入选 L0 但没写 `headline` 的键 | 用同一个 key 重写一条带 `headline` 的事实 |
| `fact_label_long` | 标签 + headline 超 26 字 | 把 headline 改短（18 字以内） |
| `pit_symptom_missing` | active 且带「坑」tag，但既没症状词也没问法的条目 | 补 `symptom` / `ask`，否则坑类索引里不会提示到它 |
| `pit_overflow` | 坑类门铃行里没放下的类别词 | 只影响提示宽度，不影响召回；需要时改 `.dsh-mem/pit-categories.txt` |
| `ablation` | 当前生效的消融档位（`none` / `no-pit` / `off`） | 只在评测时由 `.dsh-mem/flags/ablation` 控制，正常应为 `none` |

前三个注入/L0 指标**每轮重算重写**，不是历史累积值；尾注与指标口径必须一致，不一致就是落盘链路断了。

## 安装

以 DSH 桌面版为例（`~/.dsh/profiles/<你的 profile>`）：

1. 把本仓库加进 profile 的 `package.json` 依赖：

   ```json
   "dsh-owner-memory": "github:cnxx000/dsh-owner-memory#v0.1.0"
   ```

   公开仓库走 `github:` 协议即可，npm 不需要额外凭证。本机开发想边改边验，可以改用本地路径（注意 `link:` 是 pnpm 的写法，npm 用 `file:`）：

   ```json
   "dsh-owner-memory": "file:C:/path/to/owner-memory"
   ```

2. 若你的 DSH 版本要求显式声明 bundle，把 `dsh-owner-memory` 加进 `dsh.profile.bundles`；不要求的话装进依赖即可。
3. 在 profile 目录执行 `npm install`。
4. 让 persona 引用记忆变量：在 persona 模板里写 `{{owner_memory}}`。如果 persona 是 `complete: true`（独立 section 会被丢弃），必须走变量通道。
5. 配置 `wiredPresets`（见下表）填你的 preset id。留空也能工作——引用了变量就会被判定；填了才能抓到「人设本该接线却被改坏」这类回归。
6. 重启 DSH。

插件自己的加载探针写在系统临时目录：`<tmp>/dsh-owner-memory/load-probe.log`，会在 `import` / `apply-enter` / `register-done ok=N/N` / `apply-done` 各留一行。排查「插件装了但工具没出现」时先看它。设 `DSH_OWNER_MEM_PROBE=off` 可关掉。

## 配置项

见仓库根的 [`cordis.patch.yml`](cordis.patch.yml)：

| 键 | 默认 | 说明 |
|---|---|---|
| `row` | `memory` | persona 变量所在行 |
| `root` | `.dsh-mem` | 工作区内的记忆根目录 |
| `globalRoot` | `~/.dsh/owner-memory` | `scope: global` 的记忆根目录 |
| `variableName` | `owner_memory` | 注入用的变量名，与 persona 里写的保持一致 |
| `wiredPresets` | `[]` | 声明「这些人设应该引用记忆」的 preset id 列表 |
| `injectMaxChars` | `1200` | L0 硬上限 |
| `recallLimit` | `4` | 单次召回默认条数 |
| `recallMaxChars` | `800` | 单次召回字符上限 |
| `symptomsInRecall` | `true` | 默认开启，把坑条目的症状词和问法并入召回检索文本；关闭时检索行为与旧版一致 |
| `vector.enabled` | `false` | 是否启用向量第二信号。**默认关闭**：2026-11-04 实测 C 组 0/4、p95 569ms，未达止损线；改这里可复测，评估脚本 `scripts/vec-eval.mjs` |
| `vector.floor` | `null` | 手工覆盖余弦 floor；`null` 使用索引里记的 query-doc p90 |
| `vector.beta` | `0.5` | 向量融合系数 |
| `vector.modelDir` | `~/.dsh/owner-memory/models/bge-small-zh-v1.5@75c43b0` | 固定模型目录 |
| `aliasesPath` | `.dsh-mem/aliases.json` | 别名表（真相源，手工维护） |
| `lockMaxWaitMs` | `5000` | 跨进程锁的最大等待；满负载下 2000 会让 40 并发写超时，故上调 |
| `foldAtLines` | `20000` | 事件流到多少行触发折叠（折叠前自动快照） |

### 消融开关（只用于评测）

`.dsh-mem/flags/ablation` 里写 `no-pit` 会跳过 L0 的坑类门铃行，写 `off` 会让整块长期记忆不注入；文件不存在或内容无法识别时按正常渲染。当前档位记在 `health.ablation`。做完评测记得删掉这个文件。

## 坑类记录：症状词与问法

坑类 note（`tags` 含「坑」）可以带两组检索辅助：

- `symptom`：1–2 个症状词，每个 2–8 字，用来渲染 L0 的「踩过 N 类坑」门铃；
- `ask`：1–3 句用户口吻问法，每句 6–40 字，用于 doc2query 扩写。

两者都存成内部 `kind=symptom` 事件（`refs` 指向那条 note，`symptoms` / `asks` 二选一或并存），**不进 L0 正文、不单独成为召回条目**。`symptomsInRecall=true` 时它们并入该条目的检索文本；关闭则检索行为与旧版一致。

写的时候顺手给：`mem_note(kind="note", tags=["坑"], symptom=["证书报错"], ask=["抽帧报证书错怎么办"])`。存量条目补录要走 `src=review` 的一次性事件，不要用 revise（revise 的语义是「当初记错了」）。

## 向量性能实测

2026-11-04 在 Windows / 纯 Node WASM / `numThreads=1` 下，20 次热查询实测
`p50=510.9ms`、`p95=534.1ms`；完整 47 题评测为 `p95=597.7ms`。当前预算是
`p95 ≤400ms`，因此这份实现尚未达标，不能仅凭功能完成就默认合入。worker 在活动请求
期间保持进程，完成后 `unref()`；脚本显式 `dispose()`，宿主空闲 5 分钟自动回收。

## 开发

```bash
node --test
```

注意：`A3` / `A3b` / `ABA` 三个用例要 spawn 子进程验证跨进程锁，在受限沙箱里会以 `spawn EPERM` 失败。在沙箱环境里跳过它们：

```bash
node --test --experimental-test-isolation=none --test-skip-pattern="A3|A3b|ABA"
```

目录结构：

```
src/
  index.js        插件入口：注册工具、挂变量、注入自检
  host.js         五个工具的定义（含 output 契约）
  write.js        写入路径（归一化 → 查重 → 追加 → 持锁重算）
  l0.js           L0 渲染与预算仲裁
  recall.js       召回与打分
  audit.js        审计
  storage/        事件流、原子写、文件锁
test/             node:test 用例
fixtures/         测试夹具（假宿主、子进程写入器）
```

## 变更记录

### 0.2.1（2026-11-05）

- `mem_note` 的工具描述补上 `ask` 的用途说明：写坑类笔记时顺手给 1–3 句用户问法，用于检索扩写。行为无变化。

### 0.2.0（2026-11-04）

- **L0 事实段支持 `headline`**：结论不再被 32 字盲切切掉；渲染成 `[主人|项目] <日期> <对象简称>.<方面段>：<headline>`，对象简称跨对象撞名时自动退完整对象段，跨年自动切 `YY-MM-DD`。
- **静默丢条修复**：`fact_overflow` 现在同时记录「第 9 名之后」和「前 8 名里被字数/预算挤掉」的键；新增 `fact_headline_missing`、`fact_label_long`。
- **坑类触发通道**：新增内部事件 `kind=symptom`，L0 增加一行不超过 50 字的「踩过 N 类坑（类别词…）→ 报错/没反应/不出现先 mem_recall」；类别词读 `.dsh-mem/pit-categories.txt`。`mem_note` 增加 `symptom` 参数。
- **doc2query**：`symptom` 事件增加 `asks`，`mem_note` 增加 `ask`；`symptomsInRecall` 默认开启，把症状词与问法并入召回检索文本。冻结协议下留出 30 题 recall@5 从 10 提升到 27（b=18、c=1、p≈1.9e-5），回归与延迟无退化。
- **消融开关**：`.dsh-mem/flags/ablation` 写 `no-pit` / `off` 可分别关掉门铃行或整块注入，档位记入 `health.ablation`（只用于评测，平时不该存在）。
- **新增红线**：改前写死指标与门槛，只跑一次，不许调参重跑。

### 0.1.0（2026-10-31）

- 首个版本：五个工具（`mem_fact` / `mem_note` / `mem_fix` / `mem_recall` / `mem_audit`）、三层结构（L0 注入 / `events.jsonl` 真相源 / 按需召回）、A1 不变量（派生品全可重建）、注入自检与健康指标。

## 隐私

- 记忆只写到 `<workspace>/.dsh-mem/`（以及启用 global scope 时的 `~/.dsh/owner-memory/`）；
- 仓库自带 `.gitignore` 挡掉日志与 `.dsh-mem/`，不会把记忆提交上去；
- 插件不做任何网络请求。
