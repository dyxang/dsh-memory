/**
 * Validation of the JSON operation plan that `ctx.llm.stream()` returns for
 * one structured extraction pass (the protocol of `buildExtractionPrompt` in
 * `src/memory-prompt.js`, design decision D1).
 *
 * This module is pure: it never touches the filesystem beyond the read-only
 * path resolution in `src/memory-path.js`, and it never writes. The host
 * applies the surviving operations through `MemoryStore`.
 *
 * The file-name rules mirror the check set of `MemoryStore.resolveWritable`
 * (`src/memory-store.js:143-161`) deliberately — every rule the store enforces
 * is enforced here too, with one reason string per failure so a single bad
 * operation cannot hide why it was dropped — and then add the safe-path
 * resolution (`resolveSafeMemoryFilePath`: real path + sensitive-segment
 * blacklist) that every model-supplied path must pass before any write. The
 * checks are ordered for diagnosability (`..` before separators), which the
 * store's single aggregated error message does not need.
 *
 * @module dsh-memory/plan-validate
 */

import { dirname, join } from 'node:path'

import { MEMORY_INDEX_NAME } from './memory-format.js'
import { resolveSafeMemoryFilePath } from './memory-path.js'

/** The four memory types; `frontmatter.type` must be exactly one of these. */
const MEMORY_TYPES = new Set(['user', 'feedback', 'project', 'reference'])

/** Index-line budget from the extraction prompt ("at most 150 characters"). */
const MAX_HOOK_CHARS = 150

/**
 * @typedef {{op: 'write'|'edit'|'delete', file: string, title?: string, hook?: string,
 *   frontmatter?: {name: string, description: string, type: string}, body?: string}} ExtractionOperation
 */

/**
 * @typedef {{index: number, reason: string}} RejectedOperation
 */

/**
 * Strip one markdown code fence. Models routinely wrap JSON in
 * ```json … ``` even when the prompt forbids it.
 * @param {string} text
 * @returns {string}
 */
function stripCodeFence(text) {
  const trimmed = text.trim()
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  return match === null ? trimmed : match[1].trim()
}

/**
 * Parse the raw model reply into a plan object. Tolerates a markdown fence and
 * a single prose-wrapped JSON object (first `{` to last `}`).
 * @param {unknown} rawText
 * @returns {{plan: Record<string, unknown>} | {error: string}}
 */
export function parseExtractionPlan(rawText) {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    return { error: 'extraction plan is empty' }
  }

  const attempts = [stripCodeFence(rawText)]
  const open = rawText.indexOf('{')
  const close = rawText.lastIndexOf('}')
  if (open >= 0 && close > open) {
    const slice = rawText.slice(open, close + 1)
    if (slice !== attempts[0]) attempts.push(slice)
  }

  for (const attempt of attempts) {
    let parsed
    try {
      parsed = JSON.parse(attempt)
    } catch {
      continue
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { plan: parsed }
    }
    return { error: 'extraction plan must be a JSON object' }
  }

  return { error: 'extraction plan is not valid JSON' }
}

/**
 * Validate a parsed plan against one memory root. Every operation is checked
 * independently: a bad one is reported in `rejected` and skipped, the rest
 * still apply. An empty `operations` array is legal and means "nothing worth
 * saving".
 * @param {unknown} plan
 * @param {{memoryRoot: string}} options
 * @returns {{operations: ExtractionOperation[], rejected: RejectedOperation[]}}
 */
export function validateExtractionPlan(plan, options = {}) {
  const { memoryRoot } = options
  const rejected = []

  if (typeof memoryRoot !== 'string' || memoryRoot.length === 0) {
    return { operations: [], rejected: [{ index: -1, reason: 'invalid-memory-root' }] }
  }
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.operations)) {
    return { operations: [], rejected: [{ index: -1, reason: 'invalid-plan' }] }
  }

  const accepted = []
  plan.operations.forEach((raw, index) => {
    const operation = validateOperation(raw, index, memoryRoot, rejected)
    if (operation !== undefined) accepted.push({ index, operation })
  })

  // Duplicate `file` values keep only the last occurrence, so a model that
  // emits the same memory twice cannot apply a stale version last.
  const lastIndexByFile = new Map()
  for (const entry of accepted) {
    lastIndexByFile.set(entry.operation.file, entry.index)
  }

  const operations = []
  for (const entry of accepted) {
    if (lastIndexByFile.get(entry.operation.file) === entry.index) {
      operations.push(entry.operation)
    } else {
      rejected.push({ index: entry.index, reason: 'duplicate-file' })
    }
  }

  rejected.sort((left, right) => left.index - right.index)
  return { operations, rejected }
}

/**
 * Validate one raw operation. Returns the normalized operation, or `undefined`
 * after pushing a reason into `rejected`.
 * @param {unknown} raw
 * @param {number} index
 * @param {string} memoryRoot
 * @param {RejectedOperation[]} rejected
 * @returns {ExtractionOperation | undefined}
 */
function validateOperation(raw, index, memoryRoot, rejected) {
  const reject = (reason) => {
    rejected.push({ index, reason })
    return undefined
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return reject('invalid-operation')
  }

  const op = raw.op
  if (op !== 'write' && op !== 'edit' && op !== 'delete') {
    return reject('unknown-op')
  }

  const fileReason = validateFile(raw.file, memoryRoot)
  if (fileReason !== undefined) return reject(fileReason)
  const file = raw.file

  // A delete needs nothing but a legal target: the host only removes the file
  // and its index pointer.
  if (op === 'delete') return { op: 'delete', file }

  const title = raw.title
  if (typeof title !== 'string' || title.trim().length === 0) {
    return reject('invalid-title')
  }

  const hook = raw.hook
  if (typeof hook !== 'string' || hook.trim().length === 0) {
    return reject('invalid-hook')
  }
  // Code points, not UTF-16 units, so a CJK hook is measured the way it reads.
  if (Array.from(hook).length > MAX_HOOK_CHARS) {
    return reject('hook-too-long')
  }

  const frontmatter = raw.frontmatter
  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return reject('invalid-frontmatter')
  }
  const { name, description, type } = frontmatter
  if (typeof name !== 'string' || name.trim().length === 0) {
    return reject('invalid-name')
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    return reject('invalid-description')
  }
  if (typeof type !== 'string' || !MEMORY_TYPES.has(type)) {
    return reject('invalid-type')
  }

  const body = raw.body
  if (typeof body !== 'string' || body.trim().length === 0) {
    return reject('invalid-body')
  }

  return { op, file, title, hook, frontmatter: { name, description, type }, body }
}

/**
 * The bare-file-name contract, mirroring `MemoryStore.resolveWritable` and
 * adding the safe-path resolution.
 * @param {unknown} file
 * @param {string} memoryRoot
 * @returns {string | undefined} the rejection reason, or `undefined` when valid.
 */
function validateFile(file, memoryRoot) {
  if (typeof file !== 'string' || file.length === 0) return 'invalid-file'
  if (file !== file.trim()) return 'untrimmed-file'
  if (file.includes('..')) return 'file-has-parent-segment'
  if (/[\\/]/u.test(file)) return 'file-has-separator'
  if (!file.toLowerCase().endsWith('.md')) return 'not-markdown'
  if (file === MEMORY_INDEX_NAME) return 'index-file'
  if (dirname(join(memoryRoot, file)) !== memoryRoot) return 'file-not-in-root'

  try {
    // Contained + real path + sensitive-segment blacklist. With the checks
    // above this is defence in depth (e.g. a symlinked memory root), but it is
    // the same gate the write path uses, so a plan can never contain an
    // operation the store would refuse.
    if (resolveSafeMemoryFilePath({ filePath: file, rootDir: memoryRoot, workingDirectory: memoryRoot }) === undefined) {
      return 'unsafe-path'
    }
  } catch {
    return 'unsafe-path'
  }

  return undefined
}
