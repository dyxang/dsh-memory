/**
 * Memory write permission and index maintenance.
 *
 * Memory-file write permission, with the decision model mapped onto DSH's
 * `tools/pre-execute` waterfall:
 *
 *  - A memory Markdown write is rewritten to `allow`; DSH returns
 *    `{ kind: 'allow' }` from the listener.
 *  - Every pre-existing deny / alwaysAsk / project-ask / hook-ask is
 *    preserved. DSH gets the same guarantee structurally: a listener that has
 *    no opinion returns `next()`, which delegates to the remaining listeners
 *    and the base policy. This plugin therefore NEVER narrows an existing
 *    decision — it can only widen a default-allow into an explicit allow.
 *
 * Two additions:
 *  - a `tools.guard` denies agent writes to `MEMORY.md` itself, because the
 *    plugin owns the index (design decision D2);
 *  - `tools/post-execute` stamps the origin session id and upserts the index
 *    pointer derived from the file's own frontmatter, so the agent never has
 *    to perform the second half of the save (updating the index) by hand.
 *
 * Two roots per execution (D-P2-4): the main conversation widens its PROJECT
 * memory root, and a sub-agent whose identity carries a scope in
 * `agentMemoryScopes` additionally widens its own agent-memory root. All three
 * hooks — pre-execute, guard, post-execute — resolve the SAME root set through
 * {@link memoryRootsFor}, so a write that is widened is also guarded and
 * index-maintained against the root it actually hit.
 *
 * The sub-agent identity is read synchronously from the session header's
 * `agentPreset` first and then from the Agent Teams membership name, which is
 * T12's adopted order extended by one synchronous step (preset first, Team name
 * second, catalog label never: the label is the first delegation's free-text
 * description, so keying a root on it would split one sub-agent's memory across
 * directories every time the delegation is re-phrased). The label itself is NOT
 * consulted here: it lives behind `ctx.subagents.listChildren`, an asynchronous
 * catalog read, while both the pre-execute waterfall and the guard answer
 * synchronously. A configuration keyed only on the label therefore gets no
 * widened write from this listener — it falls back to `next()`, which never
 * narrows anything — and that gap is recorded as a known limitation rather
 * than papered over with an await inside a decision hook.
 *
 * The Team name is available because `agentTeams.tryMembership(agent)` is
 * synchronous (`dsh-experimental-agent-team/lib/types/index.d.ts:100-105`). It
 * is probed through {@link teamNameFor}, which skips a profile that mounts no
 * Team service, skips a non-`teammate` membership, and swallows a throwing
 * probe — a decision hook must never throw. A non-Team sub-agent therefore
 * resolves exactly as it did before Teams existed.
 *
 * @module dsh-memory/host/permission
 */

import { basename, join } from 'node:path'
import { readFile } from 'node:fs/promises'

import { MEMORY_INDEX_NAME, parseMemoryFile, stampMemoryOriginSessionId } from '../src/memory-format.js'
import { atomicWriteFile, withMemoryRootLock } from '../src/memory-fs.js'
import { resolveContainedMemoryFilePath, resolveSafeMemoryFilePath } from '../src/memory-path.js'
import { upsertMemoryIndexLine } from '../src/memory-index.js'
import { resolveAgentMemoryRoot } from '../src/agent-memory.js'
import { isSubagentAgent, pickScope, teamNameFor } from './agent-memory.js'

/**
 * One memory root a write may target for an execution.
 *
 * The project root is the {@link AgentMemoryContext} itself (it carries
 * `invalidateIndex`); the sub-agent root is a plain descriptor, because the
 * prompt-side context built by `host/agent-memory.js` is owned by that module
 * and is not reachable from here — its index cache has a 5s TTL and refreshes
 * itself, so no invalidation is needed on this side.
 *
 * @typedef {{rootDir: string, cwd: string, sessionId: string,
 *   invalidateIndex?: () => void}} MemoryRoot
 */

/**
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec
 * @returns {string | undefined} the raw `file_path` argument of a write/edit call.
 */
export function memoryWriteTarget(exec) {
  if (exec.name !== 'write' && exec.name !== 'edit') return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const filePath = args.file_path ?? args.filePath ?? args.path
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : undefined
}

/**
 * Install the memory write policy for the lifetime of `ctx`.
 * @param {{ctx: import('@deepseek-ai/cordis').Context, registry: import('./context.js').MemoryContextRegistry, config: Record<string, unknown>, logger?: {warn: (message: string) => void}}} options
 */
export function installMemoryWritePermission({ ctx, registry, config, logger }) {
  const allowWrites = config.allowMemoryWrites !== false

  if (allowWrites) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const target = memoryWriteTarget(exec)
      if (target === undefined) return next()
      // The decision is widened only for a Markdown write inside a SAFE
      // memory path; everything else keeps whatever the base policy decided.
      if (!target.toLowerCase().endsWith('.md')) return next()
      for (const root of memoryRootsFor({ ctx, registry, exec, config })) {
        const safe = resolveSafeMemoryFilePath({
          filePath: target,
          rootDir: root.rootDir,
          workingDirectory: root.cwd,
        })
        if (safe !== undefined) return { kind: 'allow' }
      }
      return next()
    })
  }

  ctx.tools.guard((exec) => {
    const target = memoryWriteTarget(exec)
    if (target === undefined) return undefined
    // Both roots are guarded: the plugin owns every `MEMORY.md` it maintains,
    // and a sub-agent root has an index of its own.
    for (const root of memoryRootsFor({ ctx, registry, exec, config })) {
      const contained = resolveContainedMemoryFilePath({
        filePath: target,
        rootDir: root.rootDir,
        workingDirectory: root.cwd,
      })
      if (contained === undefined) continue
      if (basename(contained) === MEMORY_INDEX_NAME) {
        return `${MEMORY_INDEX_NAME} is the memory index and is maintained by the memory plugin; never write to it directly.`
      }
    }
    return undefined
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    // Awaited, not fire-and-forget: the index must be consistent before the
    // turn proceeds, otherwise the next injected index is one write behind.
    // `tools/post-execute` requires an async listener to observe `exec.signal`
    // (`docs/subsystems/tools.md`), so maintenance re-checks it at every await
    // and abandons the rest once the caller cancels.
    await maintainIndexAfterWrite({ ctx, exec, registry, config, logger })
    return decision
  })
}

/**
 * Every memory root this execution may write to: the agent's project memory
 * root first, then — for a sub-agent whose identity resolves a scope — its own
 * agent-memory root. Pure in-memory work (no I/O, no await), so the synchronous
 * guard and the pre-execute waterfall can both call it.
 *
 * @param {{get?: (name: string) => unknown}} ctx
 * @param {import('./context.js').MemoryContextRegistry} registry
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec
 * @param {Record<string, unknown>} config
 * @returns {MemoryRoot[]} zero, one or two roots; empty means "no opinion".
 */
function memoryRootsFor({ ctx, registry, exec, config }) {
  /** @type {MemoryRoot[]} */
  const roots = []
  const memory = memoryFor(registry, exec)
  if (memory !== undefined) roots.push(memory)

  const agentRoot = subagentMemoryRoot({ ctx, registry, exec, config })
  // The two roots can only coincide when a sub-agent's project root IS its
  // agent root, which no scope produces; the guard keeps the set small anyway.
  if (agentRoot !== undefined && !roots.some((root) => root.rootDir === agentRoot.rootDir)) {
    roots.push(agentRoot)
  }
  return roots
}

/**
 * Resolve one sub-agent's memory root from its session header and its Team
 * membership, or `undefined` when this execution has none: not a sub-agent, no
 * usable synchronous identity, no scope configured for that identity, or a root
 * that cannot be resolved.
 *
 * Identity → scope → root reuses `src/agent-memory.js` exactly as
 * `host/agent-memory.js` does, and in the same order: the header's
 * `agentPreset`, then the Team name. Only those two are reachable from a
 * permission hook — the catalog label is asynchronous — and the loop continues
 * past an identity that has no configured scope, so the root resolved here is
 * the root the prompt layer told this sub-agent about. (Stopping at the first
 * identity name at all would let a preset with no scope shadow the teammate
 * name, and the prompt and the write would disagree.)
 *
 * @param {{get?: (name: string) => unknown}} ctx
 * @param {import('./context.js').MemoryContextRegistry} registry
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec
 * @param {Record<string, unknown>} config
 * @returns {MemoryRoot | undefined}
 */
function subagentMemoryRoot({ ctx, registry, exec, config }) {
  const agent = exec.agent
  if (!isSubagentAgent(agent)) return undefined

  const header = agent?.session?.header
  const sessionId = nonBlankString(agent?.session?.id)
  if (sessionId === undefined) return undefined

  // The same cwd fallback the prompt layer uses (`host/agent-memory.js`), so
  // the root the sub-agent is TOLD about is the root it may write to.
  const cwd = nonBlankString(header?.cwd) ?? process.cwd()

  for (const agentKey of [nonBlankString(header?.agentPreset), teamNameFor(ctx, agent)]) {
    if (agentKey === undefined) continue
    const scope = pickScope(config?.agentMemoryScopes, agentKey)
    if (scope === undefined) continue
    try {
      const rootDir = resolveAgentMemoryRoot({
        agentKey,
        scope,
        storageRoot: registry.storageRoot,
        workspaceRoot: cwd,
      })
      return { rootDir, cwd, sessionId }
    } catch {
      // An unusable root (blank storage root, unusable identity) is a config
      // fault: no widened write, exactly like the prompt layer contributing
      // nothing. Returning here rather than falling through to the next
      // identity keeps a configuration error from silently changing whose root
      // receives the write. The base policy still decides.
      return undefined
    }
  }
  return undefined
}

/**
 * Stamp the origin id and refresh the index pointer after a memory write, for
 * every root this execution may have written to.
 *
 * The hook runs inside the `tools/post-execute` waterfall, so `exec.signal` is
 * observed at every await: a cancelled caller abandons the remaining work
 * rather than starting more I/O. Bailing out after the stamp leaves the index
 * without that file's line, which the next write to the same file or the
 * extraction index refresh repairs.
 * @param {{ctx: {get?: (name: string) => unknown}, exec: import('@deepseek-ai/dsh-tools').ToolExecution, registry: import('./context.js').MemoryContextRegistry, config: Record<string, unknown>, logger?: {warn: (message: string) => void}}} options
 */
async function maintainIndexAfterWrite({ ctx, exec, registry, config, logger }) {
  const signal = exec.signal
  if (signal?.aborted) return
  const target = memoryWriteTarget(exec)
  if (target === undefined) return
  for (const root of memoryRootsFor({ ctx, registry, exec, config })) {
    if (signal?.aborted) return
    await maintainIndexForRoot({ target, root, signal, logger })
  }
}

/**
 * The single-root half of {@link maintainIndexAfterWrite}: a target that does
 * not resolve inside this root is none of its business.
 * @param {{target: string, root: MemoryRoot, signal?: AbortSignal, logger?: {warn: (message: string) => void}}} options
 */
async function maintainIndexForRoot({ target, root, signal, logger }) {
  const filePath = resolveSafeMemoryFilePath({
    filePath: target,
    rootDir: root.rootDir,
    workingDirectory: root.cwd,
  })
  if (filePath === undefined) return

  try {
    // Same per-root lock the MemoryStore write paths take, so a direct
    // write/edit and a `memory` tool write on the same root cannot interleave
    // their read-modify-write of MEMORY.md. Both files are replaced atomically.
    await withMemoryRootLock(root.rootDir, async () => {
      const original = await readFile(filePath, 'utf8')
      if (signal?.aborted) return
      const stamped = stampMemoryOriginSessionId(original, root.sessionId)
      if (stamped !== original) await atomicWriteFile(filePath, stamped)
      if (signal?.aborted) return

      const parsed = parseMemoryFile(stamped)
      const file = basename(filePath)
      const title = parsed.name ?? file.replace(/\.md$/iu, '')
      const hook = parsed.description ?? ''
      const index = await readIndex(root.rootDir)
      if (signal?.aborted) return
      await atomicWriteFile(
        join(root.rootDir, MEMORY_INDEX_NAME),
        upsertMemoryIndexLine(index, { file, title, hook }),
      )
      root.invalidateIndex?.()
    })
  } catch (error) {
    logger?.warn(`memory: index maintenance failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * @param {import('./context.js').MemoryContextRegistry} registry
 * @param {import('@deepseek-ai/dsh-tools').ToolExecution} exec
 * @returns {import('./context.js').AgentMemoryContext | undefined}
 */
function memoryFor(registry, exec) {
  const sessionId = exec.agent?.session?.id
  return typeof sessionId === 'string' ? registry.get(sessionId) : undefined
}

/**
 * @param {unknown} value
 * @returns {string | undefined} the trimmed string, or undefined when blank.
 */
function nonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * @param {string} rootDir
 * @returns {Promise<string>}
 */
async function readIndex(rootDir) {
  try {
    return await readFile(join(rootDir, MEMORY_INDEX_NAME), 'utf8')
  } catch {
    return ''
  }
}
