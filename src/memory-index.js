/**
 * MEMORY.md index: read, trim, comment stripping, and line maintenance.
 *
 * The comment stripper is a line-based approximation of a markdown-lexer
 * version: it strips only comments that start at column 0 and are outside a
 * fenced code block, and keeps comments nested inside lists, blockquotes and
 * code fences.
 *
 * @module dsh-memory/index
 */

import { MEMORY_INDEX_NAME } from './memory-format.js'

/** The index line cap. */
export const MEMORY_INDEX_LINE_LIMIT = 200

/** The index character cap. */
export const MEMORY_INDEX_CHARACTER_LIMIT = 25_000

/** Leading frontmatter, tolerated and stripped. */
const LEADING_FRONTMATTER_RE = /^---\s*\n[\s\S]*?---\s*\n?/u

/** A complete top-level HTML comment line. */
const TOP_LEVEL_COMMENT_RE = /^<!--[\s\S]*?-->/u

/** The notice appended when the index is trimmed. */
const TRIM_NOTICE = '> WARNING: MEMORY.md is over its size budget. Keep the index lean — one line per memory, no content — and move detail into the memory files themselves.'

/**
 * Strip a leading frontmatter block, if any.
 * @param {string} text
 * @returns {string}
 */
export function stripIndexFrontmatter(text) {
  return text.replace(LEADING_FRONTMATTER_RE, '')
}

/**
 * Strip top-level HTML comments, preserving those inside code fences.
 * @param {string} text
 * @returns {string}
 */
export function stripTopLevelMarkdownComments(text) {
  const lines = text.split('\n')
  const out = []
  let fence = null
  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      out.push(line)
      if (fenceMatch !== null && fenceMatch[1].startsWith(fence[0]) && fenceMatch[1].length >= fence.length) {
        fence = null
      }
      continue
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1]
      out.push(line)
      continue
    }
    if (line.length > 0 && !/^\s/.test(line)) {
      const match = TOP_LEVEL_COMMENT_RE.exec(line)
      if (match !== null) {
        const remainder = line.slice(match[0].length).trim()
        if (remainder.length === 0) continue
        out.push(remainder)
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Trim an index to its line and character budgets, appending a notice when
 * either cap was hit.
 * @param {string} text
 * @param {{lineLimit?: number, charLimit?: number}} [limits]
 * @returns {{text: string, lines: number, chars: number, lineTruncated: boolean, charTruncated: boolean}}
 */
export function trimMemoryIndexContent(text, limits = {}) {
  const lineLimit = limits.lineLimit ?? MEMORY_INDEX_LINE_LIMIT
  const charLimit = limits.charLimit ?? MEMORY_INDEX_CHARACTER_LIMIT
  const normalized = stripIndexFrontmatter(text).trim()
  const allLines = normalized.length === 0 ? [] : normalized.split('\n')

  let lineTruncated = false
  let lines = allLines
  if (allLines.length > lineLimit) {
    lines = allLines.slice(0, lineLimit)
    lineTruncated = true
  }

  let joined = lines.join('\n')
  let charTruncated = false
  if (joined.length > charLimit) {
    const cut = joined.lastIndexOf('\n', charLimit)
    joined = cut <= 0 ? joined.slice(0, charLimit) : joined.slice(0, cut)
    charTruncated = true
  }

  if (lineTruncated || charTruncated) {
    const metrics = `lines=${allLines.length}/${lineLimit}, characters=${allLines.join('\n').length}/${charLimit}`
    joined = `${joined}\n${TRIM_NOTICE.replace('MEMORY.md is over its size budget', `MEMORY.md is over its size budget (${metrics})`)}`
  }

  return { text: joined, lines: allLines.length, chars: allLines.join('\n').length, lineTruncated, charTruncated }
}

/**
 * The index text as it should reach the model: comments stripped, then trimmed.
 * @param {string} raw
 * @param {{lineLimit?: number, charLimit?: number}} [limits]
 * @returns {string}
 */
export function formatMemoryIndexContent(raw, limits) {
  return trimMemoryIndexContent(stripTopLevelMarkdownComments(raw ?? ''), limits).text
}

/**
 * Parse the index into `filename -> {title, hook}`, the shape the layered
 * prompt view consumes (`src/memory-layers.js`).
 *
 * Only pointer lines are read. A heading, a stray paragraph or a maintenance
 * comment in `MEMORY.md` therefore never reaches the prompt as a memory, and a
 * line whose file was deleted outside the tool still resolves — the caller
 * decides what to do with a dangling pointer.
 *
 * @param {string} indexText
 * @returns {Map<string, {title: string, hook: string}>}
 */
export function parseMemoryIndexPointers(indexText) {
  const out = new Map()
  for (const line of String(indexText ?? '').split('\n')) {
    const match = /^\s*-\s*\[([^\]]*)\]\(([^)]+)\)\s*(?:\u2014|-)?\s*(.*)$/u.exec(line)
    if (match === null) continue
    out.set(match[2].trim(), { title: match[1].trim(), hook: match[3].trim() })
  }
  return out
}

/**
 * Replace the pointer for `file`, or append a new one.
 *
 * The decision is "did any line point at this file", NOT "did the text change":
 * a re-save that produces a byte-identical pointer must still count as a
 * replacement, otherwise every idempotent write appends a duplicate line.
 *
 * @param {string} indexText
 * @param {{file: string, title: string, hook: string}} entry
 * @returns {string} the new index text.
 */
export function upsertMemoryIndexLine(indexText, entry) {
  const lines = indexText.length === 0 ? [] : indexText.split('\n')
  const nextLine = `- [${entry.title}](${entry.file}) \u2014 ${entry.hook}`
  let matched = false
  const replaced = lines.map((line) => {
    if (!pointsAt(line, entry.file)) return line
    matched = true
    return nextLine
  })
  if (!matched) replaced.push(nextLine)
  return replaced.join('\n')
}

/**
 * Drop the pointer for `file`.
 * @param {string} indexText
 * @param {string} file
 * @returns {string} the new index text.
 */
export function removeMemoryIndexLine(indexText, file) {
  return indexText
    .split('\n')
    .filter((line) => !pointsAt(line, file))
    .join('\n')
}

/**
 * @param {string} line
 * @param {string} file
 * @returns {boolean}
 */
function pointsAt(line, file) {
  const match = /^\s*-\s*\[[^\]]*\]\(([^)]+)\)/.exec(line)
  return match !== null && match[1] === file
}
