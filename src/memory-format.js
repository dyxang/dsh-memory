/**
 * Memory file format: frontmatter parsing, origin stamping, and MEMORY.md
 * index lines.
 *
 * A targeted editor updates frontmatter and index lines in place: rather than
 * a generic YAML round-trip, it touches only the keys this system owns and
 * leaves every other byte of the user's document untouched.
 *
 * @module dsh-memory/format
 */

/** Index file name; never a memory itself. */
export const MEMORY_INDEX_NAME = 'MEMORY.md'

/** The frontmatter delimiter regex. */
const FRONTMATTER_RE = /^(\uFEFF?---(?:\r\n|\n))([\s\S]*?)((?:\r\n|\n)---)(?=(?:\r\n|\n)|$)/u

/** Top-level scalar key. */
const TOP_KEY_RE = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/u

/** The metadata keys this system owns. */
const OWNED_METADATA_KEYS = new Set(['node_type', 'originSessionId'])

/**
 * Parse one memory file into its frontmatter fields and body.
 * @param {string} text
 * @returns {{hasFrontmatter: boolean, name?: string, description?: string,
 *   type?: string, nodeType?: string, originSessionId?: string, body: string}}
 */
export function parseMemoryFile(text) {
  const match = FRONTMATTER_RE.exec(text)
  if (match === null) {
    return { hasFrontmatter: false, body: text }
  }
  const block = match[2]
  const fields = { hasFrontmatter: true, body: text.slice(match[0].length) }
  let inMetadata = false
  let metadataIndent = null
  for (const line of block.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue
    const indent = line.length - line.trimStart().length
    if (inMetadata) {
      if (metadataIndent !== null && indent < metadataIndent) {
        inMetadata = false
      } else {
        if (metadataIndent === null) metadataIndent = indent
        const child = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
        if (child !== null) {
          const value = stripQuotes(child[2].trim())
          if (child[1] === 'type') fields.type = value
          else if (child[1] === 'node_type') fields.nodeType = value
          else if (child[1] === 'originSessionId') fields.originSessionId = value
        }
        continue
      }
    }
    const top = TOP_KEY_RE.exec(line)
    if (top === null) continue
    const key = top[1]
    const value = stripQuotes(top[2].trim())
    if (key === 'name') fields.name = value
    else if (key === 'description') fields.description = value
    else if (key === 'metadata') inMetadata = true
  }
  return fields
}

/**
 * Stamp `metadata.node_type: memory` and `metadata.originSessionId` into a
 * memory file. Idempotent: an existing non-empty `originSessionId` is never
 * overwritten, and a missing or malformed frontmatter leaves the text
 * untouched (format stays a prompt-level concern).
 * @param {string} text
 * @param {string} sessionId
 * @returns {string} the stamped text, or the original text when nothing changed.
 */
export function stampMemoryOriginSessionId(text, sessionId) {
  const match = FRONTMATTER_RE.exec(text)
  if (match === null) return text
  if (!isWellFormedFrontmatter(match[2])) return text
  const existing = parseMemoryFile(text)
  if (typeof existing.originSessionId === 'string' && existing.originSessionId.length > 0) {
    return text
  }
  const eol = match[1].includes('\r\n') ? '\r\n' : '\n'
  const block = match[2]
  const lines = block.split(/\r?\n/u)

  const metadataIndex = lines.findIndex((line) => {
    const indent = line.length - line.trimStart().length
    return indent === 0 && /^metadata\s*:/.test(line.trim())
  })

  let nextLines
  if (metadataIndex === -1) {
    nextLines = [...lines, 'metadata:', '  node_type: memory', `  originSessionId: ${sessionId}`]
  } else {
    const childIndent = detectChildIndent(lines, metadataIndex)
    const { start, end } = metadataChildRange(lines, metadataIndex, childIndent)
    const children = lines.slice(start, end)
    const kept = children.filter((line) => {
      const key = childKey(line)
      return key !== 'node_type' && key !== 'originSessionId'
    })
    const replacement = [
      `${' '.repeat(childIndent)}node_type: memory`,
      ...kept,
      `${' '.repeat(childIndent)}originSessionId: ${sessionId}`,
    ]
    nextLines = [...lines.slice(0, start), ...replacement, ...lines.slice(end)]
  }

  const nextBlock = nextLines.join(eol)
  if (nextBlock === block) return text
  return `${match[1]}${nextBlock}${match[3]}${text.slice(match[0].length)}`
}

/**
 * A conservative well-formedness gate that stands in for a full YAML parse:
 * this plugin refuses to stamp a document whose frontmatter it can tell is
 * broken. Rejects tab indentation and unbalanced flow collections
 * (`[`, `]`, `{`, `}`) outside quotes.
 * @param {string} block
 * @returns {boolean}
 */
function isWellFormedFrontmatter(block) {
  for (const line of block.split(/\r?\n/u)) {
    if (/^[ \t]*\t/.test(line)) return false
    let depth = 0
    let quote = null
    for (const char of line) {
      if (quote !== null) {
        if (char === quote) quote = null
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        continue
      }
      if (char === '[' || char === '{') depth += 1
      else if (char === ']' || char === '}') depth -= 1
      if (depth < 0) return false
    }
    if (depth !== 0 || quote !== null) return false
  }
  return true
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripQuotes(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * @param {readonly string[]} lines
 * @param {number} metadataIndex
 * @returns {number}
 */
function detectChildIndent(lines, metadataIndex) {
  for (let index = metadataIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0) continue
    const indent = line.length - line.trimStart().length
    if (indent > 0) return indent
    break
  }
  return 2
}

/**
 * The half-open line range of a `metadata:` block's children.
 * @param {readonly string[]} lines
 * @param {number} metadataIndex
 * @param {number} childIndent
 * @returns {{start: number, end: number}}
 */
function metadataChildRange(lines, metadataIndex, childIndent) {
  let end = metadataIndex + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim().length === 0) break
    const indent = line.length - line.trimStart().length
    if (indent < childIndent) break
    end += 1
  }
  return { start: metadataIndex + 1, end }
}

/**
 * @param {string} line
 * @returns {string | undefined}
 */
function childKey(line) {
  const match = /^\s*([A-Za-z0-9_.-]+)\s*:/.exec(line)
  return match === null ? undefined : match[1]
}
