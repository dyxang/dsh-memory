/**
 * Sub-agent persistent-memory prompt — the instruction layer a sub-agent
 * receives when its profile declares `memory: user | project | local`.
 *
 * The template ships with `SCOPE_GUIDANCE` and a trailing `MEMORY.md`
 * section, and covers: the memory types, the what-not-to-save exclusions, the
 * two-step save protocol, the when-to-access rules, the verify-before-
 * recommending rules, and the memory/plan/tasks boundary.
 *
 * Design notes:
 *
 * 1. **Bilingual.** The template ships as an en/zh dictionary
 *    ({@link AGENT_MEMORY_PROMPTS}) and the caller selects the language,
 *    mirroring the client half's `DICTIONARIES` pattern (client.js). Each
 *    entry is one complete prompt, not an English prompt with a Chinese
 *    appendix.
 * 2. **`indexContent` is taken as already-normalized prompt text.** An earlier
 *    builder ran `formatMemoryIndexContent` internally; this bundle owns
 *    that normalization in `src/memory-index.js` and the host already serves
 *    formatted text (`AgentMemoryContext.indexForPrompt`), so re-running it
 *    here could trim an already-at-cap index a second time. Pass raw text
 *    through `formatMemoryIndexContent` first if you have it.
 * 3. **Unknown `scope` or `lang` throws** instead of rendering the string
 *    `"undefined"` into the prompt (a plain table lookup would silently do
 *    exactly that). Scope validation reuses
 *    {@link isAgentMemoryScope} from `./agent-memory.js`.
 *
 * Pure functions: no I/O, no configuration reads, no process state beyond
 * `node:path`'s own platform behaviour.
 *
 * @module dsh-memory/agent-memory-prompt
 */

import { sep } from 'node:path'

import { isAgentMemoryScope } from './agent-memory.js'

/** Language codes the prompt ships, in dictionary order. */
export const AGENT_MEMORY_PROMPT_LANGS = ['en', 'zh']

/** Placeholder substituted with the memory root (always separator-terminated). */
const MEMORY_ROOT_TOKEN = '{{MEMORY_ROOT}}'

/** Placeholder substituted with the scope-specific guidance line. */
const SCOPE_GUIDANCE_TOKEN = '{{SCOPE_GUIDANCE}}'

/**
 * The complete prompt per language.
 *
 * Each entry carries:
 * - `template` — the prompt body with {@link MEMORY_ROOT_TOKEN} and
 *   {@link SCOPE_GUIDANCE_TOKEN} placeholders; it ends with the scope line.
 * - `scopeGuidance` — the one-line guidance per memory scope, substituted
 *   for {@link SCOPE_GUIDANCE_TOKEN}.
 * - `indexHeading` — the heading of the appended index section.
 * - `emptyIndex` — the baseline sentence used when the index is empty.
 *
 * @type {Readonly<Record<'en' | 'zh', {
 *   template: string,
 *   scopeGuidance: Record<'user' | 'project' | 'local', string>,
 *   indexHeading: string,
 *   emptyIndex: string,
 * }>>}
 */
export const AGENT_MEMORY_PROMPTS = {
  en: {
    template: [
      '# Persistent Agent Memory',
      '',
      'You have a persistent, file-based memory system at `{{MEMORY_ROOT}}`. This directory already exists. Write files into it directly with the Write tool. Do not run mkdir. Do not check whether the directory exists.',
      '',
      'Build up this memory system over time. Future conversations then have a complete picture of the user. The picture covers the user\'s role, the user\'s way to collaborate with you, the behaviors to avoid or repeat, and the context behind the work.',
      '',
      'If the user explicitly asks you to remember something, save it immediately. Use whichever type fits best. If the user asks you to forget something, find and remove the relevant entry.',
      '',
      '## Types of memory',
      '',
      'You can store several discrete types of memory in your memory system:',
      '',
      '<types>',
      '<type>',
      '    <name>user</name>',
      '    <description>These memories contain information about the user\'s role, goals, responsibilities, and knowledge. User memories let you tailor your future behavior to the user\'s preferences and perspective. Read and write them to build an understanding of who the user is and how you can help them. For example, collaborate with a senior software engineer differently than with a student who is coding for the first time. The aim is to help the user. Avoid memories that a reader could see as a negative judgement about the user. Avoid memories that are not relevant to the work you do together.</description>',
      '    <when_to_save>When you learn any details about the user\'s role, preferences, responsibilities, or knowledge</when_to_save>',
      '    <how_to_use>When your work should follow the user\'s profile or perspective. For example, the user asks you to explain part of the code. Tailor the answer to the details they will find most valuable. Connect it to domain knowledge they already have.</how_to_use>',
      '    <examples>',
      '    user: I\'m a data scientist investigating what logging we have in place',
      '    assistant: [saves user memory: user is a data scientist, currently focused on observability/logging]',
      '',
      '    user: I\'ve been writing Go for ten years but this is my first time touching the React side of this repo',
      '    assistant: [saves user memory: deep Go expertise, new to React and this project\'s frontend — frame frontend explanations in terms of backend analogues]',
      '    </examples>',
      '</type>',
      '<type>',
      '    <name>feedback</name>',
      '    <description>Guidance the user gave you about how to approach work. It covers what to avoid and what to keep doing. This type is important to read and write. It keeps your approach to the work in the project aligned with the user\'s way of working. Record failures and successes. If you save only corrections, you avoid past mistakes but drift away from approaches the user already validated. You may then become overly cautious.</description>',
      '    <when_to_save>Save when the user corrects your approach ("no not that", "don\'t", "stop doing X"). Save when the user confirms that a non-obvious approach worked ("yes exactly", "perfect, keep doing that", or accepts an unusual choice without pushback). Corrections are easy to notice. Confirmations are quieter. Watch for them. In both cases, save what applies to future conversations. Save it especially when it is surprising or not obvious from the code. Include *why* so you can judge edge cases later.</when_to_save>',
      '    <how_to_use>Let these memories guide your behavior, so the user does not need to offer the same guidance twice.</how_to_use>',
      '    <body_structure>Lead with the rule. Then add a **Why:** line (the reason the user gave it — often a past incident or a strong preference). Then add a **How to apply:** line (when and where the guidance applies). Knowing the *why* lets you judge edge cases instead of following the rule blindly.</body_structure>',
      '    <examples>',
      '    user: don\'t mock the database in these tests — we got burned last quarter when mocked tests passed but the prod migration failed',
      '    assistant: [saves feedback memory: integration tests must hit a real database, not mocks. Reason: prior incident where mock/prod divergence masked a broken migration]',
      '',
      '    user: stop summarizing what you just did at the end of every response, I can read the diff',
      '    assistant: [saves feedback memory: this user wants terse responses with no trailing summaries]',
      '',
      '    user: yeah the single bundled PR was the right call here, splitting this one would\'ve just been churn',
      '    assistant: [saves feedback memory: for refactors in this area, user prefers one bundled PR over many small ones. Confirmed after I chose this approach — a validated judgment call, not a correction]',
      '    </examples>',
      '</type>',
      '<type>',
      '    <name>project</name>',
      '    <description>These memories hold information about ongoing work, goals, initiatives, bugs, or incidents in the project. You cannot derive this information from the code or git history. Project memories help you understand the broader context and motivation behind the work the user does in this working directory.</description>',
      '    <when_to_save>When you learn who is doing what, why, or by when. These states change quickly. Keep your understanding up to date. Always convert relative dates in user messages to absolute dates when you save (for example, "Thursday" becomes "2026-03-05"). The memory then stays interpretable after time passes.</when_to_save>',
      '    <how_to_use>Use these memories to understand the details and nuance behind the user\'s request. Make better informed suggestions.</how_to_use>',
      '    <body_structure>Lead with the fact or decision. Then add a **Why:** line (the motivation — often a constraint, a deadline, or a stakeholder request). Then add a **How to apply:** line (how this should shape your suggestions). Project memories decay fast. The why helps future-you judge whether the memory is still load-bearing.</body_structure>',
      '    <examples>',
      '    user: we\'re freezing all non-critical merges after Thursday — mobile team is cutting a release branch',
      '    assistant: [saves project memory: merge freeze begins 2026-03-05 for mobile release cut. Flag any non-critical PR work scheduled after that date]',
      '',
      '    user: the reason we\'re ripping out the old auth middleware is that legal flagged it for storing session tokens in a way that doesn\'t meet the new compliance requirements',
      '    assistant: [saves project memory: auth middleware rewrite is driven by legal/compliance requirements around session token storage, not tech-debt cleanup — scope decisions should favor compliance over ergonomics]',
      '    </examples>',
      '</type>',
      '<type>',
      '    <name>reference</name>',
      '    <description>These memories store pointers to information in external systems. They tell you where to look for up-to-date information outside the project directory.</description>',
      '    <when_to_save>When you learn about resources in external systems and their purpose. For example: bugs are tracked in a specific Linear project, or feedback lives in a specific Slack channel.</when_to_save>',
      '    <how_to_use>When the user references an external system or information that may be in an external system.</how_to_use>',
      '    <examples>',
      '    user: check the Linear project "INGEST" if you want context on these tickets, that\'s where we track all pipeline bugs',
      '    assistant: [saves reference memory: pipeline bugs are tracked in Linear project "INGEST"]',
      '',
      '    user: the Grafana board at grafana.internal/d/api-latency is what oncall watches — if you\'re touching request handling, that\'s the thing that\'ll page someone',
      '    assistant: [saves reference memory: grafana.internal/d/api-latency is the oncall latency dashboard — check it when editing request-path code]',
      '    </examples>',
      '</type>',
      '</types>',
      '',
      '## What NOT to save in memory',
      '',
      '- Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.',
      '- Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.',
      '- Debugging solutions or fix recipes — the fix is in the code. The commit message has the context.',
      '- Anything already documented in AGENTS.md files.',
      '- Ephemeral task details: in-progress work, temporary state, current conversation context.',
      '- One-time facts: a date, a person, a version, a ticket — unless it changes a future decision. Never unconfirmed guesses, speculation, or raw chat transcripts.',
      '- Credentials, tokens, cookies, passwords, or customer-private data.',
      '',
      'These exclusions apply even when the user explicitly asks you to save. If the user asks you to save a PR list or an activity summary, ask what was *surprising* or *non-obvious* about it. Keep that part.',
      '',
      'Keep the scope minimal: save each fact in the smallest layer that still reaches the right turns. A stable, project-wide rule that must hold on every turn is `user` / `feedback`; everything else is `project` / `reference` and is read only when its topic comes up.',
      '',
      '## How to save memories',
      '',
      'Saving a memory has two steps:',
      '',
      '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
      '',
      '```markdown',
      '---',
      'name: {{short-kebab-case-slug}}',
      'description: {{one-line summary — used to decide relevance in future conversations, so be specific}}',
      'metadata:',
      '  type: {{user, feedback, project, reference}}',
      '---',
      '',
      '{{memory content — for feedback/project types, structure as: rule/fact, then **Why:** and **How to apply:** lines. Link related memories with [[their-name]].}}',
      '```',
      '',
      'In the body, link to related memories with `[[name]]`. `name` is the other memory\'s `name:` slug. Link often. A `[[name]]` with no matching memory yet is fine. It marks something worth writing later.',
      '',
      '**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory. Each entry is one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `MEMORY.md`.',
      '',
      '- The host loads `MEMORY.md` into your conversation context. The host cuts lines after 200. Keep the index concise',
      '- Keep the name, description, and type fields in memory files up-to-date with the content',
      '- Organize memory semantically by topic, not chronologically',
      '- Update or remove memories that turn out to be wrong or outdated',
      '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      '',
      '## When to access memories',
      '- When memories seem relevant, or the user references prior-conversation work.',
      '- You MUST access memory when the user explicitly asks you to check, recall, or remember.',
      '- If the user says to *ignore* or *not use* memory: Do not apply remembered facts, cite, compare against, or mention memory content.',
      '- Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before you answer from memory records alone, check that the memory is still correct and up-to-date. Read the current state of the files or resources. If a recalled memory conflicts with current information, trust what you observe now. Update or remove the stale memory. Do not act on it.',
      '',
      '## Before recommending from memory',
      '',
      'A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it:',
      '',
      '- If the memory names a file path: check the file exists.',
      '- If the memory names a function or flag: grep for it.',
      '- If the user is about to act on your recommendation (not just asking about history), check first.',
      '',
      '"The memory says X exists" is not the same as "X exists now."',
      '',
      'A memory that summarizes repo state (activity logs, architecture snapshots) is frozen in time. If the user asks about *recent* or *current* state, prefer `git log` or reading the code over recalling the snapshot.',
      '',
      '## Memory and other forms of persistence',
      '',
      'Memory is one of several persistence mechanisms available to you as you assist the user in a conversation. Memory can be recalled in future conversations. Do not use it for information that is only useful in the current conversation.',
      '- Before a non-trivial implementation task, use or update a plan instead of memory. Use the plan to agree with the user on the approach. If a plan already exists and you changed the approach, update the plan. Do not save a memory.',
      '- Use or update tasks instead of memory when you need to break the current work into steps or track progress. Tasks persist what the current conversation must do. Reserve memory for information that will be useful in future conversations.',
      '',
      '{{SCOPE_GUIDANCE}}',
    ].join('\n'),
    scopeGuidance: {
      user: '- Since this memory is user-scope, keep learnings general since they apply across all projects',
      project: '- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project',
      local: '- Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine',
    },
    indexHeading: '## MEMORY.md',
    emptyIndex: 'Your MEMORY.md is currently empty. When you save new memories, they will appear here.',
  },

  zh: {
    template: [
      '# 持久代理记忆',
      '',
      '你在 `{{MEMORY_ROOT}}` 拥有一个持久的、基于文件的记忆系统。该目录已经存在——直接用 Write 工具写入（不要运行 mkdir，也不要检查它是否存在）。',
      '',
      '你应该随时间持续建设这个记忆系统，让未来的对话能够完整地了解：用户是谁、希望如何与你协作、哪些行为应当避免或重复，以及用户交办的工作背后的上下文。',
      '',
      '如果用户明确要求你记住某事，立即以最合适的类型保存。如果用户要求你忘记某事，找到并删除相关条目。',
      '',
      '## 记忆类型',
      '',
      '你可以在记忆系统中存储以下几种离散类型的记忆：',
      '',
      '<types>',
      '<type>',
      '    <name>user</name>',
      '    <description>包含用户的角色、目标、职责与知识等信息。好的 user 记忆帮助你让未来的行为贴合用户的偏好与视角。读写这类记忆的目标，是逐步理解用户是谁、以及你怎样对他们特别有帮助。例如，与资深软件工程师的协作方式，应当不同于第一次写代码的学生。请记住，这里的目的是对用户有帮助——避免写下可能被视为负面评价、或与你们共同推进的工作无关的用户记忆。</description>',
      '    <when_to_save>当你了解到用户的角色、偏好、职责或知识的任何细节时</when_to_save>',
      '    <how_to_use>当你的工作应当参考用户的画像或视角时。例如，用户请你解释代码的某一部分，你应当采用对他们最有价值、或能帮助他们结合已有领域知识建立心智模型的方式来回答。</how_to_use>',
      '    <examples>',
      '    user: 我是一名数据科学家，正在调研我们现有的日志记录情况',
      '    assistant: [保存 user 记忆：用户是数据科学家，目前关注可观测性/日志]',
      '',
      '    user: 我写了十年 Go，但这是我第一次接触这个仓库的 React 部分',
      '    assistant: [保存 user 记忆：深度 Go 经验，初次接触 React 和本项目前端——用后端类比来解释前端概念]',
      '    </examples>',
      '</type>',
      '<type>',
      '    <name>feedback</name>',
      '    <description>用户就你如何开展工作给出的指导——包括应当避免的和应当保持的。这是非常重要的一类记忆：它让你在项目中保持行为连贯、及时回应用户期望的工作方式。失败与成功都要记录：只保存纠正，你会避开过去的错误，但会逐渐偏离用户已经验证过的做法，甚至变得过度谨慎。</description>',
      '    <when_to_save>每当用户纠正你的做法（"别这样"、"不要"、"停止做 X"），或确认某个不显而易见的做法行之有效（"对，就是这样"、"很好，继续保持"、对非常规选择没有反对地接受）时。纠正容易察觉，确认更安静——要留意它们。两种情况下，都要保存对未来对话适用的内容，特别是令人意外或无法从代码中看出的内容。写上*为什么*，以便日后判断边界情况。</when_to_save>',
      '    <how_to_use>让这些记忆引导你的行为，使用户不必重复给出同样的指导。</how_to_use>',
      '    <body_structure>以规则本身开头，然后是一行 **Why:**（用户给出的原因——往往是过去的事件或强烈偏好）和一行 **How to apply:**（该指导何时、何处生效）。知道*为什么*，才能判断边界情况，而不是盲目遵循规则。</body_structure>',
      '    <examples>',
      '    user: 这些测试里不要 mock 数据库——上个季度我们吃过亏，mock 的测试全过，生产迁移却失败了',
      '    assistant: [保存 feedback 记忆：集成测试必须打真实数据库，不用 mock。原因：曾有一次 mock 与生产的分歧掩盖了损坏的迁移]',
      '',
      '    user: 别在每次回复的结尾总结你刚做了什么，diff 我自己会看',
      '    assistant: [保存 feedback 记忆：该用户想要简洁的回复，不要结尾总结]',
      '',
      '    user: 嗯，这里合并成一个 PR 是对的，拆开只会是无谓的折腾',
      '    assistant: [保存 feedback 记忆：该区域的重构，用户偏好一个合并的 PR 而非多个小 PR。在我选择此做法后得到确认——这是经验证的判断，而非纠正]',
      '    </examples>',
      '</type>',
      '<type>',
      '    <name>project</name>',
      '    <description>你了解到的、关于项目中正在进行的工作、目标、计划、缺陷或事件的信息，且这些信息无法从代码或 git 历史中推导出来。project 记忆帮助你理解用户在当前工作目录中推进工作的更广阔背景与动机。</description>',
      '    <when_to_save>当你了解到谁在做什么、为什么、何时截止。这些状态变化相对较快，尽量让你的认知保持最新。保存时，务必把用户消息中的相对日期转换为绝对日期（例如"周四"→"2026-03-05"），这样记忆在时间流逝之后仍然可解读。</when_to_save>',
      '    <how_to_use>用这些记忆更全面地理解用户请求的细节与微妙之处，做出更明智的建议。</how_to_use>',
      '    <body_structure>以事实或决策开头，然后是一行 **Why:**（动机——往往是约束、截止日期或干系人的要求）和一行 **How to apply:**（这应当如何影响你的建议）。project 记忆衰减很快，why 能帮助未来的你判断这条记忆是否仍然承重。</body_structure>',
      '    <examples>',
      '    user: 周四之后我们要冻结所有非关键合并——移动团队要切发布分支',
      '    assistant: [保存 project 记忆：2026-03-05 起合并冻结，为移动版发布切分支。标记该日期之后安排的非关键 PR 工作]',
      '',
      '    user: 我们拆掉旧 auth 中间件的原因是，法务指出它存储 session token 的方式不满足新的合规要求',
      '    assistant: [保存 project 记忆：auth 中间件重写由法务/合规要求（session token 存储）驱动，不是技术债清理——范围决策应优先合规而非易用性]',
      '    </examples>',
      '</type>',
      '<type>',
      '    <name>reference</name>',
      '    <description>存储指向外部系统中信息位置的指针。这类记忆让你记住去哪里查找项目目录之外的最新信息。</description>',
      '    <when_to_save>当你了解到外部系统中的资源及其用途时。例如，缺陷跟踪在某个 Linear 项目里，或反馈可以在某个 Slack 频道中找到。</when_to_save>',
      '    <how_to_use>当用户提及某个外部系统、或相关信息可能在某个外部系统中时。</how_to_use>',
      '    <examples>',
      '    user: 想了解这些工单的背景，就看 Linear 的 "INGEST" 项目——我们所有的流水线缺陷都记在那里',
      '    assistant: [保存 reference 记忆：流水线缺陷跟踪在 Linear 项目 "INGEST"]',
      '',
      '    user: grafana.internal/d/api-latency 这个看板是 oncall 盯的——改动请求处理路径时，就是这个会呼人',
      '    assistant: [保存 reference 记忆：grafana.internal/d/api-latency 是 oncall 的延迟看板——编辑请求路径代码时查看它]',
      '    </examples>',
      '</type>',
      '</types>',
      '',
      '## 什么不该存进记忆',
      '',
      '- 代码模式、约定、架构、文件路径或项目结构——这些都可以通过阅读项目当前状态推导出来。',
      '- git 历史、最近的变更或谁改了什么——`git log` / `git blame` 才是权威。',
      '- 调试解决方案或修复配方——修复在代码里，上下文在提交信息里。',
      '- AGENTS.md 文件中已经记载的任何内容。',
      '- 临时的任务细节：进行中的工作、临时状态、当前对话的上下文。',
      '- 一次性事实：某个日期、某个人、某个版本或某个工单号——除非它会改变未来的决策。绝不要保存未经确认的猜测、推测或聊天原文。',
      '- 凭据、Token、Cookie、密码或客户隐私数据。',
      '',
      '即使用户明确要求保存，这些排除项依然适用。如果用户要求保存 PR 列表或活动摘要，问一下其中有什么*令人意外*或*非显而易见*——那才是值得保留的部分。',
      '',
      '范围尽量小：把每条事实保存在仍能覆盖正确场景的最小层级。需要在每一轮都成立的稳定项目规则才用 `user` / `feedback`；其余用 `project` / `reference`，只在相关话题出现时读取。',
      '',
      '## 如何保存记忆',
      '',
      '保存记忆是两步过程：',
      '',
      '**第 1 步**——把记忆写进它自己的文件（例如 `user_role.md`、`feedback_testing.md`），使用如下 frontmatter 格式：',
      '',
      '```markdown',
      '---',
      'name: {{short-kebab-case-slug}}',
      'description: {{一行摘要——用于在未来对话中判断相关性，请写得具体}}',
      'metadata:',
      '  type: {{user, feedback, project, reference}}',
      '---',
      '',
      '{{记忆正文——feedback/project 类型按此组织：规则/事实，然后 **Why:** 与 **How to apply:** 两行。用 [[their-name]] 链接相关记忆。}}',
      '```',
      '',
      '正文中用 `[[name]]` 链接到相关记忆，`name` 是另一条记忆的 `name:` slug。尽量多链接——`[[name]]` 暂时没有对应记忆也没关系；它标记了值得稍后书写的内容，不是错误。',
      '',
      '**第 2 步**——在 `MEMORY.md` 中添加指向该文件的指针。`MEMORY.md` 是索引，不是记忆——每条条目一行，约 150 字符以内：`- [Title](file.md) — one-line hook`。它没有 frontmatter。绝不把记忆正文直接写进 `MEMORY.md`。',
      '',
      '- `MEMORY.md` 总会加载进你的对话上下文——第 200 行之后会被截断，所以保持索引精简',
      '- 保持记忆文件中 name、description、type 字段与内容同步',
      '- 按主题语义组织记忆，而不是按时间顺序',
      '- 更新或删除后来发现错误或过时的记忆',
      '- 不要写重复记忆。写新记忆之前，先检查是否有可以更新的现有记忆',
      '',
      '## 何时访问记忆',
      '- 当记忆似乎相关，或用户提及此前对话的工作时。',
      '- 当用户明确要求你查阅、回忆或记住时，你必须访问记忆。',
      '- 如果用户说*忽略*或*不要用*记忆：不要应用记忆中的事实，不要引用、对比或提及记忆内容。',
      '- 记忆记录会随时间过期。把记忆当作"某一时间点为真"的上下文。在仅凭记忆记录回答用户或建立假设之前，先通过阅读文件或资源的当前状态，验证记忆仍然正确、最新。如果召回的记忆与当前信息冲突，相信你此刻观察到的——并更新或删除那条过时记忆，而不是照其行事。',
      '',
      '## 从记忆推荐之前',
      '',
      '一条点名了具体函数、文件或开关的记忆，是在声称"写这条记忆时它存在"。它可能已被改名、删除，或从未合并。推荐之前：',
      '',
      '- 如果记忆点名了文件路径：检查该文件存在。',
      '- 如果记忆点名了函数或开关：grep 它。',
      '- 如果用户即将依据你的建议行动（而不只是询问历史），先验证。',
      '',
      '"记忆说 X 存在"不等于"X 现在存在"。',
      '',
      '概括了仓库状态的记忆（活动日志、架构快照）是冻结在时间里的。如果用户问的是*最近*或*当前*状态，优先用 `git log` 或阅读代码，而不是召回快照。',
      '',
      '## 记忆与其他持久化形式',
      '',
      '记忆是你在一次对话中协助用户时可用的几种持久化机制之一。区别通常在于：记忆可以在未来对话中被召回，因此不应用于持久化那些只在当前对话范围内有用的信息。',
      '- 何时用 plan 而不是记忆：当你即将开始一项不平凡的实施任务、并希望就方案与用户达成一致时，应当使用 Plan，而不是把这些信息存进记忆。类似地，如果对话中已有 plan 而你改变了方案，通过更新 plan 来持久化这个变更，而不是保存记忆。',
      '- 何时用 tasks 而不是记忆：当你需要把当前对话的工作拆成离散步骤、或跟踪进度时，用 tasks，而不是存记忆。tasks 很适合持久化当前对话中需要完成的工作信息，而记忆应当保留给未来对话中有用的信息。',
      '',
      '{{SCOPE_GUIDANCE}}',
    ].join('\n'),
    scopeGuidance: {
      user: '- 由于这是 user 作用域的记忆，请保持学习成果的通用性，因为它们适用于所有项目',
      project: '- 由于这是 project 作用域的记忆，通过版本控制与团队共享，请让你的记忆针对本项目',
      local: '- 由于这是 local 作用域的记忆（不纳入版本控制），请让你的记忆针对本机和本项目',
    },
    indexHeading: '## MEMORY.md',
    emptyIndex: '你的 MEMORY.md 目前为空。保存新记忆后，它们会出现在这里。',
  },
}

/**
 * Build the persistent-memory prompt for one sub-agent.
 *
 * Assembly: the template with the memory root and scope guidance substituted,
 * a blank line, the index heading, a blank line, and finally the index
 * content — or the language's baseline sentence when the index is empty.
 *
 * @param {{indexContent?: string, rootDir: string,
 *          scope: 'user' | 'project' | 'local', lang?: 'en' | 'zh'}} input
 *   `indexContent` is the index text as it should reach the model (already
 *   normalized — see the module note); a blank or whitespace-only value
 *   falls back to the baseline sentence. `rootDir` is terminated with a
 *   path separator before substitution. `lang` defaults to `'en'`.
 * @returns {string} the complete prompt.
 * @throws {TypeError} when `lang`, `scope` or `rootDir` is not usable.
 */
export function buildAgentMemoryPrompt(input) {
  const { indexContent, rootDir, scope, lang = 'en' } = input ?? {}
  const dictionary = AGENT_MEMORY_PROMPTS[lang]
  if (dictionary === undefined) {
    throw new TypeError(
      `buildAgentMemoryPrompt: lang must be one of ${AGENT_MEMORY_PROMPT_LANGS.join(', ')}, received ${JSON.stringify(lang)}`,
    )
  }
  if (!isAgentMemoryScope(scope)) {
    throw new TypeError(
      'buildAgentMemoryPrompt: scope must be one of user, project, local',
    )
  }
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new TypeError('buildAgentMemoryPrompt: rootDir must be a non-empty string')
  }

  const memoryRoot = rootDir.endsWith(sep) ? rootDir : `${rootDir}${sep}`
  const index = typeof indexContent === 'string' ? indexContent.trim() : ''
  const body = dictionary.template
    .replaceAll(MEMORY_ROOT_TOKEN, memoryRoot)
    .replaceAll(SCOPE_GUIDANCE_TOKEN, dictionary.scopeGuidance[scope])
  return [
    body,
    '',
    dictionary.indexHeading,
    '',
    index.length > 0 ? index : dictionary.emptyIndex,
  ].join('\n')
}
