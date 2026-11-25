/**
 * The two injection layers of one memory root.
 *
 * A memory's type decides *how it reaches the model*, not only how it is
 * classified, because "applies to every turn" and "applies when its topic
 * comes up" cost completely different amounts of attention:
 *
 *  - `user` and `feedback` describe how to work, so they are **always on**:
 *    their text is injected into every prompt, with the rationale lines
 *    (`**Why:**` / `**How to apply:**`) stripped so only the rule is read.
 *    This is the only memory text the model cannot avoid, so it carries a hard
 *    budget — over budget the layer is truncated and says so, and the model is
 *    told to merge or delete rather than to keep growing it.
 *  - `project` and `reference` describe things that come up occasionally, so
 *    they are **on file**: only a one-line pointer is injected and the body is
 *    loaded on demand with the `memory` tool.
 *
 * The injected view is driven by `MEMORY.md`: an entry that has no pointer line
 * is not injected, which keeps the index file authoritative for what the model
 * sees. The manifest only supplies what the index line cannot — the type, the
 * body and recency — and the order is newest first, so a truncation drops the
 * oldest entry rather than an arbitrary one.
 *
 * Pure module: no I/O. `MemoryStore.readPromptView` supplies the pointers, the
 * manifest and the bodies.
 *
 * @module dsh-memory/layers
 */

import { formatMemoryIndexContent } from './memory-index.js'

/** The types that are injected as text on every turn. */
export const ALWAYS_ON_TYPES = ['user', 'feedback']

/** The one file the always-on `feedback` layer belongs in. */
export const ALWAYS_ON_FILE = 'how_to_work.md'

/** The rationale lines an always-on rule does not need. */
const RATIONALE_LINE_RE = /^\s*(?:[-*+]\s+)?\*\*(?:Why|How to apply):\*\*/u

/** A line that is nothing but an HTML comment — maintenance noise, not a rule. */
const COMMENT_LINE_RE = /^\s*<!--[\s\S]*-->\s*$/u

/**
 * A frontmatter block that ended up *inside* a body — a memory written with its
 * own header pasted in. It is stripped for the same reason the index renderer
 * strips a leading block: `name:` / `metadata:` lines are format, not rules, and
 * they must not be re-read on every turn.
 */
const DUPLICATED_FRONTMATTER_RE = /^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u

/** Budget fallbacks, used when a caller passes none. */
export const ALWAYS_ON_LINE_LIMIT = 10
export const ALWAYS_ON_CHAR_LIMIT = 800

/**
 * @param {unknown} type
 * @returns {boolean} whether a memory of this type is injected on every turn.
 */
export function isAlwaysOnType(type) {
  return typeof type === 'string' && ALWAYS_ON_TYPES.includes(type)
}

/**
 * The rule an always-on entry contributes: its body without the rationale,
 * maintenance-comment and blank lines, so what is left is the rule itself and
 * the line budget counts rules rather than formatting.
 *
 * A body may keep its `**Why:**` / `**How to apply:**` lines — they stay in the
 * file for an on-demand read — they are simply not worth every turn.
 *
 * @param {unknown} body
 * @returns {string}
 */
export function renderAlwaysOnText(body) {
  return stripDuplicatedFrontmatter(String(body ?? ''))
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !RATIONALE_LINE_RE.test(line) && !COMMENT_LINE_RE.test(line))
    .join('\n')
    .trim()
}

/**
 * Drop a leading block only when it actually looks like frontmatter (a `name:`,
 * `description:` or `metadata:` line), so a body that opens with a horizontal
 * rule survives.
 * @param {string} text
 * @returns {string}
 */
function stripDuplicatedFrontmatter(text) {
  const match = DUPLICATED_FRONTMATTER_RE.exec(text)
  if (match === null) return text
  if (!/^(?:name|description|metadata)\s*:/mu.test(match[1])) return text
  return text.slice(match[0].length)
}

/**
 * The rule an always-on entry contributes: its body without the rationale lines,
 * falling back to the index hook when the body is *nothing but* rationale — a
 * memory whose fact lives only in its `description` must still reach the model,
 * because dropping the entry silently is how a rule disappears unnoticed.
 *
 * @param {unknown} body
 * @param {unknown} hook
 * @returns {string}
 */
export function alwaysOnRuleText(body, hook) {
  const fromBody = renderAlwaysOnText(body)
  return fromBody !== '' ? fromBody : renderAlwaysOnText(hook)
}

/**
 * The rendered prompt view of one memory root: the always-on layer as text,
 * then the on-demand layer as pointers, then whatever the budgets left out.
 *
 * @param {{pointers?: ReadonlyMap<string, {title?: string, hook?: string}>,
 *   entries?: readonly Array<{filename: string, type?: string, description?: string}>,
 *   bodies?: ReadonlyMap<string, string>,
 *   indexLimits?: {lineLimit?: number, charLimit?: number},
 *   alwaysOnLimits?: {lineLimit?: number, charLimit?: number}}} input
 * @returns {string} the injection text, or `''` when the index has no pointers.
 */
export function formatLayeredMemoryIndex(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries : []
  const ordered = orderByManifest(input.pointers ?? new Map(), entries)
  const alwaysOn = ordered.filter((pointer) => isAlwaysOnType(pointer.type))
  const onDemand = ordered.filter((pointer) => !isAlwaysOnType(pointer.type))

  const blocks = []
  const alwaysOnBlock = renderAlwaysOnBlock({
    pointers: alwaysOn,
    bodies: input.bodies ?? new Map(),
    limits: input.alwaysOnLimits,
  })
  if (alwaysOnBlock !== '') blocks.push(alwaysOnBlock)
  const onDemandBlock = renderOnDemandBlock({ pointers: onDemand, indexLimits: input.indexLimits })
  if (onDemandBlock !== '') blocks.push(onDemandBlock)
  return blocks.join('\n\n')
}

/**
 * The always-on layer's own usage, so a caller can report it back — the write
 * path tells the model the layer's state the moment it writes into it.
 *
 * @param {{entries?: readonly Array<{filename: string, type?: string}>,
 *   bodies?: ReadonlyMap<string, string>,
 *   pointers?: ReadonlyMap<string, {title?: string, hook?: string}>,
 *   limits?: {lineLimit?: number, charLimit?: number}}} input
 * @returns {{files: number, lines: number, chars: number, lineLimit: number, charLimit: number, overBudget: boolean}}
 */
export function alwaysOnUsage(input = {}) {
  const bodies = input.bodies ?? new Map()
  const pointers = input.pointers ?? new Map()
  // Index-driven, like the injected block: a memory file with no `MEMORY.md`
  // pointer is not injected at all, so counting it here would report a layer
  // the prompt does not carry.
  const entries = (Array.isArray(input.entries) ? input.entries : [])
    .filter((entry) => isAlwaysOnType(entry.type) && pointers.has(entry.filename))
  const lineLimit = positiveOr(input.limits?.lineLimit, ALWAYS_ON_LINE_LIMIT)
  const charLimit = positiveOr(input.limits?.charLimit, ALWAYS_ON_CHAR_LIMIT)

  let files = 0
  let lines = 0
  let chars = 0
  for (const entry of entries) {
    const text = alwaysOnRuleText(bodies.get(entry.filename), pointerHook(pointers, entry.filename))
    if (text === '') continue
    files += 1
    lines += text.split('\n').length
    chars += charsOf(text)
  }
  return {
    files,
    lines,
    chars,
    lineLimit,
    charLimit,
    overBudget: lines > lineLimit || chars > charLimit,
  }
}

/* ----------------------------------------------------------------- render ---- */

/**
 * @param {{pointers: readonly {filename: string, title: string, hook: string}[],
 *   bodies: ReadonlyMap<string, string>, limits?: {lineLimit?: number, charLimit?: number}}} input
 * @returns {string}
 */
function renderAlwaysOnBlock({ pointers, bodies, limits }) {
  const chunks = []
  for (const pointer of pointers) {
    const text = alwaysOnRuleText(bodies.get(pointer.filename), pointer.hook)
    if (text !== '') chunks.push(text)
  }
  if (chunks.length === 0) return ''

  const lineLimit = positiveOr(limits?.lineLimit, ALWAYS_ON_LINE_LIMIT)
  const charLimit = positiveOr(limits?.charLimit, ALWAYS_ON_CHAR_LIMIT)
  const kept = []
  let lines = 0
  let chars = 0
  let truncated = false
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      const cost = charsOf(line) + (kept.length === 0 ? 0 : 1)
      if (lines + 1 > lineLimit || chars + cost > charLimit) {
        truncated = true
        break
      }
      kept.push(line)
      lines += 1
      chars += cost
    }
    if (truncated) break
  }

  const notices = []
  if (truncated) {
    notices.push(`> The always-on layer is over its budget (${lineLimit} lines / ${charLimit} characters), so the rest was not injected. Merge or delete before adding more.`)
  }
  for (const [type, count] of countByType(pointers)) {
    // One file per type is the healthy shape, so the notice names the type that
    // actually has more than one rather than counting files overall.
    if (count <= 1) continue
    const target = type === 'feedback' ? ` — \`feedback\` rules belong in \`${ALWAYS_ON_FILE}\`` : ''
    notices.push(`> The always-on layer has ${count} \`${type}\` files. Keep one file per type${target}.`)
  }

  return ['## Always on — how you work', ...kept, ...notices].join('\n')
}

/**
 * @param {readonly {type?: string}[]} pointers
 * @returns {Map<string, number>} how many always-on files each type occupies.
 */
function countByType(pointers) {
  const counts = new Map()
  for (const pointer of pointers) {
    const type = typeof pointer.type === 'string' ? pointer.type : 'unknown'
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return counts
}

/**
 * @param {{pointers: readonly {filename: string, title: string, hook: string}[], indexLimits?: {lineLimit?: number, charLimit?: number}}} input
 * @returns {string}
 */
function renderOnDemandBlock({ pointers, indexLimits }) {
  if (pointers.length === 0) return ''
  const lines = pointers.map((pointer) => (pointer.hook.length === 0
    ? `- [${pointer.title}](${pointer.filename})`
    : `- [${pointer.title}](${pointer.filename}) \u2014 ${pointer.hook}`))
  const trimmed = formatMemoryIndexContent(lines.join('\n'), indexLimits)
  if (trimmed === '') return ''
  return ['## On file — read a body when its topic comes up', trimmed].join('\n')
}

/* ------------------------------------------------------------------ order ---- */

/**
 * Pointers in manifest order (newest first). A pointer whose file the manifest
 * does not know — a dangling index line, or a file written outside the index —
 * keeps its place at the end rather than being dropped silently.
 * @param {ReadonlyMap<string, {title?: string, hook?: string}>} pointers
 * @param {readonly {filename: string}[]} entries
 * @returns {Array<{filename: string, title: string, hook: string}>}
 */
function orderByManifest(pointers, entries) {
  const rank = new Map(entries.map((entry, index) => [entry.filename, index]))
  const types = new Map(entries.map((entry) => [entry.filename, entry.type]))
  return [...pointers.entries()]
    .map(([filename, pointer]) => ({
      filename,
      title: typeof pointer?.title === 'string' ? pointer.title : filename,
      hook: typeof pointer?.hook === 'string' ? pointer.hook : '',
      type: types.get(filename),
    }))
    .sort((left, right) => rankOf(rank, left.filename) - rankOf(rank, right.filename))
}

/**
 * @param {ReadonlyMap<string, number>} rank
 * @param {string} filename
 * @returns {number}
 */
function rankOf(rank, filename) {
  const index = rank.get(filename)
  return index === undefined ? Number.MAX_SAFE_INTEGER : index
}

/* ------------------------------------------------------------------- misc ---- */

/**
 * @param {ReadonlyMap<string, {hook?: string}>} pointers
 * @param {string} filename
 * @returns {string | undefined}
 */
function pointerHook(pointers, filename) {
  const hook = pointers.get(filename)?.hook
  return typeof hook === 'string' ? hook : undefined
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * @param {string} text
 * @returns {number} code points, so a CJK rule is budgeted the way it reads.
 */
function charsOf(text) {
  return Array.from(text).length
}
