/**
 * The `memory` tool: the validated write path for explicit saves.
 *
 * The agent can also write memory files directly with `write`/`edit`; that
 * still works here (see `host/permission.js`). This tool exists so a save is
 * one call instead of "write the file, then remember to update the index":
 * it validates the path, renders the frontmatter, stamps the origin, writes
 * the file, and maintains the index pointer.
 *
 * Failure contract — every failure is a RETURNED VALUE, never a throw:
 *
 * - success            `{ ok: true, action, …payload }`
 * - bad arguments      `{ ok: false, action?, error }` — detected before any
 *                      I/O, no warn (a caller mistake is not an internal
 *                      fault, so there is nothing for an operator to act on)
 * - unexpected failure `{ ok: false, action, error }` — same channel, plus a
 *                      `logger.warn`, message preserved verbatim
 *
 * The argument errors are reported on the tool's own `ok` channel rather than
 * re-thrown because the output contract already models failure as a value
 * (`renderResult` renders `memory: <error>`, and the "memory is not available"
 * branch established the shape in P0); an `isError` result with a stack is
 * less actionable for the model than "the write failed because …". It is not
 * silent swallowing: unexpected failures still log a warn.
 *
 * @module dsh-memory/host/tool
 */

import { basename } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { isAlwaysOnType } from '../src/memory-layers.js'
import { formatMemoryManifest } from '../src/memory-manifest.js'
import { parseMemoryFile } from '../src/memory-format.js'
import { parseMemoryIndexPointers } from '../src/memory-index.js'
import { auditMemory } from '../src/memory-audit.js'
import { memoryWidthPreset } from '../src/memory-width.js'
import { configValue } from '../src/config-value.js'
import { readProjectMemoryFileFromStableHandle } from '../src/stable-read.js'

/** JSON Schema for the tool's canonical output. */
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

/**
 * Body-scan budget for `search`. Filename and `description` hits are always
 * cheap and always counted; reading bodies to look for a substring is capped so
 * a large memory root cannot turn one query into an unbounded read. A file
 * larger than the per-file cap is never body-scanned, and the running total
 * stops the scan once it would exceed the overall budget — `truncated: true`
 * tells the caller some bodies were skipped.
 */
const SEARCH_MAX_TOTAL_BODY_BYTES = 2 * 1024 * 1024
const SEARCH_MAX_FILE_BODY_BYTES = 512 * 1024

/** JSON Schema for the tool's arguments. */
const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'read', 'write', 'search', 'forget', 'audit'],
      description: 'list the memory index; read one memory file; write or update one memory file; search file names, summaries and bodies; forget (delete) one memory file; audit (read-only) to report duplicates, dangling pointers, unindexed files, one-type-per-layer conflicts and over-budget layers as a merge list — it never modifies anything.',
    },
    file: {
      type: 'string',
      description: 'Bare Markdown file name inside the memory root, e.g. "user_role.md". Required by read, write and forget. Never a directory, never "..", never MEMORY.md.',
    },
    name: {
      type: 'string',
      description: 'The frontmatter `name` slug used by [[name]] links, e.g. "user-role". Defaults to a slug of the title.',
    },
    title: { type: 'string', description: 'Short human title used as the MEMORY.md index label. Required by write.' },
    hook: { type: 'string', description: 'One-line index hook, at most 150 characters. Required by write. Never memory content.' },
    type: {
      type: 'string',
      enum: ['user', 'feedback', 'project', 'reference'],
      description: 'Memory type. Required by write. `user` and `feedback` are injected as text into every turn — keep one file per type, and put `feedback` rules in how_to_work.md; `project` and `reference` inject a one-line pointer only and are read on demand.',
    },
    description: { type: 'string', description: 'One-line summary used to decide relevance during recall. Required by write.' },
    body: { type: 'string', description: 'The complete Markdown body of the memory. Required by write.' },
    query: { type: 'string', description: 'Case-insensitive substring matched against file name, summary and body. Required by search.' },
  },
  required: ['action'],
  additionalProperties: false,
}

/**
 * Arguments each action requires, checked before any I/O runs. A `Map` rather
 * than an object literal so an action like `constructor` or `__proto__`
 * cannot reach `Object.prototype` and turn validation into a crash. The order
 * is the reporting order: the first problem found is the one the caller sees.
 * `list` needs nothing, and an action missing from this map is reported by the
 * switch's default branch instead.
 */
const REQUIRED_ARGUMENTS = new Map([
  ['list', []],
  ['read', ['file']],
  ['write', ['file', 'title', 'hook', 'type', 'description', 'body']],
  ['search', ['query']],
  ['forget', ['file']],
  ['audit', []],
])

/**
 * Build the memory tool definition.
 * @param {{registry: import('./context.js').MemoryContextRegistry, logger?: {warn: (message: string) => void}}} options
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function createMemoryTool({ registry, logger }) {
  return {
    name: 'memory',
    description: 'Manage your persistent file-based memory. One memory is one Markdown file with YAML frontmatter (name, description, metadata.type). The MEMORY.md index is maintained for you — never write to it yourself. Use "write" to save or update a memory, "list" to see the index, "read" to load one file, "search" to find a memory by substring, "forget" to delete one, and "audit" to get a read-only maintenance report (duplicates, dangling pointers, unindexed files, over-budget layers, merge suggestions).',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      const memory = memoryFor(registry, exec)
      if (memory === undefined) {
        return { ok: false, error: 'memory is not available for this session' }
      }
      const action = args?.action

      // Phase 1 — argument shape, before anything else runs. A missing or
      // mistyped argument is a caller mistake, not a fault, so it is reported
      // through the tool's own `{ ok: false, error }` channel instead of
      // throwing, and without a warn: nothing internal is broken. The shape
      // matches the success path minus its payload (`action` is included
      // whenever the caller named a known action).
      const argumentError = validateArguments(args, action)
      if (argumentError !== undefined) {
        return typeof action === 'string' && action.length > 0
          ? { ok: false, action, error: argumentError }
          : { ok: false, error: argumentError }
      }

      // Phase 2 — the work itself. `validateArguments` already proved every
      // argument this action reads is a non-empty string, so the trims below
      // cannot fail.
      try {
        switch (action) {
          case 'list':
            return { ok: true, action, root: memory.rootDir, entries: await memory.store.manifest() }
          case 'read':
            return { ok: true, action, ...(await memory.store.readMemoryFile(args.file.trim())) }
          case 'write': {
            const written = await memory.store.writeMemory({
              file: args.file.trim(),
              title: args.title.trim(),
              hook: args.hook.trim(),
              frontmatter: {
                name: typeof args.name === 'string' && args.name.trim().length > 0
                  ? args.name.trim()
                  : slugify(args.title.trim()),
                description: args.description.trim(),
                type: args.type.trim(),
              },
              body: args.body.trim(),
            })
            // An always-on entry is re-read on every turn, so its layer's
            // budget is reported back the moment one lands there. A failure to
            // measure it must not fail a write that already succeeded.
            let alwaysOn
            if (isAlwaysOnType(args.type.trim())) {
              try {
                alwaysOn = await memory.store.alwaysOnLayerUsage(registry.alwaysOnLimits())
              } catch {
                alwaysOn = undefined
              }
            }
            return { ok: true, action, ...written, ...(alwaysOn === undefined ? {} : { alwaysOn }) }
          }
          case 'search': {
            const found = await search(memory, args.query.trim())
            return { ok: true, action, root: memory.rootDir, matches: found.matches, truncated: found.truncated }
          }
          case 'forget': {
            const { deleted } = await memory.store.deleteMemory(args.file.trim())
            return { ok: true, action, file: args.file.trim(), deleted }
          }
          case 'audit':
            return await runAudit(memory, registry)
          default:
            return { ok: false, error: `unknown action: ${String(action)}` }
        }
      } catch (error) {
        // An unexpected failure: I/O, storage, or a store-level rejection such
        // as an unsafe file name. It stays on the same `{ ok: false, action,
        // error }` channel rather than being re-thrown — the tool's contract
        // models failure as a value and the model can act on "the write
        // failed because …" — but it is NOT swallowed silently: the warn keeps
        // it visible to the operator and the original message is preserved
        // verbatim so nothing is lost.
        const message = error instanceof Error ? error.message : String(error)
        logger?.warn(`memory: ${String(action)} failed: ${message}`)
        return { ok: false, action, error: message }
      }
    },
  }
}

/**
 * @param {import('./context.js').MemoryContextRegistry} registry
 * @param {import('@deepseek-ai/dsh-tools').ToolRunContext} exec
 * @returns {import('./context.js').AgentMemoryContext | undefined}
 */
function memoryFor(registry, exec) {
  const sessionId = exec?.agent?.session?.id
  return typeof sessionId === 'string' ? registry.get(sessionId) : undefined
}

/**
 * Check the argument shape for `action` before any work runs. This replaces
 * the old throwing `requireString` / `requireFile` helpers: a caller mistake
 * is data, not an exception.
 * @param {unknown} args
 * @param {unknown} action
 * @returns {string | undefined} the problem, or undefined when the arguments
 *   are usable (an unknown action is left to the switch's default branch).
 */
function validateArguments(args, action) {
  if (typeof args !== 'object' || args === null) return 'arguments must be an object'
  if (typeof action !== 'string' || action.trim().length === 0) return 'action is required'

  const required = REQUIRED_ARGUMENTS.get(action)
  if (required === undefined) return undefined

  for (const name of required) {
    const problem = stringArgumentProblem(args[name], name)
    if (problem !== undefined) return problem
  }

  // `name` is optional and an empty one keeps its documented fallback to a
  // slug of the title, so only its type is checked — a non-string is still a
  // caller mistake and must not be silently ignored.
  if (args.name !== undefined && typeof args.name !== 'string') {
    return `name must be a string (received ${typeof args.name})`
  }
  return undefined
}

/**
 * One argument's problem, named so the caller can fix it: which parameter,
 * and what it should have been.
 * @param {unknown} value
 * @param {string} name
 * @returns {string | undefined}
 */
function stringArgumentProblem(value, name) {
  if (value === undefined || value === null) return `${name} is required`
  if (typeof value !== 'string') return `${name} must be a string (received ${typeof value})`
  if (value.trim().length === 0) return `${name} is required`
  return undefined
}

/**
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48) || 'memory'
}

/**
 * Gather the audit sources and hand them to the pure analyser
 * (`src/memory-audit.js`). Reads every manifest file once (bounded by
 * `MANIFEST_FILE_LIMIT`) to learn its `name:` slug and body size, which the
 * manifest scan does not carry; a file that vanishes mid-read keeps its entry
 * and is still reported on filename facts alone.
 *
 * @param {import('./context.js').AgentMemoryContext} memory
 * @param {import('./context.js').MemoryContextRegistry} registry
 * @returns {Promise<object>}
 */
async function runAudit(memory, registry) {
  const entries = await memory.store.manifest()
  const rawIndex = await memory.store.readRawIndex()
  const pointers = parseMemoryIndexPointers(rawIndex)

  const details = []
  for (const entry of entries) {
    let name
    let bodyChars
    try {
      const content = await readFile(entry.filePath, 'utf8')
      const parsed = parseMemoryFile(content)
      name = parsed.name
      bodyChars = Array.from(parsed.body ?? '').length
    } catch {
      // Keep the entry on filename facts alone.
    }
    details.push({
      filename: entry.filename,
      ...(entry.type === undefined ? {} : { type: entry.type }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(name === undefined ? {} : { name }),
      ...(bodyChars === undefined ? {} : { bodyChars }),
    })
  }

  // The always-on budget reuses the injected layer's own accounting, so the
  // report cannot disagree with what the prompt actually carries.
  let alwaysOn
  try {
    alwaysOn = await memory.store.alwaysOnLayerUsage(registry.alwaysOnLimits?.())
  } catch {
    alwaysOn = undefined
  }

  const width = configValue(registry.config?.memoryWidth)
  return auditMemory({
    rootDir: memory.rootDir,
    entries: details,
    pointers,
    indexLimits: registry.indexLimits?.(),
    alwaysOn,
    bodyCharLimit: memoryWidthPreset(width).bodyCharLimit,
    width,
  })
}

/**
 * Substring search over file name, description and body.
 *
 * Name/description hits are free and unlimited (the manifest is at most
 * `MANIFEST_FILE_LIMIT` entries). Body scanning is budgeted: a file above
 * {@link SEARCH_MAX_FILE_BODY_BYTES} is never read, and once the running total
 * would exceed {@link SEARCH_MAX_TOTAL_BODY_BYTES} the remaining bodies are
 * skipped and `truncated` is set, so the caller knows some files were not
 * body-searched.
 *
 * @param {import('./context.js').AgentMemoryContext} memory
 * @param {string} query
 * @returns {Promise<{matches: Array<{filename: string, description?: string, type?: string}>, truncated: boolean}>}
 */
async function search(memory, query) {
  const needle = query.toLowerCase()
  const entries = await memory.store.manifest()
  const matches = []
  let scanned = 0
  let truncated = false
  for (const entry of entries) {
    if (entry.filename.toLowerCase().includes(needle)
      || (entry.description ?? '').toLowerCase().includes(needle)) {
      matches.push(entry)
      continue
    }
    if (truncated) continue
    let size
    try {
      size = (await stat(entry.filePath)).size
    } catch {
      continue
    }
    if (size > SEARCH_MAX_FILE_BODY_BYTES || scanned + size > SEARCH_MAX_TOTAL_BODY_BYTES) {
      truncated = true
      continue
    }
    try {
      const { content } = await readProjectMemoryFileFromStableHandle({
        filePath: entry.filePath,
        validatePath: () => undefined,
      })
      scanned += content.length
      if (content.toLowerCase().includes(needle)) matches.push(entry)
    } catch {
      // Unreadable files simply do not match on body.
    }
  }
  return { matches, truncated }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function renderResult(value) {
  if (typeof value !== 'object' || value === null) return String(value)
  const record = value
  if (record.ok === false) return `memory: ${String(record.error ?? 'failed')}`
  const lines = []
  if (record.action === 'list' || record.action === 'search') {
    const entries = Array.isArray(record.entries) ? record.entries : record.matches
    lines.push(`memory root: ${String(record.root ?? '')}`)
    lines.push(entries.length === 0 ? '(no memories)' : formatMemoryManifest(entries))
    if (record.action === 'search' && record.truncated === true) {
      lines.push('(search truncated: some bodies were not scanned to stay within budget; refine the query)')
    }
    return lines.join('\n')
  }
  if (record.action === 'read') {
    return `--- ${String(record.file ?? '')} (updated ${new Date(Number(record.updatedAt ?? 0)).toISOString()}) ---\n${String(record.content ?? '')}`
  }
  if (record.action === 'write') {
    const name = basename(String(record.filePath ?? ''))
    const usage = record.alwaysOn
    if (typeof usage !== 'object' || usage === null) return `wrote ${name}`
    const budget = `always-on layer: ${Number(usage.lines ?? 0)}/${Number(usage.lineLimit ?? 0)} lines, ${Number(usage.chars ?? 0)}/${Number(usage.charLimit ?? 0)} characters`
    return usage.overBudget === true
      ? `wrote ${name} — ${budget}, OVER BUDGET: merge or delete before adding more.`
      : `wrote ${name} — ${budget}.`
  }
  if (record.action === 'forget') {
    return record.deleted === true
      ? `deleted ${String(record.file ?? '')}`
      : `no such memory: ${String(record.file ?? '')}`
  }
  if (record.action === 'audit') {
    return renderAudit(record)
  }
  return JSON.stringify(record, null, 2)
}

/**
 * Render an audit report as compact, actionable text. Read-only by design:
 * the closing line tells the caller to act on the files itself.
 * @param {object} record
 * @returns {string}
 */
function renderAudit(record) {
  const lines = [`memory audit: ${String(record.root ?? '')}`]
  const index = record.index
  if (typeof index === 'object' && index !== null) {
    const mark = index.overBudget === true ? ' — OVER BUDGET' : ''
    lines.push(`index (on-demand): ${index.pointerLines}/${index.lineLimit} lines, ${index.pointerChars}/${index.charLimit} characters${mark}`)
  }
  const alwaysOn = record.alwaysOn
  if (typeof alwaysOn === 'object' && alwaysOn !== null) {
    const mark = alwaysOn.overBudget === true ? ' — OVER BUDGET' : ''
    lines.push(`always-on layer: ${alwaysOn.lines}/${alwaysOn.lineLimit} lines, ${alwaysOn.chars}/${alwaysOn.charLimit} characters${mark}`)
  }

  const duplicates = Array.isArray(record.duplicates) ? record.duplicates : []
  const dangling = Array.isArray(record.danglingPointers) ? record.danglingPointers : []
  const unindexed = Array.isArray(record.unindexedFiles) ? record.unindexedFiles : []
  const conflicts = Array.isArray(record.conflicts) ? record.conflicts : []
  const oversized = Array.isArray(record.oversizedBodies) ? record.oversizedBodies : []
  const merge = Array.isArray(record.mergeCandidates) ? record.mergeCandidates : []

  if (duplicates.length > 0) {
    lines.push('', 'Duplicates (merge these):')
    for (const group of duplicates) lines.push(`- ${group.kind}: ${group.files.join(', ')}`)
  }
  if (conflicts.length > 0) {
    lines.push('', 'Conflicts:')
    for (const conflict of conflicts) lines.push(`- ${conflict.hint}`)
  }
  if (dangling.length > 0) {
    lines.push('', 'Dangling index pointers (file missing):')
    for (const item of dangling) lines.push(`- ${item.file}`)
  }
  if (unindexed.length > 0) {
    lines.push('', 'Unindexed files (never injected — add a pointer):')
    for (const file of unindexed) lines.push(`- ${file}`)
  }
  if (oversized.length > 0) {
    lines.push('', 'Oversized bodies:')
    for (const item of oversized) lines.push(`- ${item.file}: ${item.chars}/${item.limit} characters`)
  }

  const issues = record.totals !== undefined && record.totals !== null ? Number(record.totals.issues ?? 0) : 0
  lines.push('')
  if (issues === 0) {
    lines.push('No issues found.')
  } else {
    lines.push(`${issues} issue(s). This report is read-only — edit, merge or delete the files above yourself.`)
    if (merge.length > 0) lines.push(`Merge candidates: ${merge.length}.`)
  }
  return lines.join('\n')
}
