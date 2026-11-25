/**
 * Sub-agent persistent memory root resolution.
 *
 * Resolves a sub-agent's persistent memory root, with three deliberate
 * design choices:
 *
 * 1. The `project`/`local` scopes are anchored under the workspace's own
 *    harness home name `.dsh`.
 * 2. An unrecognized scope is a contract violation and throws, rather than
 *    silently falling through to the `local` branch and filing project-scoped
 *    memories under `agent-memory-local`.
 * 3. `agentKey` is sanitized like `agentName` rather than trusted verbatim,
 *    which makes the parameter idempotent for a caller that already
 *    sanitized, and closes the path-separator footgun for one that did not.
 *
 * Pure functions: no I/O, no configuration reads, no process state other than
 * `path`'s own platform behaviour.
 *
 * @module dsh-memory/agent-memory
 */

import { join, resolve } from 'node:path'

/** Directory name of the harness home inside a workspace. */
const DSH_HOME_DIR_NAME = '.dsh'

/** Memory scopes a sub-agent profile may declare. */
const AGENT_MEMORY_SCOPES = ['user', 'project', 'local']

/** Directory under the storage root holding user-scoped agent memories. */
const USER_AGENT_MEMORY_DIR_NAME = 'agent-memory'

/** Directory under the workspace holding project-scoped agent memories. */
const PROJECT_AGENT_MEMORY_DIR_NAME = 'agent-memory'

/** Directory under the workspace holding local-scoped agent memories. */
const LOCAL_AGENT_MEMORY_DIR_NAME = 'agent-memory-local'

/** Key used when an agent name sanitizes away to nothing. */
const UNKNOWN_AGENT_KEY = 'unknown'

/**
 * Whether `value` is one of the three declared memory scopes. Anything else —
 * including `'User'`, `'global'`, `undefined`, `null` and non-strings — is
 * `false`, so callers can gate on this without a second check.
 * @param {unknown} value
 * @returns {value is 'user' | 'project' | 'local'}
 */
export function isAgentMemoryScope(value) {
  return typeof value === 'string' && AGENT_MEMORY_SCOPES.includes(value)
}

/**
 * Reduce an agent name to a single safe path segment.
 *
 * Every character outside `[A-Za-z0-9_-]` becomes `-`, so a name carrying path
 * separators, `..`, drive-letter colons or non-ASCII characters (Chinese,
 * emoji, zero-width marks) cannot escape or rename its directory. The result
 * is always non-empty: only the empty string maps to `unknown`, while a name
 * made purely of disallowed characters maps to a run of dashes (`'###'`
 * becomes `'---'`, not `'unknown'`).
 *
 * The key is deliberately NOT length-capped: an agent name
 * longer than the filesystem's single-component limit surfaces as an
 * `ENAMETOOLONG` from the first write instead of being silently truncated
 * into a name that could collide with another agent.
 *
 * @param {string} agentName
 * @returns {string} a non-empty path segment.
 */
export function sanitizeAgentMemoryKey(agentName) {
  if (typeof agentName !== 'string') {
    throw new TypeError('sanitizeAgentMemoryKey: agentName must be a string')
  }
  const key = agentName.replace(/[^a-zA-Z0-9_-]/gu, '-')
  return key === '' ? UNKNOWN_AGENT_KEY : key
}

/**
 * Resolve one sub-agent's persistent memory root.
 *
 * Layout:
 *
 * - `user`    → `<storageRoot>/agent-memory/<key>` — shared across workspaces.
 * - `project` → `<workspaceRoot>/.dsh/agent-memory/<key>` — lives in the project.
 * - `local`   → `<workspaceRoot>/.dsh/agent-memory-local/<key>` — machine-local.
 *
 * `workspaceRoot` is resolved against the process cwd, so a relative workspace
 * root still yields an absolute path; every segment is appended with `join`,
 * never string concatenation, so separators stay platform-correct (backslash
 * on Windows) and `dirname(join(root, file)) === root` holds. `storageRoot` is
 * used as given because it already comes from `resolveStorageRoot`.
 *
 * The agent key comes from `agentKey` when that is a non-blank string, and
 * from `agentName` otherwise; both are sanitized, so neither can inject path
 * separators.
 *
 * @param {{agentKey?: string, agentName?: string, scope: unknown,
 *          storageRoot?: string, workspaceRoot?: string}} input
 * @returns {string} the memory root for that agent and scope.
 * @throws {TypeError} when no usable agent name/key is supplied, when `scope`
 *   is not one of the three declared scopes, or when the root that `scope`
 *   needs is missing or blank. Failing loudly keeps a profile typo from
 *   quietly filing memories in the wrong tree.
 */
export function resolveAgentMemoryRoot(input) {
  const agentKey = agentMemoryKeyFrom(input)
  const scope = input?.scope
  if (!isAgentMemoryScope(scope)) {
    throw new TypeError(
      `resolveAgentMemoryRoot: scope must be one of ${AGENT_MEMORY_SCOPES.join(', ')}`,
    )
  }

  if (scope === 'user') {
    const storageRoot = input?.storageRoot
    if (typeof storageRoot !== 'string' || storageRoot.trim().length === 0) {
      throw new TypeError(
        'resolveAgentMemoryRoot: storageRoot must be a non-empty string for scope "user"',
      )
    }
    return join(storageRoot, USER_AGENT_MEMORY_DIR_NAME, agentKey)
  }

  const workspaceRoot = input?.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    throw new TypeError(
      `resolveAgentMemoryRoot: workspaceRoot must be a non-empty string for scope "${scope}"`,
    )
  }
  const workspace = resolve(workspaceRoot)
  return scope === 'project'
    ? join(workspace, DSH_HOME_DIR_NAME, PROJECT_AGENT_MEMORY_DIR_NAME, agentKey)
    : join(workspace, DSH_HOME_DIR_NAME, LOCAL_AGENT_MEMORY_DIR_NAME, agentKey)
}

/**
 * Pick the agent key: a non-blank `agentKey` wins over `agentName`, and the
 * winner is sanitized, so a caller-supplied key cannot smuggle path
 * separators. A blank `agentKey` counts as unset, matching how the rest of
 * this bundle treats whitespace-only configuration values.
 * @param {{agentKey?: unknown, agentName?: unknown}} input
 * @returns {string}
 */
function agentMemoryKeyFrom(input) {
  const preferred = typeof input?.agentKey === 'string' && input.agentKey.trim().length > 0
    ? input.agentKey
    : input?.agentName
  if (typeof preferred !== 'string') {
    throw new TypeError('resolveAgentMemoryRoot: agentName (or agentKey) must be a string')
  }
  return sanitizeAgentMemoryKey(preferred)
}
