/**
 * Memory path containment and safety.
 *
 * Three deliberate safety choices:
 *
 * 1. The relative-path anchor is resolved against `workingDirectory` with
 *    `path.resolve` (which collapses `.`/`..` lexically and passes absolute
 *    paths through unchanged).
 * 2. The write path performs NO symlink check on its own; `resolveRealContained…`
 *    adds one: the deepest existing ancestor is `realpath`ed and the real
 *    location must still sit inside the memory root.
 * 3. The sensitive-segment blacklist names `.dsh`: the harness home directory
 *    is the one a memory write must never traverse in this deployment.
 *
 * @module dsh-memory/path
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * Path segments a memory write may never traverse. Covers git internals
 * (`head`/`config`/`objects`/`refs`), hook directories, dependency trees,
 * editor state, and the host's own plugin/skill/command/agent directories
 * (so a memory write cannot inject an agent definition or a skill).
 */
export const SENSITIVE_MEMORY_PATH_SEGMENTS = new Set([
  '.git',
  'hooks',
  '.husky',
  '.githooks',
  'node_modules',
  '.vscode',
  '.idea',
  'head',
  'config',
  'objects',
  'refs',
  '.dsh',
  'skills',
  'commands',
  'agents',
  '.cargo',
  '.devcontainer',
  '.yarn',
  '.mvn',
])

/**
 * Resolve a candidate write target to an absolute path.
 * @param {string} filePath model- or caller-supplied path.
 * @param {string} [workingDirectory] anchor for relative paths.
 * @returns {string | undefined} absolute normalized path, or undefined for empty input.
 */
function resolveCandidatePath(filePath, workingDirectory) {
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined
  const base = typeof workingDirectory === 'string' && workingDirectory.length > 0
    ? workingDirectory
    : process.cwd()
  return resolve(base, filePath)
}

/**
 * Contained test: the relative path must be non-empty, must not be `..`, must
 * not escape upward, and must not be absolute (a cross-drive `relative()` on
 * Windows returns an absolute path, which this rejects).
 * @param {string} relativePath
 * @returns {boolean}
 */
function isContainedRelativePath(relativePath) {
  return relativePath.length > 0
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !relativePath.startsWith('../')
    && !relativePath.startsWith('..\\')
    && !isAbsolute(relativePath)
}

/**
 * Contained-only resolution: rejects `..`, absolute escapes and cross-drive
 * paths, but does NOT apply the sensitive-segment blacklist.
 * @param {{filePath: string, rootDir: string, workingDirectory?: string}} input
 * @returns {string | undefined} absolute path inside `rootDir`.
 */
export function resolveContainedMemoryFilePath(input) {
  const resolvedPath = resolveCandidatePath(input.filePath, input.workingDirectory)
  if (resolvedPath === undefined) return undefined
  const relativePath = relative(input.rootDir, resolvedPath)
  return isContainedRelativePath(relativePath) ? resolvedPath : undefined
}

/**
 * Real-path variant: additionally resolves the deepest existing ancestor with
 * `realpath` and requires the REAL location to stay inside the real memory
 * root. This closes the symlink escape a write path without this check leaves
 * open.
 *
 * The comparison is done between two fully materialized paths — the target's
 * real path plus its not-yet-existing tail, and the root's real path plus its
 * own tail — so a root or target that does not exist yet is still compared
 * correctly instead of collapsing to the nearest existing ancestor.
 *
 * @param {{filePath: string, rootDir: string, workingDirectory?: string}} input
 * @returns {string | undefined} absolute path inside `rootDir`, symlink-safe.
 */
export function resolveRealContainedMemoryFilePath(input) {
  const resolvedPath = resolveContainedMemoryFilePath(input)
  if (resolvedPath === undefined) return undefined
  const realRoot = realpathWithTail(resolve(input.rootDir))
  const realTarget = realpathWithTail(resolvedPath)
  if (realRoot === undefined || realTarget === undefined) return undefined
  return isContainedRelativePath(relative(realRoot, realTarget)) ? resolvedPath : undefined
}

/**
 * Strict resolution: contained + sensitive-segment blacklist + Unicode/Windows
 * normalization of every segment.
 * @param {{filePath: string, rootDir: string, workingDirectory?: string}} input
 * @returns {string | undefined} absolute safe path, or undefined when rejected.
 */
export function resolveSafeMemoryFilePath(input) {
  const resolvedPath = resolveRealContainedMemoryFilePath(input)
  if (resolvedPath === undefined) return undefined
  const relativePath = memoryFileRelativePath(input.rootDir, resolvedPath)
  return relativePath !== undefined && !containsSensitiveMemoryPathSegment(relativePath)
    ? resolvedPath
    : undefined
}

/**
 * Root-relative path with `/` separators, or undefined when not contained.
 * @param {string} rootDir
 * @param {string} filePath
 * @returns {string | undefined}
 */
export function memoryFileRelativePath(rootDir, filePath) {
  const relativePath = relative(rootDir, filePath)
  return isContainedRelativePath(relativePath) ? relativePath.split(/[\\/]+/u).join('/') : undefined
}

/**
 * Whether any segment of a root-relative path is blacklisted.
 * @param {string} relativePath
 * @returns {boolean}
 */
export function containsSensitiveMemoryPathSegment(relativePath) {
  return relativePath
    .split(/[\\/]+/u)
    .some((segment) => SENSITIVE_MEMORY_PATH_SEGMENTS.has(normalizeSensitiveSegment(segment)))
}

/**
 * Invisible characters stripped before blacklist matching. Covers `\u200b`
 * (zero-width space), `\u2060` (word joiner), `\u00ad` (soft hyphen) and
 * `\u180e` (Mongolian vowel separator) — all four are usable to smuggle
 * `.git` past a segment blacklist.
 */
const INVISIBLE_CHARACTERS_RE = /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu

/**
 * Normalize one segment before blacklist matching: lowercase, strip zero-width
 * and bidi control characters, drop any NTFS alternate-data-stream suffix
 * (`.git:hidden`), and trim trailing dots and spaces (Windows silently strips
 * them, turning `.git.` into `.git`).
 * @param {string} segment
 * @returns {string}
 */
function normalizeSensitiveSegment(segment) {
  const withoutControls = segment.toLowerCase().replace(INVISIBLE_CHARACTERS_RE, '')
  return (withoutControls.split(':', 1)[0] ?? '').replace(/[. ]+$/u, '')
}

/**
 * Materialize the real path of `target`: `realpath` the deepest existing
 * ancestor, then re-append the segments that do not exist yet.
 * @param {string} target
 * @returns {string | undefined} the real path, or undefined when nothing resolves.
 */
function realpathWithTail(target) {
  const missing = []
  let current = target
  for (;;) {
    const real = realpathOrUndefined(current)
    if (real !== undefined) {
      return missing.length === 0 ? real : join(real, ...missing.reverse())
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    missing.push(basename(current))
    current = parent
  }
}

/**
 * @param {string} path
 * @returns {string | undefined}
 */
function realpathOrUndefined(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}
