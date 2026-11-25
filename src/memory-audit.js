/**
 * Read-only maintenance audit over one project memory root.
 *
 * The memory tree grows by accretion: the extraction pass can leave two files
 * for one topic, a file can be deleted outside the tool leaving a dangling
 * `MEMORY.md` pointer, a pointer can be missing so a file is silently never
 * injected, the always-on layer can grow past its attention budget, or a
 * `feedback`/`user` type can end up split across two files. None of that is
 * fatal, but it is exactly what "记忆多了之后" looks like in practice, and it
 * needs a periodic, human-inspectable cleanup list rather than silent drift.
 *
 * This module is the analysis half only. It never edits, merges, or deletes —
 * the caller (the `memory` tool's `audit` action, or a person reading the
 * report) decides what to act on. Pure: no I/O, no config reads. The host
 * gathers the sources (`manifest`, `MEMORY.md` pointers, per-file names/body
 * sizes, the always-on usage) and passes them in.
 *
 * Scope is deliberately the single project root this plugin owns — the audit
 * does not look across projects, matching the plugin's project-memory
 * positioning.
 *
 * @module dsh-memory/audit
 */

import { isAlwaysOnType, ALWAYS_ON_FILE } from './memory-layers.js'
import { memoryWidthPreset } from './memory-width.js'

/** The index separator, matching `renderOnDemandBlock`. */
const EM_DASH = '\u2014'

/**
 * @typedef {object} AuditEntry
 * @property {string} filename bare or nested-relative name, as in the manifest.
 * @property {string} [type] memory type, when the frontmatter had one.
 * @property {string} [name] frontmatter `name:` slug, when present.
 * @property {string} [description] frontmatter `description:`.
 * @property {number} [bodyChars] body length in code points, when known.
 */

/**
 * Audit one memory root.
 *
 * @param {{
 *   rootDir?: string,
 *   entries?: readonly AuditEntry[],
 *   pointers?: ReadonlyMap<string, {title?: string, hook?: string}>,
 *   indexLimits?: {lineLimit?: number, charLimit?: number},
 *   alwaysOn?: {files?: number, lines?: number, chars?: number, lineLimit?: number, charLimit?: number, overBudget?: boolean},
 *   bodyCharLimit?: number | null,
 *   width?: string,
 * }} [input]
 * @returns {object} a structured report (`ok`/`action` plus the findings).
 */
export function auditMemory(input = {}) {
  const rootDir = typeof input.rootDir === 'string' ? input.rootDir : ''
  const entries = Array.isArray(input.entries) ? input.entries : []
  const pointers = input.pointers instanceof Map ? input.pointers : new Map()
  const preset = memoryWidthPreset(input.width)
  const indexLimits = input.indexLimits ?? {}
  const lineLimit = positiveOr(indexLimits.lineLimit, preset.indexLineLimit)
  const charLimit = positiveOr(indexLimits.charLimit, preset.indexCharLimit)

  const typeByFile = new Map(entries.map((entry) => [entry.filename, entry.type]))

  // --- On-demand index budget ------------------------------------------------
  // Mirrors `renderOnDemandBlock`: only non-always-on pointers cost the index
  // budget; `user`/`feedback` bodies are counted against the always-on layer
  // instead. A pointer whose file the manifest does not know stays — it is a
  // dangling pointer, reported separately, not silently dropped.
  const onDemandLines = []
  for (const [file, pointer] of pointers) {
    if (isAlwaysOnType(typeByFile.get(file))) continue
    const title = nonEmpty(pointer?.title) ?? file
    const hook = typeof pointer?.hook === 'string' ? pointer.hook : ''
    onDemandLines.push(hook.length === 0 ? `- [${title}](${file})` : `- [${title}](${file}) ${EM_DASH} ${hook}`)
  }
  const pointerLines = onDemandLines.length
  const pointerChars = codePoints(onDemandLines.join('\n'))
  const indexOverBudget = pointerLines > lineLimit || pointerChars > charLimit

  // --- Always-on layer -------------------------------------------------------
  const alwaysOn = normalizeAlwaysOn(input.alwaysOn)

  // --- Dangling pointers (index line with no file) ---------------------------
  const fileSet = new Set(entries.map((entry) => entry.filename))
  const danglingPointers = []
  for (const [file, pointer] of pointers) {
    if (fileSet.has(file)) continue
    danglingPointers.push({ file, title: nonEmpty(pointer?.title) ?? file })
  }

  // --- Unindexed files (file with no index pointer → never injected) ---------
  const unindexedFiles = entries
    .map((entry) => entry.filename)
    .filter((file) => !pointers.has(file))

  // --- Duplicates (merge candidates) -----------------------------------------
  const duplicates = []
  collectDuplicateGroups(duplicates, entries, (entry) => normalizeKey(entry.name), 'name')
  collectDuplicateGroups(duplicates, entries, (entry) => normalizeKey(entry.description), 'description')

  // --- Cross-file conflicts (structural) -------------------------------------
  // The design allows one always-on file per type; a second one means the
  // layer is split and should be merged.
  const conflicts = []
  const alwaysOnByType = new Map()
  for (const entry of entries) {
    if (!isAlwaysOnType(entry.type)) continue
    if (!alwaysOnByType.has(entry.type)) alwaysOnByType.set(entry.type, [])
    alwaysOnByType.get(entry.type).push(entry.filename)
  }
  for (const [type, files] of alwaysOnByType) {
    if (files.length <= 1) continue
    const target = type === 'feedback' ? ` — \`feedback\` rules belong in \`${ALWAYS_ON_FILE}\`` : ''
    conflicts.push({
      kind: 'multiple-always-on-files',
      type,
      files: [...files].sort(),
      hint: `Merge the ${files.length} \`${type}\` files into one${target}.`,
    })
  }

  // --- Oversized bodies (only when the width enforces a body cap) ------------
  const bodyCharLimit = positiveNumberOrNull(input.bodyCharLimit)
  const oversizedBodies = []
  if (bodyCharLimit !== null) {
    for (const entry of entries) {
      if (typeof entry.bodyChars === 'number' && entry.bodyChars > bodyCharLimit) {
        oversizedBodies.push({ file: entry.filename, chars: entry.bodyChars, limit: bodyCharLimit })
      }
    }
  }

  // --- The "待合并清单": everything that suggests consolidation --------------
  const mergeCandidates = []
  for (const group of duplicates) {
    mergeCandidates.push({ reason: `duplicate ${group.kind}`, files: group.files })
  }
  for (const conflict of conflicts) {
    mergeCandidates.push({ reason: conflict.hint, files: conflict.files })
  }

  const issues = duplicates.length
    + danglingPointers.length
    + unindexedFiles.length
    + conflicts.length
    + oversizedBodies.length
    + (indexOverBudget ? 1 : 0)
    + (alwaysOn?.overBudget === true ? 1 : 0)

  return {
    ok: true,
    action: 'audit',
    root: rootDir,
    index: { pointerLines, pointerChars, lineLimit, charLimit, overBudget: indexOverBudget },
    ...(alwaysOn === undefined ? {} : { alwaysOn }),
    duplicates,
    danglingPointers,
    unindexedFiles,
    conflicts,
    oversizedBodies,
    mergeCandidates,
    totals: { issues },
  }
}

/* ------------------------------------------------------------------ helpers -- */

/**
 * Group entries by a key and record every group with more than one file.
 * An empty key is skipped (no `name:`/`description:` is not a duplicate).
 * @param {Array<{kind: string, key: string, files: string[]}>} out
 * @param {readonly AuditEntry[]} entries
 * @param {(entry: AuditEntry) => string} keyOf
 * @param {'name' | 'description'} kind
 */
function collectDuplicateGroups(out, entries, keyOf, kind) {
  const groups = new Map()
  for (const entry of entries) {
    const key = keyOf(entry)
    if (key.length === 0) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry.filename)
  }
  for (const [key, files] of groups) {
    if (files.length <= 1) continue
    out.push({ kind, key, files: [...files].sort() })
  }
}

/**
 * @param {unknown} value
 * @returns {object | undefined}
 */
function normalizeAlwaysOn(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value
  if (typeof record.lineLimit !== 'number' && typeof record.charLimit !== 'number') return undefined
  return {
    files: Number(record.files ?? 0),
    lines: Number(record.lines ?? 0),
    chars: Number(record.chars ?? 0),
    lineLimit: Number(record.lineLimit ?? 0),
    charLimit: Number(record.charLimit ?? 0),
    overBudget: record.overBudget === true,
  }
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
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
 * @param {unknown} value
 * @returns {number | null}
 */
function positiveNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Code points, so a CJK hook is budgeted the way it reads — the same rule the
 * index trimmer and the always-on layer use.
 * @param {string} text
 * @returns {number}
 */
function codePoints(text) {
  return Array.from(text).length
}
