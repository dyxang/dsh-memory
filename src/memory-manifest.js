/**
 * Memory directory scan: the manifest handed to the extraction prompt.
 *
 * Two documented behaviours: dot-directories are not traversed (memory files
 * never live in one, and it keeps the scan out of `.git` and the plugin's own
 * state dir), and a `readdir` failure on a subdirectory is skipped rather than
 * aborting the whole scan.
 *
 * @module dsh-memory/manifest
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { parseMemoryFile, MEMORY_INDEX_NAME } from './memory-format.js'

/** The manifest entry cap. */
export const MANIFEST_FILE_LIMIT = 200

/** The frontmatter preview window in lines. */
export const MANIFEST_PREVIEW_LINE_LIMIT = 30

/** Directory name of this plugin's own state; never scanned. */
const STATE_DIR_NAME = '.dsh-memory-state'

/**
 * @param {string} filePath
 * @returns {boolean} whether the path is a memory candidate.
 */
export function isMemoryCandidate(filePath) {
  const name = baseName(filePath)
  return name.toLowerCase().endsWith('.md') && name !== MEMORY_INDEX_NAME
}

/**
 * Scan a memory root and return its entries, newest first.
 * @param {string} rootDir
 * @param {typeof import('node:fs/promises')} [fs]
 * @returns {Promise<Array<{filePath: string, filename: string, mtimeMs: number, description?: string, type?: string}>>}
 */
export async function scanMemoryManifest(rootDir, fs = { readdir, stat, readFile }) {
  const paths = []
  await collectMemoryPaths(rootDir, paths, fs)
  const settled = await Promise.allSettled(paths.map((filePath) => readManifestEntry(filePath, rootDir, fs)))
  const entries = settled
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
  entries.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return entries.slice(0, MANIFEST_FILE_LIMIT)
}

/**
 * Render the manifest block injected into the extraction prompt.
 * @param {readonly Array<{filename: string, description?: string, type?: string, mtimeMs: number}>} entries
 * @returns {string}
 */
export function formatMemoryManifest(entries) {
  return entries
    .map((entry) => {
      const parts = [`[${entry.type ?? 'memory'}]`, entry.filename]
      if (typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs)) {
        parts.push(`(${new Date(entry.mtimeMs).toISOString()})`)
      }
      if (typeof entry.description === 'string' && entry.description.length > 0) {
        parts.push(`: ${entry.description}`)
      }
      return `- ${parts.join(' ')}`
    })
    .join('\n')
}

/**
 * @param {string} dir
 * @param {string[]} out
 * @param {typeof import('node:fs/promises')} fs
 */
async function collectMemoryPaths(dir, out, fs) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === STATE_DIR_NAME) continue
      await collectMemoryPaths(full, out, fs)
      continue
    }
    if (entry.isSymbolicLink()) {
      const target = await statQuiet(full, fs)
      if (target !== undefined && target.isFile() && isMemoryCandidate(full)) out.push(full)
      continue
    }
    if (entry.isFile() && isMemoryCandidate(full)) out.push(full)
  }
}

/**
 * @param {string} filePath
 * @param {string} rootDir
 * @param {typeof import('node:fs/promises')} fs
 */
async function readManifestEntry(filePath, rootDir, fs) {
  const [info, preview] = await Promise.all([fs.stat(filePath), readPreviewLines(filePath, fs)])
  const parsed = parseMemoryFile(preview)
  return {
    filePath,
    filename: relative(rootDir, filePath).split(/[\\/]+/u).join('/'),
    mtimeMs: info.mtimeMs,
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    ...(parsed.type === undefined ? {} : { type: parsed.type }),
  }
}

/**
 * @param {string} filePath
 * @param {typeof import('node:fs/promises')} fs
 * @returns {Promise<string>}
 */
async function readPreviewLines(filePath, fs) {
  const content = await fs.readFile(filePath, 'utf8')
  const lines = content.split(/\r?\n/u)
  return lines.slice(0, MANIFEST_PREVIEW_LINE_LIMIT).join('\n')
}

/**
 * @param {string} path
 * @param {typeof import('node:fs/promises')} fs
 * @returns {Promise<import('node:fs').Stats | undefined>}
 */
async function statQuiet(path, fs) {
  try {
    return await fs.stat(path)
  } catch {
    return undefined
  }
}

/**
 * @param {string} path
 * @returns {string}
 */
function baseName(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index < 0 ? path : path.slice(index + 1)
}
