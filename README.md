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

## L0 预算（硬约束）

总预算 1200 字符，分段配额合计恰好 1200：

| 段 | 条数 | 字符 | 溢出时 |
|---|---|---|---|
| 红线 `rule` | 6 | 260 | 按 `weight` 取前 6，其余进 `mem_recall(kinds=['rule'])` 强制通道 |
| 在办 `todo` | 5 | 280 | 保留最近的 |
| 事实 `fact` | 8 | 380 | 低分先出局（打分见下） |
| 决策 `decision` | 3 | 120 | 保留最近的 |
| 标题 + 尾注 | — | 160 | — |

- 单条正文超过 **32 字符**会被截断并补 `…`，id 一定保留；
- 淘汰顺序 **决策 → 事实 → 在办**，红线永不缺省；真顶穿时红线正文会被压到 16 / 8 字符（记 `rules_truncated_hard`）；
- 事实段不套召回公式：`score = 0.8 + 0.2×weight + 0.2(30 天内) + 0.3(pin)`，同分按 `confirmCount`、再按 key 字典序兜底（保证同一份库每轮渲染结果稳定，不打穿 prompt cache）。

## 健康指标

`mem_audit(what="health")` 里三个和注入有关的字段：

| 字段 | 什么时候为 `true` | 该做什么 |
|---|---|---|
| `rules_overflow` | 有红线被挤出前 6，或红线全文字符超预算，或任一条超 32 字 | 看 L0 尾注分辨是「溢出」还是「截断」；前者先 `mem_recall(kinds=['rule'])` |
| `rules_truncated_hard` | 红线正文被压到 16 / 8 字符 | 红线写太长了，删/合并或把细节挪进 `note` |
| `injection_missing` | 最终提示里找不到 L0 首行 | 检查 persona 有没有 `{{owner_memory}}` |

这三个指标**每轮重算重写**，不是历史累积值；尾注与指标口径必须一致，不一致就是落盘链路断了。

## 安装

以 DSH 桌面版为例（`~/.dsh/profiles/<你的 profile>`）：

1. 把本仓库加进 profile 的 `package.json` 依赖：

   ```json
   "dsh-owner-memory": "github:<你的用户名>/dsh-owner-memory#v0.1.0"
   ```

   本机开发也可以直接用本地路径：`"dsh-owner-memory": "link:C:/path/to/owner-memory"`。

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
| `foldAtLines` | `20000` | 事件流到多少行触发折叠（折叠前自动快照） |

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

## 隐私

- 记忆只写到 `<workspace>/.dsh-mem/`（以及启用 global scope 时的 `~/.dsh/owner-memory/`）；
- 仓库自带 `.gitignore` 挡掉日志与 `.dsh-mem/`，不会把记忆提交上去；
- 插件不做任何网络请求。
