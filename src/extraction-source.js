/**
 * DSH 会话事件 → 规范化消息，以及给抽取提示词用的 transcript 渲染。
 *
 * 本模块只保留**机制**：事件流规范化与 transcript 渲染。所有**策略**——
 * 哪些工具算记忆直写、多长的用户文本值得抽取——都在
 * `src/extraction-trigger.js`，由宿主在调 {@link normalizeMessages} 之后使用。
 *
 * 宿主自己用 `ctx.sessionQuery.readEvent()` 分页切窗（每页 `before ≤ 50`、
 * 总量上限 500 事件），所以本模块不提供切窗函数；游标只以不透明
 * `'seq:<n>'` token 的形态存在于 `src/cursor-store.js`。
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ 事件形状：已由 docs/probes.md P2 节验证（不再是假设）                      │
 * │  - P2.1 `SessionEvent = {type, seq, time, data, ignorable?}`             │
 * │  - P2.2 `'user/message'` 的 data 就是整个 UserMessage；                   │
 * │         `'assistant/message'` 的内容在 `data.message.content`；           │
 * │         `'tool/call'` = `{turn, step, callId, name, arguments}`           │
 * │  - P2.3 **没有** synthetic / visibility / ignored 字段；合成消息唯一判据是   │
 * │         `event.data.source.kind !== 'user'`                              │
 * │  - P2.4 tool-call 的 `arguments` 是**未解析的 JSON 字符串**，               │
 * │         `file_path` 在它内部，必须 `JSON.parse`                            │
 * │  - P2.7 游标用 `SessionSeq`（`event.seq`），不要用 MessageId               │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 规范化消息契约（本模块与 trigger / 宿主的接口，不要改）：一次工具调用 = 一条
 * NormalizedMessage（展开式）。
 *
 * @module dsh-memory/extraction-source
 */

/**
 * One normalized conversation message — the contract with
 * `src/extraction-trigger.js` and the host. Do not change the shape.
 *
 * 一次工具调用展开成一条消息：一个发出两次工具调用的助手回合会变成两条消息，各带
 * 自己的 `toolName` / `toolInput`。
 * @typedef {{ id: string, role: 'user' | 'assistant', text?: string, sourceKind?: string,
 *   toolName?: string, toolInput?: Record<string, unknown> }} NormalizedMessage
 */

/** 已验证的 DSH 事件类型名（docs/probes.md P2.2）。 */
const EVENT_USER_MESSAGE = 'user/message'
const EVENT_ASSISTANT_MESSAGE = 'assistant/message'
const EVENT_TOOL_CALL = 'tool/call'

/* ------------------------------------------------------------ 纯函数层 ---- */

/**
 * Render a window of normalized messages as one plain-text transcript for the
 * extraction prompt. 用户消息标 `[user]`、助手文本标 `[assistant]`、工具调用标
 * `[tool] name`（带 `file_path` 时 `[tool] name(file_path)`），空块跳过。
 *
 * 这是**纯渲染**：不过滤合成消息（`sourceKind !== 'user'` 的注入也会按 `[user]`
 * 渲染），也不切窗。「哪些文本值得抽取」由 `extraction-trigger.js` 的判据负责。
 *
 * @param {readonly NormalizedMessage[] | undefined} messages
 * @returns {string} 一行一块，`\n` 连接；没有可渲染内容时返回空串。
 */
export function renderTranscript(messages) {
  const lines = []
  for (const message of asMessageList(messages)) {
    if (!isRecord(message)) continue
    if (typeof message.toolName === 'string' && message.toolName.length > 0) {
      lines.push(renderToolLine(message))
      continue
    }
    if (typeof message.text !== 'string' || message.text.trim().length === 0) continue
    const label = message.role === 'user' ? '[user]' : '[assistant]'
    lines.push(`${label} ${message.text}`)
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------ 适配层 ---- */

/**
 * Map a raw DSH session-event stream to normalized messages. 输入就是宿主从
 * `ctx.sessionQuery.readEvent(...).events`（或 `readSession(...).events`）拿到的
 * `SessionEvent[]`，顺序即日志顺序。
 *
 * 映射规则（docs/probes.md P2.2–P2.4 已验证）：
 *
 * - `user/message`：`data` 就是整个 `UserMessage`；所有 `type==='text'` 的 block
 *   用 `\n` 拼成 `text`；`sourceKind = data.source?.kind`（P2.3：唯一合成判据）。
 *   即使一个文本块都没有也保留这条消息（没有 text），游标才能锚到它。
 * - `assistant/message`：内容在 `data.message.content`（兼容 `data.content`）；
 *   每个文本块 → 一条带 `text` 的助手消息；每个 `type==='tool-call'` 块 → 一条带
 *   `toolName` / `toolInput` 的助手消息（一次调用一条）。
 * - `tool/call`：双保险 —— `{turn, step, callId, name, arguments}` 是「工具调用
 *   只记在独立事件里」时的兜底。真实日志里它和 assistant 消息里的 tool-call 块
 *   **成对出现且携带同一个 callId**（agent-loop `src/tool-calls.ts:264`：
 *   `session.append('tool/call', {callId: block.id, name: block.name,
 *   arguments: block.arguments})`），所以按 callId 去重，保证契约上的
 *   「一次工具调用 = 一条 NormalizedMessage」，transcript 也不会出现两行。
 * - 其它事件类型（`turn/start`、`turn/end`、`step/*`、`tool/result`、
 *   `system/message`、`developer/message`、surface 元事件……）忽略：它们既不是
 *   用户文本，也不携带可判定的记忆写入。
 * - 容错：任何字段缺失都不能抛异常，一律降级跳过；单条事件包 try/catch，
 *   失败返回已解析的部分。
 *
 * 消息 id（游标配对用）：`String(event.seq)`。P2.7 明确游标要用 `SessionSeq`
 * （单调 = log index，查询接口按它寻址），MessageId 是无序 UUID、查询接口不接受。
 * 取不到 seq 时退化为 `data.id` / `event.id` / `event-<下标>`。同一事件展开出的
 * 多条消息**共享**这个事件级 id，因此按 id 匹配游标时命中最后一条——窗口切分本身
 * 由宿主的 `readEvent` 分页负责（`host/extract.js`），不在这里做。
 *
 * @param {readonly unknown[] | undefined} rawEvents
 * @returns {NormalizedMessage[]}
 */
export function normalizeMessages(rawEvents) {
  const out = []
  if (!Array.isArray(rawEvents)) return out
  // 已展开过的工具调用 id：assistant/message 的 tool-call 块与独立的 tool/call
  // 事件携带同一个 callId（见上方映射规则），只展开第一次。
  const seenToolCallIds = new Set()
  for (let index = 0; index < rawEvents.length; index += 1) {
    let produced
    try {
      produced = normalizeEvent(rawEvents[index], index, seenToolCallIds)
    } catch {
      // 单条事件畸形：跳过它，绝不让整轮抽取失败。
      produced = []
    }
    for (const message of produced) out.push(message)
  }
  return out
}

/* -------------------------------------------------------------- 内部 ---- */

/**
 * @param {readonly NormalizedMessage[] | undefined} messages
 * @returns {readonly NormalizedMessage[]}
 */
function asMessageList(messages) {
  return Array.isArray(messages) ? messages : []
}

/**
 * @param {NormalizedMessage} message
 * @returns {string}
 */
function renderToolLine(message) {
  const filePath = isRecord(message.toolInput) && typeof message.toolInput.file_path === 'string'
    && message.toolInput.file_path.length > 0
    ? message.toolInput.file_path
    : undefined
  return filePath === undefined ? `[tool] ${message.toolName}` : `[tool] ${message.toolName}(${filePath})`
}

/**
 * @param {unknown} event
 * @param {number} index
 * @param {Set<string>} seenToolCallIds
 * @returns {NormalizedMessage[]}
 */
function normalizeEvent(event, index, seenToolCallIds) {
  if (!isRecord(event)) return []
  const type = event.type
  const data = event.data
  if (typeof type !== 'string' || !isRecord(data)) return []
  if (type === EVENT_USER_MESSAGE) return normalizeUserEvent(event, data, index)
  if (type === EVENT_ASSISTANT_MESSAGE) return normalizeAssistantEvent(event, data, index, seenToolCallIds)
  if (type === EVENT_TOOL_CALL) return normalizeToolCallEvent(event, data, index, seenToolCallIds)
  return []
}

/**
 * P2.2：`data` 就是整个 `UserMessage`（`{role, id, content, source}`）。
 * @param {Record<string, unknown>} event
 * @param {Record<string, unknown>} data
 * @param {number} index
 * @returns {NormalizedMessage[]}
 */
function normalizeUserEvent(event, data, index) {
  const blocks = Array.isArray(data.content) ? data.content : undefined
  if (blocks === undefined) return []
  const text = joinTextBlocks(blocks)
  /** @type {NormalizedMessage} */
  const message = { id: deriveMessageId(event, data, index), role: 'user' }
  if (text.length > 0) message.text = text
  const sourceKind = nonEmptyString(isRecord(data.source) ? data.source.kind : undefined)
  if (sourceKind !== undefined) message.sourceKind = sourceKind
  return [message]
}

/**
 * P2.2：内容在 `data.message.content`（`AssistantMessage`），为兼容也接受
 * `data.content`。文本块与 tool-call 块各自展开（P2.4：`arguments` 是未解析的
 * JSON 字符串）。
 * @param {Record<string, unknown>} event
 * @param {Record<string, unknown>} data
 * @param {number} index
 * @param {Set<string>} seenToolCallIds
 * @returns {NormalizedMessage[]}
 */
function normalizeAssistantEvent(event, data, index, seenToolCallIds) {
  const inner = isRecord(data.message) ? data.message : undefined
  const blocks = Array.isArray(inner?.content)
    ? inner.content
    : Array.isArray(data.content) ? data.content : undefined
  if (blocks === undefined) return []
  const id = deriveMessageId(event, data, index)
  const sourceKind = nonEmptyString(isRecord(inner?.source) ? inner.source.kind : undefined)
  /** @type {NormalizedMessage[]} */
  const out = []
  blocks.forEach((block) => {
    if (!isRecord(block)) return
    if (block.type === 'text') {
      const text = nonEmptyString(block.text)
      if (text === undefined) return
      /** @type {NormalizedMessage} */
      const message = { id, role: 'assistant', text }
      if (sourceKind !== undefined) message.sourceKind = sourceKind
      out.push(message)
      return
    }
    if (block.type !== 'tool-call') return
    if (!claimToolCall(seenToolCallIds, nonEmptyString(block.id))) return
    const expanded = expandToolCall({ id, name: block.name, arguments: block.arguments })
    if (expanded !== undefined) out.push(expanded)
  })
  return out
}

/**
 * 双保险：工具调用只记在独立 `tool/call` 事件里时的兜底（P2.2）。与 assistant
 * 消息里的 tool-call 块按 callId 去重。
 * @param {Record<string, unknown>} event
 * @param {Record<string, unknown>} data
 * @param {number} index
 * @param {Set<string>} seenToolCallIds
 * @returns {NormalizedMessage[]}
 */
function normalizeToolCallEvent(event, data, index, seenToolCallIds) {
  if (!claimToolCall(seenToolCallIds, nonEmptyString(data.callId))) return []
  const expanded = expandToolCall({
    id: deriveMessageId(event, data, index),
    name: data.name,
    arguments: data.arguments,
  })
  return expanded === undefined ? [] : [expanded]
}

/**
 * 占住一个工具调用 id：没有 id 的调用无法去重，照常展开；已展开过同 id 的调用
 * （assistant 消息里的 tool-call 块）则跳过，避免同一次调用产出两条消息。
 * @param {Set<string>} seenToolCallIds
 * @param {string | undefined} callId
 * @returns {boolean} 是否继续展开。
 */
function claimToolCall(seenToolCallIds, callId) {
  if (callId === undefined) return true
  if (seenToolCallIds.has(callId)) return false
  seenToolCallIds.add(callId)
  return true
}

/**
 * 展开一条工具调用。`arguments` 解析失败（或不是对象）时返回 undefined —— 调用方
 * 跳过该调用，不抛（没有参数就没有 `file_path`，对判定没有任何损失）。
 * @param {{id: string, name: unknown, arguments: unknown}} call
 * @returns {NormalizedMessage | undefined}
 */
function expandToolCall({ id, name, arguments: rawArguments }) {
  const toolName = nonEmptyString(name)
  if (toolName === undefined) return undefined
  const toolInput = parseToolArguments(rawArguments)
  if (toolInput === undefined) return undefined
  return { id, role: 'assistant', toolName, toolInput }
}

/**
 * P2.4：`arguments` 是未解析的原始 JSON 字符串，`file_path` 在它内部。空串按官方
 * `parseLoggedArguments` 的写法当作 `{}`；解析失败 / 结果不是对象 → undefined。
 * 已经给对象的（宿主预解析过）直接接受。
 * @param {unknown} rawArguments
 * @returns {Record<string, unknown> | undefined}
 */
function parseToolArguments(rawArguments) {
  if (isRecord(rawArguments)) return rawArguments
  if (typeof rawArguments !== 'string' || rawArguments.length === 0) {
    return rawArguments === '' ? {} : undefined
  }
  try {
    const parsed = JSON.parse(rawArguments)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {readonly unknown[]} blocks
 * @returns {string}
 */
function joinTextBlocks(blocks) {
  const parts = []
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== 'text') continue
    const text = nonEmptyString(block.text)
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

/**
 * P2.7：游标用 `SessionSeq`，所以 id 首选 `String(event.seq)`；取不到再退化成
 * 消息 id / 事件 id / 下标。
 * @param {Record<string, unknown>} event
 * @param {Record<string, unknown>} data
 * @param {number} index
 * @returns {string}
 */
function deriveMessageId(event, data, index) {
  if (typeof event.seq === 'number' && Number.isFinite(event.seq)) return String(event.seq)
  for (const candidate of [data.id, data.messageId, event.id]) {
    const id = nonEmptyString(candidate)
    if (id !== undefined) return id
  }
  return `event-${index}`
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @returns {string | undefined} */
function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
