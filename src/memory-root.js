/**
 * Memory root resolution.
 *
 * Per design decision D4 the DSH workspace id is the preferred identity, and
 * `sha256(normalizedPath)[:16]` is kept only as the fallback for a workspace
 * that has no registry entry.
 *
 * @module dsh-memory/root
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Directory name of the harness home. */
const DSH_HOME_DIR_NAME = '.dsh'

/** Sub-directory of the storage root holding project memories. */
const PROJECTS_DIR_NAME = 'projects'

/** Sub-directory of a project memory directory holding the memory files. */
const MEMORY_DIR_NAME = 'memory'

/** Slug cap. */
const SLUG_MAX_LENGTH = 48

/** Hash length in hex characters (64-bit short hash). */
const HASH_LENGTH = 16

/**
 * Resolve the harness home: an explicit path wins, then `$DSH_HOME`, then
 * `~/.dsh`. A blank or whitespace-only override is treated as unset.
 * @param {string} [explicit]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDshHome(explicit, env = process.env) {
  if (typeof explicit === 'string' && explicit.trim().length > 0) return resolve(explicit)
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv)
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * The storage root that holds every memory directory.
 * @param {{storageRoot?: string}} config
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveStorageRoot(config, env) {
  const configured = config?.storageRoot
  if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured)
  return join(resolveDshHome(undefined, env), 'memories')
}

/**
 * Lowercase slug of a directory name: non `[a-z0-9._-]` runs collapse to `-`,
 * leading/trailing `-` are dropped, and the result is capped.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeProjectSlug(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, SLUG_MAX_LENGTH)
  return slug.length > 0 ? slug : 'project'
}

/**
 * The fallback identity: a short hash of the normalized workspace path.
 * Windows paths are lowercased first so casing differences share one root.
 * @param {string} workspacePath
 * @returns {string}
 */
export function workspacePathHash(workspacePath) {
  const keySource = process.platform === 'win32'
    ? resolve(workspacePath).toLowerCase()
    : resolve(workspacePath)
  return createHash('sha256').update(keySource).digest('hex').slice(0, HASH_LENGTH)
}

/**
 * Resolve one project's memory root.
 * @param {{storageRoot: string, workspacePath: string, workspaceId?: string}} input
 * @returns {string} `<storageRoot>/projects/<slug>-<id>/memory`
 */
export function resolveProjectMemoryRoot(input) {
  const workspacePath = resolve(input.workspacePath)
  const identity = typeof input.workspaceId === 'string' && input.workspaceId.trim().length > 0
    ? input.workspaceId.trim()
    : workspacePathHash(workspacePath)
  const slug = typeof input.workspaceId === 'string' && input.workspaceId.trim().length > 0
    ? 'project'
    : sanitizeProjectSlug(baseName(workspacePath))
  return join(input.storageRoot, PROJECTS_DIR_NAME, `${slug}-${identity}`, MEMORY_DIR_NAME)
}

/**
 * @param {string} path
 * @returns {string}
 */
function baseName(path) {
  const normalized = path.replace(/[\\/]+$/u, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index < 0 ? normalized : normalized.slice(index + 1)
}
