/**
 * Sub-agent persistent memory — the prompt layer.
 *
 * A sub-agent whose identity carries a scope in `agentMemoryScopes` receives
 * the persistent-memory prompt (`src/agent-memory-prompt.js`) as its own
 * prompt section, pointed at a per-agent memory root resolved by
 * `src/agent-memory.js`. The section sits immediately after the deployment
 * persona prefix, so a sub-agent reads its memory rules before its tools.
 *
 * Identity resolution is lazy, and asynchronous underneath: the catalog
 * label (`ctx.subagents.listChildren`) is not reliably populated when
 * `agent/created` fires, and `PromptSection.text` is a synchronous provider.
 * The resolver therefore answers synchronously from the two identities that
 * need no await — the session header's `agentPreset` and the Team name — keeps
 * a short-TTL cache, and refreshes the label in the background for the
 * configurations keyed on it. A missing `ctx.subagents` service, a profile
 * without the `agentTeams` service, an empty catalog, or a throwing root
 * resolution is a silent no-op — never a throw, because a prompt provider that
 * throws fails the whole assembly.
 *
 * Identity order — the session header's `agentPreset` first, the Team name
 * second, the catalog label third — is deliberate: a stable agent identity is
 * the durable key for the root, whereas DSH's catalog label is the initial
 * delegation's free-text `description` (`packages/subagent/subagent/src/types.ts:35-36`).
 * A label-keyed root would therefore be recreated for every re-phrasing of
 * the delegation, splitting one sub-agent's memory across directories. The
 * label stays supported as the last identity, so an operator may key the
 * configuration on any spelling; whichever identity resolves the scope also
 * names the root, which keeps "the config key is the memory identity" true in
 * every case.
 *
 * The Team name sits between those two because it is a teammate's REAL identity
 * and it is still synchronous: `agentTeams.tryMembership(agent)` answers a
 * `TeamMembership` (`dsh-experimental-agent-team/lib/types/roster.d.ts:11-16`;
 * the service method, documented as non-throwing, at
 * `lib/types/index.d.ts:100-105`), and a teammate's `name` is the durable
 * identity the Lead addresses — unlike the label, which is the free-text
 * delegation description. See {@link teamNameFor} for the two deliberate
 * exclusions (non-`teammate` memberships, and a profile with no Team service).
 *
 * Known deviations, recorded so a later reader does not "repair" them by
 * accident:
 *
 * 1. The template names the `Write` tool; DSH registers the same tool
 *    under the lower-case `write`. The main-conversation Memory section
 *    carries the same wording, so both prompts stay consistent and the
 *    correction belongs to one coordinated change across both templates.
 * 2. The prompt ships in English and Chinese, but the host cannot read the
 *    active UI language (the locale service is Client-side), so the builder's
 *    `lang` default applies. Choosing the language needs a config key or a
 *    host-side locale read, neither of which this module introduces.
 * 3. This is the prompt layer only. The write-permission listener resolves the
 *    same identity chain (`host/permission.js`), but only its synchronous half:
 *    `agentPreset` and the Team name widen an agent-memory root, while a
 *    configuration keyed solely on the delegation label stays prompt-only,
 *    because that label lives behind an asynchronous catalog read and both
 *    decision hooks answer synchronously.
 *
 * @module dsh-memory/host/agent-memory
 */

import { AgentMemoryContext } from './context.js'
import { isAgentMemoryScope, resolveAgentMemoryRoot, sanitizeAgentMemoryKey } from '../src/agent-memory.js'
import { buildAgentMemoryPrompt } from '../src/agent-memory-prompt.js'

/**
 * Section name for the sub-agent memory prompt. Owned by this plugin and
 * namespaced: `deployment:persona-prefix` is already registered globally by
 * the system-prompt service and per child by the subagent composition, so
 * re-using either name throws on a duplicate registration.
 */
export const AGENT_MEMORY_SECTION_NAME = 'dsh-memory:agent'

/** How often a resolved identity is re-read from the catalog. */
const IDENTITY_TTL_MS = 5_000

/** How often an unresolved identity retries, so a cold catalog recovers fast. */
const IDENTITY_RETRY_MS = 500

/**
 * Whether `agent` is a sub-agent session, by the two documented
 * `SessionHeader` signals (`origin` / `delegationDepth`).
 * @param {{session?: {header?: {origin?: string, delegationDepth?: number}}}} agent
 * @returns {boolean}
 */
export function isSubagentAgent(agent) {
  const header = agent?.session?.header
  if (header === null || typeof header !== 'object') return false
  return header.origin === 'subagent'
    || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

/**
 * The Team name this agent holds, or `undefined` when it holds none that
 * identifies it.
 *
 * A teammate's name is NOT on the subagent catalog label: the label is the
 * delegation's free-text `description`, while the name is the teammate's
 * durable Team identity. `agentTeams.tryMembership(agent)` answers it
 * synchronously (`dsh-experimental-agent-team/lib/types/roster.d.ts:11-16`
 * declares `TeamMembership`, `lib/types/index.d.ts:100-105` the method), which
 * is what keeps this candidate on the synchronous half of the identity chain.
 *
 * Two deliberate silent skips:
 *
 * 1. A profile that does not mount Agent Teams has no `agentTeams` service at
 *    all, so `ctx.get('agentTeams')` answers `undefined`; and `ctx` itself is
 *    allowed to be a minimal stand-in (`tests/agent-memory.mjs` builds one),
 *    hence the `typeof ctx.get` guard rather than a bare call.
 * 2. The probe is documented as non-throwing, but a disposed or half-built
 *    roster can still throw; a prompt provider must never throw, so the call is
 *    swallowed and the identity chain simply moves on.
 *
 * Only a `role: 'teammate'` membership contributes a name. The same probe
 * answers a synthetic `{ role: 'lead', name: 'lead' }` for an implicit-team
 * root or a forked child outside the roster
 * (`dsh-experimental-agent-team/lib/types/roster.js:63-89`); "lead" there is a
 * keyword, not an identity, and letting it match a configured `lead` scope
 * would hand a non-Team child the root an operator meant for the Team Lead.
 *
 * @param {{get?: (name: string) => unknown}} ctx
 * @param {object} agent the exact live Agent handle
 * @returns {string | undefined}
 */
export function teamNameFor(ctx, agent) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return undefined
  const teams = tryCall(() => ctx.get('agentTeams'))
  if (teams === null || typeof teams !== 'object' || typeof teams.tryMembership !== 'function') return undefined
  const membership = tryCall(() => teams.tryMembership(agent))
  if (membership === null || typeof membership !== 'object') return undefined
  if (membership.role !== 'teammate') return undefined
  const name = membership.name
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined
}

/**
 * Build the sub-agent memory section for one agent, or `undefined` when the
 * agent gets none: a non-subagent session, or a configuration that declares
 * no scope at all (the default, which keeps the feature off).
 *
 * The returned section's `text` provider resolves identity lazily and reads
 * the memory index through a TTL cache, so every assembly is synchronous. A
 * disposer for the resolver rides the calling context's fiber, so the cache
 * unwinds with the section registration.
 *
 * @param {{ctx: import('@deepseek-ai/cordis').Context, agent: object,
 *   registry: import('./context.js').MemoryContextRegistry,
 *   config: Record<string, unknown>, logger?: {warn: (message: string) => void}}} options
 * @returns {object | undefined} a `PromptSection`, or `undefined`.
 */
export function createAgentMemorySection({ ctx, agent, registry, config, logger }) {
  const warn = createWarner(logger)
  const header = agent?.session?.header
  if (!isSubagentAgent(agent)) return undefined

  const scopes = config?.agentMemoryScopes
  if (scopes === null || typeof scopes !== 'object' || Array.isArray(scopes)) return undefined
  if (Object.keys(scopes).length === 0) return undefined

  const sessionId = agent.session?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const parentSession = typeof header.parentSession === 'string' && header.parentSession.length > 0
    ? header.parentSession
    : undefined
  const preset = typeof header.agentPreset === 'string' && header.agentPreset.trim().length > 0
    ? header.agentPreset.trim()
    : undefined
  // The Team name is resolved once, here: a membership name is immutable for the
  // life of the member (`TeamMembership.name`,
  // `dsh-experimental-agent-team/lib/types/roster.d.ts:11-16`), so re-probing on
  // every assembly would only repeat a synchronous service call.
  const teamName = teamNameFor(ctx, agent)
  const cwd = typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : process.cwd()

  const resolver = createResolver({ ctx, sessionId, parentSession, preset, teamName, cwd, scopes, registry, warn })

  // The resolver holds no handles, but dropping it on unload keeps a reloaded
  // fiber from inheriting a stale identity cache.
  ctx.effect(() => () => resolver.dispose(), 'dsh-memory: agent memory resolver')

  return {
    name: AGENT_MEMORY_SECTION_NAME,
    // Immediately after the persona prefix. The offset keeps this section
    // clear of the prefix itself and of the next centrally allocated slot;
    // equal orders would fall back to name order, which no plugin controls.
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
    text: () => {
      const resolved = resolver.current()
      if (resolved === undefined) {
        // Unresolved (cold catalog, no scope for this identity, unusable
        // root): keep retrying in the background and contribute nothing.
        resolver.refresh()
        return ''
      }
      resolver.refreshIfDue()
      try {
        return buildAgentMemoryPrompt({
          // The layered view: always-on rules as text, the rest as pointers.
          // `indexForPrompt` serves the TTL-cached, budgeted view and refreshes
          // it in the background; raw `MEMORY.md` is never passed.
          indexContent: resolved.context.indexForPrompt(registry.indexLimits(), registry.alwaysOnLimits()),
          rootDir: resolved.rootDir,
          scope: resolved.scope,
        })
      } catch (error) {
        warn(`dsh-memory: agent memory prompt failed: ${describeError(error)}`)
        return ''
      }
    },
  }
}

/* -------------------------------------------------------------- resolver ---- */

/**
 * The identity → root resolver behind one section.
 *
 * `current()` is synchronous and never performs I/O: it answers from the
 * configured identity (the session header's `agentPreset`, the Team name, or
 * the catalog label once one has been read) and the memory context built for
 * the resulting root. `refresh()` is the only asynchronous path and is always
 * called fire-and-forget.
 *
 * @returns {{current: () => ({context: import('./context.js').AgentMemoryContext, rootDir: string, scope: 'user'|'project'|'local'} | undefined), refresh: () => void, refreshIfDue: () => void, dispose: () => void}}
 */
function createResolver({ ctx, sessionId, parentSession, preset, teamName, cwd, scopes, registry, warn }) {
  /** @type {{label?: string, agentKey?: string, attemptedAt: number, pending?: Promise<void>, context?: import('./context.js').AgentMemoryContext, rootDir?: string, scope?: 'user'|'project'|'local'}} */
  const state = { attemptedAt: 0 }

  /**
   * The identity that resolves a scope, and that scope. The preset is tried
   * first because it is the stable, persisted identity; the Team name second
   * because it is a teammate's real name and still synchronous; the label
   * last, so a configuration keyed on the delegation's wording still works.
   * The winner also names the memory root.
   * @returns {{agentKey: string, scope: 'user'|'project'|'local'} | undefined}
   */
  const resolveIdentity = () => {
    for (const candidate of [preset, teamName, state.label]) {
      if (candidate === undefined) continue
      const scope = pickScope(scopes, candidate)
      if (scope !== undefined) return { agentKey: candidate, scope }
    }
    return undefined
  }

  /** Re-derive the root, scope and memory context from the resolved identity. */
  const sync = () => {
    const resolved = resolveIdentity()
    if (resolved === undefined) {
      state.context = undefined
      state.rootDir = undefined
      state.scope = undefined
      return
    }
    if (state.context !== undefined && state.rootDir !== undefined && state.agentKey === resolved.agentKey) return
    let rootDir
    try {
      rootDir = resolveAgentMemoryRoot({
        agentKey: resolved.agentKey,
        scope: resolved.scope,
        storageRoot: registry.storageRoot,
        workspaceRoot: cwd,
      })
    } catch (error) {
      // An unusable root (blank storage root, unusable identity) is a config
      // fault: report it and contribute nothing rather than failing assembly.
      warn(`dsh-memory: agent memory root for "${resolved.agentKey}" is unusable: ${describeError(error)}`)
      state.context = undefined
      state.rootDir = undefined
      state.scope = undefined
      return
    }
    state.agentKey = resolved.agentKey
    state.rootDir = rootDir
    state.scope = resolved.scope
    state.context = new AgentMemoryContext({ rootDir, cwd, sessionId })
    // Warm the directory and the index once; `indexForPrompt` keeps it warm.
    // Both are fire-and-forget, and `indexLimits()` is read here rather than in
    // the section's `text` provider, so a throwing limit reader must degrade to
    // "no prompt" instead of escaping into the construction path.
    try {
      void Promise.resolve(state.context.store.ensureRoot()).catch(() => {})
      void state.context.refreshIndex(registry.indexLimits(), registry.alwaysOnLimits()).catch(() => {})
    } catch (error) {
      warn(`dsh-memory: agent memory index limits unusable for "${resolved.agentKey}": ${describeError(error)}`)
    }
  }

  const readLabel = async () => {
    if (parentSession === undefined) return undefined
    const subagents = typeof ctx.get === 'function' ? tryCall(() => ctx.get('subagents')) : undefined
    if (typeof subagents?.listChildren !== 'function') return undefined
    const entries = await subagents.listChildren(parentSession)
    if (!Array.isArray(entries)) return undefined
    const entry = entries.find((candidate) => candidate?.id === sessionId)
    const label = entry?.label
    return typeof label === 'string' && label.trim().length > 0 ? label.trim() : undefined
  }

  const runRefresh = async () => {
    try {
      const label = await readLabel()
      // The label sticks once seen: it is persisted with the child session, so
      // a later empty catalog must not drop an identity already in use.
      if (label !== undefined) state.label = label
    } catch (error) {
      warn(`dsh-memory: sub-agent catalog read failed: ${describeError(error)}`)
    } finally {
      state.attemptedAt = Date.now()
      sync()
    }
  }

  const refresh = () => {
    if (state.pending !== undefined) return
    const attempt = runRefresh().finally(() => { state.pending = undefined })
    state.pending = attempt
  }

  // Resolve once synchronously: the preset lives on the session header, so the
  // common case has its memory root (and its first prompt) before any await.
  sync()

  return {
    current() {
      return state.context === undefined || state.rootDir === undefined || state.scope === undefined
        ? undefined
        : { context: state.context, rootDir: state.rootDir, scope: state.scope }
    },
    refresh,
    refreshIfDue() {
      if (state.pending !== undefined) return
      // Retry quickly while nothing has resolved (a cold catalog recovers
      // within a few hundred milliseconds), then fall back to the long TTL.
      const ttl = state.context === undefined ? IDENTITY_RETRY_MS : IDENTITY_TTL_MS
      if (Date.now() - state.attemptedAt < ttl) return
      refresh()
    },
    dispose() {
      state.label = undefined
      state.agentKey = undefined
      state.context = undefined
      state.rootDir = undefined
      state.scope = undefined
      state.pending = undefined
    },
  }
}

/**
 * The scope one identity is configured for, or `undefined`. The config is
 * consulted by the identity as resolved and, failing that, by its sanitized
 * form, so a label carrying spaces matches the dashed key an operator would
 * naturally write.
 * @param {Record<string, unknown>} scopes
 * @param {string} agentKey
 * @returns {'user'|'project'|'local' | undefined}
 */
export function pickScope(scopes, agentKey) {
  if (scopes === null || typeof scopes !== 'object' || Array.isArray(scopes)) return undefined
  for (const candidate of [agentKey, sanitizeAgentMemoryKey(agentKey)]) {
    if (Object.hasOwn(scopes, candidate) && isAgentMemoryScope(scopes[candidate])) {
      return scopes[candidate]
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ misc ---- */

/**
 * @param {() => unknown} read
 * @returns {unknown} the value, or undefined when the read throws.
 */
function tryCall(read) {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {unknown} logger
 * @returns {(message: string) => void}
 */
function createWarner(logger) {
  if (logger !== null && typeof logger === 'object' && typeof logger.warn === 'function') {
    return (message) => logger.warn(message)
  }
  return (message) => {
    try {
      console.warn(message)
    } catch {
      /* a console-less runtime must not break a prompt provider */
    }
  }
}
