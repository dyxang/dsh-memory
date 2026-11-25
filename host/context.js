/**
 * Per-agent memory context: resolves one agent's memory root and caches the
 * store plus a short-TTL copy of the index so the synchronous
 * `systemPrompt` section/context providers can serve it.
 *
 * @module dsh-memory/host/context
 */

import { MemoryStore } from '../src/memory-store.js'
import { resolveStorageRoot } from '../src/memory-root.js'
import { resolveProjectMemoryRoot } from '../src/memory-root.js'
import { configValue } from '../src/config-value.js'
import {
  INDEX_CHAR_LIMIT_DEFAULT,
  INDEX_LINE_LIMIT_DEFAULT,
  memoryWidthPreset,
} from '../src/memory-width.js'

/** Default freshness window for the cached index copy. */
const INDEX_TTL_MS = 5_000

/** One agent's memory world. */
export class AgentMemoryContext {
  /**
   * @param {{rootDir: string, cwd: string, sessionId: string}} options
   */
  constructor({ rootDir, cwd, sessionId }) {
    this.rootDir = rootDir
    this.cwd = cwd
    this.sessionId = sessionId
    this.store = new MemoryStore({ rootDir, sessionId })
    this.indexCache = { text: '', at: 0, loading: false }
  }

  /** Invalidate the cached index so the next read refetches it. */
  invalidateIndex() {
    this.indexCache.at = 0
  }

  /**
   * The layered prompt view, refreshing at most once per TTL.
   * @param {{lineLimit?: number, charLimit?: number}} limits the on-demand layer's budget.
   * @param {{lineLimit?: number, charLimit?: number}} [alwaysOnLimits] the always-on layer's budget.
   * @returns {string}
   */
  indexForPrompt(limits, alwaysOnLimits) {
    const now = Date.now()
    if (now - this.indexCache.at > INDEX_TTL_MS && !this.indexCache.loading) {
      this.indexCache.loading = true
      void this.store.readPromptView(limits, alwaysOnLimits)
        .then((text) => {
          this.indexCache.text = text
          this.indexCache.at = Date.now()
        })
        .catch(() => { /* a failed refresh keeps the previous copy */ })
        .finally(() => { this.indexCache.loading = false })
    }
    return this.indexCache.text
  }

  /** Force a synchronous-usable refresh and await it. */
  async refreshIndex(limits, alwaysOnLimits) {
    try {
      this.indexCache.text = await this.store.readPromptView(limits, alwaysOnLimits)
      this.indexCache.at = Date.now()
    } catch {
      /* keep the previous copy */
    }
  }
}

/**
 * Owns the storage root and every agent's {@link AgentMemoryContext}.
 */
export class MemoryContextRegistry {
  /**
   * @param {{config: Record<string, unknown>, env?: NodeJS.ProcessEnv}} options
   */
  constructor({ config, env }) {
    this.config = config
    this.storageRoot = resolveStorageRoot(config, env)
    /** @type {Map<string, AgentMemoryContext>} */
    this.agents = new Map()
    /**
     * In-flight resolutions. The startup loop over `agents.list()` and the
     * `agent/created` listener can call `contextFor` for the same agent before
     * either settles; without this the second call builds a second context and
     * overwrites the first, running `ensureRoot` and the index refresh twice.
     * @type {Map<string, Promise<AgentMemoryContext>>}
     */
    this.pending = new Map()
    /**
     * Memory roots already reconciled this process. `reconcileIndex` scans the
     * whole root, so running it once per root (not once per session on the same
     * root) keeps startup cost flat. A root whose reconcile failed is removed
     * so a later context retries it.
     * @type {Set<string>}
     */
    this.reconciled = new Set()
  }

  /**
   * Resolve (and cache) one agent's memory context.
   *
   * The caller passes a live `Agent` handle. Its identity is
   * `agent.session.id` (`agent.id` carries the same SessionId) and its working
   * directory is `agent.session.header.cwd`. The `Agent` interface declares
   * neither a `sessionId` nor a `cwd` field, so reading one yields `undefined`
   * silently: the registry then stores under the key `undefined` while every
   * reader looks up a real session id, and the working directory collapses onto
   * the host process's own cwd.
   * @param {{id?: string, session?: {id?: string, header?: {cwd?: string}}}} agent
   * @param {{resolveByPath: (path: string) => Promise<{id?: string} | undefined>}} [workspaceRegistry]
   * @returns {Promise<AgentMemoryContext>}
   */
  async contextFor(agent, workspaceRegistry) {
    const sessionId = agent.session?.id ?? agent.id
    const cached = this.agents.get(sessionId)
    if (cached !== undefined) return cached
    const inFlight = this.pending.get(sessionId)
    if (inFlight !== undefined) return inFlight
    const resolution = this.resolveContext(sessionId, agent, workspaceRegistry)
    this.pending.set(sessionId, resolution)
    try {
      return await resolution
    } finally {
      this.pending.delete(sessionId)
    }
  }

  /**
   * Build one agent's context, publish it, and warm its root and index.
   * @param {string} sessionId
   * @param {{session?: {header?: {cwd?: string}}}} agent
   * @param {{resolveByPath: (path: string) => Promise<{id?: string} | undefined>}} [workspaceRegistry]
   * @returns {Promise<AgentMemoryContext>}
   */
  async resolveContext(sessionId, agent, workspaceRegistry) {
    const cwd = agent.session?.header?.cwd ?? process.cwd()
    let workspaceId
    try {
      const workspace = await workspaceRegistry?.resolveByPath(cwd)
      workspaceId = workspace?.id
    } catch {
      workspaceId = undefined
    }
    const rootDir = resolveProjectMemoryRoot({
      storageRoot: this.storageRoot,
      workspacePath: cwd,
      workspaceId,
    })
    const context = new AgentMemoryContext({ rootDir, cwd, sessionId })
    this.agents.set(sessionId, context)
    try {
      await context.store.ensureRoot()
    } catch {
      /* directory creation failure never blocks the agent */
    }
    // Heal the index before the first prompt view is built: a memory file that
    // exists without a MEMORY.md pointer is otherwise never injected. Guarded
    // and once-per-root, and a failure must not block the agent.
    if (!this.reconciled.has(rootDir)) {
      this.reconciled.add(rootDir)
      try {
        await context.store.reconcileIndex()
      } catch {
        this.reconciled.delete(rootDir)
      }
    }
    await context.refreshIndex(this.indexLimits(), this.alwaysOnLimits())
    return context
  }

  /**
   * @param {string} sessionId
   * @returns {AgentMemoryContext | undefined}
   */
  get(sessionId) {
    return this.agents.get(sessionId)
  }

  /**
   * @param {string} sessionId
   */
  drop(sessionId) {
    this.agents.delete(sessionId)
    this.pending.delete(sessionId)
  }

  /**
   * The index budgets for prompt injection.
   *
   * A width of `slim` or `extended` moves these budgets — that is the dial's
   * answer to a topic that has grown to occupy most of the injected index —
   * but only while the key still sits on its schema default. A value the user
   * patched to anything else is theirs and wins at every width: the width
   * chooses a budget, it never overrides an explicit one.
   *
   * `memoryWidth` is volatile, so it is read per call rather than captured in
   * the constructor; a snapshot would go stale the moment the Plugins page
   * saves a new width.
   * @returns {{lineLimit: number, charLimit: number}}
   */
  indexLimits() {
    const preset = memoryWidthPreset(configValue(this.config.memoryWidth))
    const lineLimit = numberOr(this.config.indexLineLimit, INDEX_LINE_LIMIT_DEFAULT)
    const charLimit = numberOr(this.config.indexCharLimit, INDEX_CHAR_LIMIT_DEFAULT)
    return {
      lineLimit: lineLimit === INDEX_LINE_LIMIT_DEFAULT ? preset.indexLineLimit : lineLimit,
      charLimit: charLimit === INDEX_CHAR_LIMIT_DEFAULT ? preset.indexCharLimit : charLimit,
    }
  }

  /**
   * The always-on layer's budget at the configured width (see
   * `src/memory-layers.js`). It follows the width preset unconditionally: the
   * layer has no separate config key, because "how much room memory gets" is
   * the width dial's single question.
   *
   * `memoryWidth` is volatile, so it is read per call rather than captured in
   * the constructor; a snapshot would go stale the moment the Plugins page
   * saves a new width.
   * @returns {{lineLimit: number, charLimit: number}}
   */
  alwaysOnLimits() {
    const preset = memoryWidthPreset(configValue(this.config.memoryWidth))
    return { lineLimit: preset.alwaysOnLineLimit, charLimit: preset.alwaysOnCharLimit }
  }

  /** Drop every cached context. */
  dispose() {
    this.agents.clear()
    this.pending.clear()
    this.reconciled.clear()
  }
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
