---
description: "可安装的 profile 层，为 dsh --profile 界面增加文件型持久化代理记忆，供组装或自定义 profile 的用户使用。"
kind: "package-bundle"
---

# @local/dsh-memory

English | [中文](README.zh.md)

## Summary

为任何列出它的 profile 增加持久化代理记忆：一条记忆一个 Markdown 文件，每轮注入分层的提示视图——常驻规则以正文注入，其余只注入按需读取的指针——每轮结束后自动抽取落盘。该层只插入一个 Loader 行 `dsh-memory`，其包自带工具、提示段、写入策略和抽取流水线。插件管理页中该行自己的页面编辑九个即时生效字段——包括决定一条记忆能写多长的"记忆宽度"；其余十个键仍在 `cordis.patch.yml` 中。已列出 `@deepseek-ai/dsh-base` 的 profile 会同时获得这一层所需的设置界面。

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Install into a profile

```text
dsh plugin --profile web add /absolute/path/to/dsh-memory
dsh plugin --profile web remove @local/dsh-memory
```

`dsh plugin` 会链接该 checkout，并因为 manifest 声明了 `dsh.bundle.patch` 而把 bundle 追加进 `dsh.profile.bundles`。没有该声明的包仍然装得上，但只是普通依赖：`dsh plugin` 会打印警告并且不激活任何层。要迁移目录，先 remove 再移动，然后用新的绝对路径 add——profile junction 由 add 重写，因此任何 profile 文件都不需要手改。

### Dependencies / 依赖

唯一运行时依赖是 `@deepseek-ai/schemastery`（连带 `@deepseek-ai/cosmokit`、`@standard-schema/spec`）。由于 profile 以 `link:` 链接本目录，包管理器不会为它安装这些依赖，因此它们随包放在 `vendor/` 下，由 `scripts/ensure-deps.mjs` 复制进 `node_modules/`。把插件复制到新位置后，执行一次：

```text
node scripts/ensure-deps.mjs
```

普通（非 `link:`）安装时 `postinstall`/`prepare` 会自动执行；`link:` 安装需手动执行。可用 `node scripts/ensure-deps.mjs --check` 校验。

### What you get

一个 Loader 行 `dsh-memory` 承载全部能力：

| 界面 | 所属 |
| --- | --- |
| `memory` 工具（`list` / `read` / `write` / `search` / `forget` / `audit`） | `host/tool.js` |
| 每轮提示中的 `Memory` 规则段与分层的 `MemoryIndex` 上下文 | `index.js` |
| 记忆目录内的写入权限，绝不放宽已有的 deny/ask | `host/permission.js` |
| 每轮结束后的自动抽取 | `host/extract.js` |
| 回环路由 `/memory/status` 与 `/memory/file` | `host/status.js` |
| 插件管理页中该行的配置页面 | `client.js` |

### The nine live fields

插件管理 → `@local/dsh-memory` → `dsh-memory` 行 → 配置，打开的是 `index.js` 中标记 `.volatile()` 的九个字段的表单：`memoryWidth`、`extractionEnabled`、`minUserChars`、`minCjkChars`、`extractionMinTurns`、`extractionMinSteps`、`includeSubagents`、`recentBodiesInPrompt` 和 `model`。页面所有者把 `form.state` 和 `form.mutate(operations, expectedRevision)` 交给卡片，因此卡片除了暂存草稿之外不拥有任何状态。一次保存写入 profile patch、重启后仍在，并且在下一轮生效——每个字段都在使用点读取，因为 volatile-only 的变更会被直接提交进运行中的 fiber 而不重新挂载。

`memoryWidth` 是防止长期项目的记忆野蛮生长的旋钮：`extended` 允许长正文，也允许把一个主题拆成多个文件；`balanced`（默认）就是本插件在加入这个旋钮之前的行为；`slim` 把每条抽取写入的正文限制在 800 字符以内，优先把新事实并入已有文件而不是新开一个，并在 `indexLineLimit` / `indexCharLimit` 仍处于默认值时收窄注入索引的预算。同一个旋钮也决定常驻层的预算——`balanced` 与 `slim` 为 10 行 / 800 字符，`extended` 为 20 / 1,600——该项没有独立配置键。三个选项与 schema union 由 `tests/config-schema.mjs` 钉在一起。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部细节 — 点击展开</summary>

`cordis.patch.yml` 只插入一个行，并把每个配置项的默认值都写全，因为 loader 替换被打补丁行的整个 `config` 值而不是深合并键：

```yaml
- insert:
    - id: dsh-memory
      name: '@local/dsh-memory'
      config:
        enabled: true
        storageRoot: ''
        extractionEnabled: true
        agentMemoryScopes: {}
```

行的模块是包根，因此浏览器半边会挂在它上面：`dsh.client` 声明 `platform: web` 并注入 `@deepseek-ai/dsh-client-ui-settings`。从子路径导出挂载的行永远不会携带半边。

| 路径 | 职责 |
| --- | --- |
| `index.js` | `apply`、`Config`、`CONFIG_DEFAULTS`、提示 fiber |
| `host/context.js` | 每会话的记忆目录与索引缓存 |
| `host/extract.js` | 去抖、调度、一次模型调用、计划校验 |
| `host/permission.js` | `tools/pre-execute`、`tools.guard`、`tools/post-execute` |
| `host/tool.js` | `memory` 工具定义与参数校验 |
| `host/status.js` | 两个回环路由 |
| `host/agent-memory.js` | 子代理身份解析与代理提示段 |
| `src/` | 纯逻辑：格式、索引、分层、清单、路径安全、计划校验、宽度 |
| `client.js` | 插件管理页卡片与状态浏览器 |
| `tests/` | 九套测试，用 `node tests/<suite>.mjs` 运行 |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- 本包遵循的 Harness cookbook：`docs/cookbook/adding-a-settings-card.md`（即时配置表单），以及 `docs/cookbook/adding-a-package.md` 第 5 节（显示元数据）。
- `docs/user/develop/basic/publish.md`：上文引用的安装路径与层序规则。
- `@deepseek-ai/dsh-client-ui-plugin-manager` 的 `lib/types/client/slot-contract.d.ts`：本包注册的 `plugins.row.config` 席位定义。

-----

<a id="model-experience"></a>
## Model Experience

### Memory rules in the system prompt

#### What the model sees

一个名为 `Memory` 的 `ctx.systemPrompt.section`，在 `injectRules` 不为 false 时为每个代理注入。它给出解析出的记忆根目录并说明该目录已存在，随后定义文件契约：一条记忆一个 Markdown 文件、带 `name`、`description`、`metadata.type` 的 YAML frontmatter、一段该 frontmatter 的围栏示例，以及 `[[name]]` 交叉引用语法——未命中的链接表示"值得以后写"，不是错误。接着按**什么时候适用**定义四种类型：`user` 与 `feedback` 每轮以正文注入，`project` 与 `reference` 只注入指针、正文按需读取；然后给出写入闸门的三问（未来哪个具体决策会被它改变；仓库、AGENTS.md 或 git 是否已记录；是重复出现的要求还是一次性说法），三问答不全就不写，并规定常驻层每类只留一个文件——`feedback` 写在 `how_to_work.md`——且不得超出注入预算。写入闸门旁还附一份"什么不该进记忆"清单（一次性细节、一次性事实、未确认的推测、凭据/隐私，以及仓库/AGENTS.md/git 已记录的内容）和最小范围规则（每轮都成立的稳定规则进 `user`/`feedback`，其余进 `project`/`reference`）。之后是 `MEMORY.md` 契约（索引由宿主维护、一条记忆一行、绝不放记忆正文、模型不得自行编辑）、过期规则——依据记忆推荐前先核实其中的路径或开关。提示词正文只有英文，不附加任何语言对照段。在 `extended` 与 `slim` 宽度下，该段还会带上一节写作宽度——正文预算，以及 `slim` 的"并入已有文件"规则；`balanced` 不加任何内容。解析出的根路径是唯一与数据相关的部分。

#### Token effect

固定：每个代理一段，`injectRules` 不为 false 时存在，否则不注入。

#### KV Cache effect

只追加。该段文本仅在 `injectRules` 或解析出的根目录变化时改变，因此已可复用的前缀在轮次之间得以保留。

### The layered memory view in the request context

#### What the model sees

一个名为 `MemoryIndex` 的 `ctx.systemPrompt.context`，在 `injectIndex` 不为 false 时注入，渲染两层。常驻层（`user` 与 `feedback`）注入的是规则本身——正文去掉 `**Why:**` / `**How to apply:**` 行——并受硬预算约束：10 行 / 800 字符（`extended` 为 20 / 1,600）；超预算时该块被截断，并附一行说明溢出量与应合并到的文件；某一类型长出第二个文件时，附一行说明该类型应归并到哪个文件。检索层是其余记忆各一行 Markdown 指针，含标题与一句话钩子，最新在前，由 `indexLineLimit` / `indexCharLimit` 截断，触顶时附警告行。`MEMORY.md` 中没有指针的记忆完全不注入，因此索引文件始终是"模型看到什么"的权威来源。

#### Token effect

两层都有上限：`indexCharLimit` / `indexLineLimit` 约束检索层指针，常驻层预算约束模型无法回避的那段正文——因此无论记忆树长大还是规则集增长，提示都不会无界膨胀。

#### KV Cache effect

替换式。任一层在记忆写入或删除后都会变化，因此其后的前缀在这些轮次之间不可复用。

### The memory tool schema

#### What the model sees

一个工具 `memory`，六个动作（`list`、`read`、`write`、`search`、`forget`、`audit`）加一个 JSON 输出 schema。参数缺失或类型错误时返回 `{ ok: false, action, error }`，指明参数名及其期望值而不是抛异常；意外失败走同一通道并记日志。`audit` 是一份只读维护报告——重复的 name/description、悬空的 `MEMORY.md` 指针、未入索引因而永不注入的文件、常驻层同类多文件冲突、索引/常驻层超预算，以及 `slim` 下的超长正文，并附待合并清单。它从不编辑、合并或删除，由调用方依据报告处理。

#### Token effect

固定：每会话一个 schema，运行期不变。

#### KV Cache effect

只追加。插件加载期间 schema 不变化。

### The extraction request

#### What the model sees

代理自身的上下文里什么都没有。抽取是一次独立的 `ctx.llm.stream()` 调用，把最近的对话记录、记忆清单和近期记忆正文（**已剥掉 frontmatter**——既避免模型把头部抄回正文，也省下它本就不该碰的那些行）渲染进同一个提示，要求返回单个 JSON 操作计划。该提示声明模型没有工具、用围栏示例固定输出格式，并列出硬规则：`file` 只能是不带目录和 `..` 的裸 `.md` 名；`MEMORY.md` 永远不是目标；`type` 只能是四个值之一；`hook` 至多 150 字符且是索引行而非内容；`edit` 的正文必须完整且绝不包含 frontmatter；常驻层每类只留一个文件（`feedback` 规则全部写进 `how_to_work.md`，新的 `user` 事实并入已有的 user 文件）；无可保存内容时回答 `{"operations":[]}`。`slim` 宽度下硬规则还会加上正文预算和"优先 `edit` 而非 `write`"；`extended` 下允许把主题拆成多个文件；`balanced` 下两者都不出现。提示词只有英文，不附加中文重述段。

#### Token effect

有条件：某一轮的用户文本超过 `minUserChars` 或 `minCjkChars` 后，经 `extractionDebounceMs` 去抖触发，渲染的对话记录上限 120,000 字符，事件窗口上限 500 条。第二道闸会把它压到会话累计关闭至少 `extractionMinTurns` 轮且 `extractionMinSteps` 步之后——与"会话统计"面板同源的 `sessionStats` 计数；闸未开时不排任何任务、游标不动，所以第一次合格抽取仍会读到会话开头而不是跳过前期。没有挂载 `sessionStats` 的 profile 直接放行，因此缺一个投影绝不会把抽取静默关掉。请求体积的主因是 `recentBodiesInPrompt` 那些**完整正文**而不是对话记录，所以这一个字段就是抽取成本的旋钮；而 `edit` 只允许针对本次请求里给出了正文的文件，因此调小它绝不会把"合并"变成重写一个看不到的正文。

#### KV Cache effect

独立。该调用不携带 session id，因此与代理的请求不共享任何前缀，也不会使其复用失效。

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

这些限制说明部署超出默认值时会遇到什么。它们是本包当前的约束，不是泛泛的工具对比或任务清单。

- **十个非 volatile 键在界面里没有控件。** `storageRoot`、`indexLineLimit`、`indexCharLimit`、`extractionDebounceMs`、`drainTimeoutMs`、`injectRules`、`injectIndex`、`allowMemoryWrites`、`enabled` 和 `agentMemoryScopes` 只能在 `cordis.patch.yml` 中修改。它们在安装时读取一次，因此为它们做卡片要么是说谎要么需要重载；`storageRoot` 尤其会移动整棵树，从卡片改它会让已有记忆看起来像消失。
- **索引预算只在未被改动时跟随宽度。** 仍停留在 schema 默认值的 `indexLineLimit` / `indexCharLimit` 会被宽度预设替换——`slim` 为 100 行 / 12,000 字符，`extended` 为 400 / 50,000——而任何在 patch 中显式设定的值在任一宽度下都优先。常驻层预算完全没有配置键：它无条件跟随宽度预设，在每次写入该层时回报给模型，并以"截断 + 说明"的方式生效，而不是拒绝写入。同样，`slim` 的正文上限只对抽取写入生效：通过 `memory` 工具或 `Write` 工具的直接写入遵循提示词引导，而不是被强制截断。
- **预热闸只负责计数，不负责跳过。** `extractionMinTurns` / `extractionMinSteps` 决定抽取何时*开始*，闸未开时游标不动：第一次合格抽取会从会话开头读起（受 500 事件窗口限制），而不是跳过前期轮次。两个键都填 0 即关闭该闸。
- **解析失败会推进游标。** 模型返回的不是 JSON 计划时，抽取把它当作 no-op 继续，而不是每轮重问同一个 120,000 字符的请求。因此被截断的回复会被跳过，不会恢复。
- **子代理的记忆规则只有英文。** locale 服务在 Client 侧，子代理提示读不到当前界面语言。
- **子代理记忆提示模板里写的是 `Write` 工具**，而 DSH 注册的是小写 `write`；此差异只是措辞层面。
- **抽取每个达标轮次花费一次模型调用。** 没有跨轮批处理，也没有本地预过滤，多话的会话要为每个越过触发阈值的轮次付费。
- **子代理记忆在配置前是关闭的。** `agentMemoryScopes` 默认为 `{}`，在把某个身份映射到 `user`、`project` 或 `local` 之前，子代理不会有持久记忆。身份键依次取子代理的 `agentPreset`、Agent Teams 成员名、委派描述标签。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包通过 profile 的 `link:` 依赖安装，而 `link:` 不会安装被链接包自己的依赖——因此 `@deepseek-ai/schemastery` 被 vendor 进 `node_modules/`（已被 git 忽略）而不是在运行期声明。`node tests/config-schema.mjs` 同时检查 vendor 副本仍在、schema 仍带九个 volatile 字段。

Host 对 `node_modules/` 下的路径不做热重建，而 `link:` 目标正解析到那里，因此在位编辑不会被实时重载拾取；改动模块会在下一次 profile 重组时替换（保存 profile patch 或在插件页操作），通常不需要整个 Harness 重启。对已安装的 bundle 再跑 `plugin_manager install_bundle` 会以 `ambiguous-install` 失败：`pnpm add` 报告 "Already up to date"，没有任何依赖发生变化。

</details>
