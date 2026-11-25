/**
 * dsh-memory — file-based persistent agent memory for DeepSeek Harness.
 *
 * A file-based persistent agent memory subsystem: one Markdown file per fact
 * with YAML frontmatter, a `MEMORY.md`-backed view injected every turn
 * (always-on rules as text, the rest as on-demand pointers), automatic
 * extraction after each turn, and per-subagent persistent memory.
 *
 * Host half. Everything is registered inside `apply` with `ctx.effect` /
 * `ctx.on`, so unloading the plugin removes every registration.
 *
 * @module dsh-memory
 */

import { MemoryContextRegistry } from './host/context.js'
import { createAgentMemorySection } from './host/agent-memory.js'
import { installMemoryExtraction } from './host/extract.js'
import { installMemoryWritePermission } from './host/permission.js'
import { installMemoryRoutes } from './host/status.js'
import { createMemoryTool } from './host/tool.js'
import { buildMemoryContent, MEMORY_INDEX_ORDER, MEMORY_SECTION_ORDER } from './src/memory-prompt.js'
import { memoryWidthPreset, MEMORY_WIDTHS } from './src/memory-width.js'
import { configValue } from './src/config-value.js'
import Schema from '@deepseek-ai/schemastery'

/** Core services without which this plugin cannot function. */
export const inject = ['agents', 'systemPrompt', 'tools']

/**
 * Every config key's default. The loader replaces a patched row's whole
 * `config` value instead of deep-merging keys, so without these defaults a
 * user overriding one key in their own `cordis.patch.yml` would silently drop
 * the others. Filling them here lets a row carry only what it changes.
 *
 * The values mirror the fallbacks the consumers already apply
 * (`numberOr(config.x, DEFAULT)` and `config.x !== false`), so applying them
 * changes no behavior.
 */
export const CONFIG_DEFAULTS = {
  enabled: true,
  storageRoot: '',
  extractionEnabled: true,
  injectRules: true,
  injectIndex: true,
  indexLineLimit: 200,
  indexCharLimit: 25_000,
  minUserChars: 12,
  minCjkChars: 3,
  recentBodiesInPrompt: 20,
  extractionDebounceMs: 1_500,
  drainTimeoutMs: 60_000,
  includeSubagents: false,
  extractionMinTurns: 5,
  extractionMinSteps: 40,
  model: '',
  allowMemoryWrites: true,
  memoryWidth: 'balanced',
  // Sub-agent persistent memory: sub-agent identity → scope. Empty by
  // default, which keeps the feature off; see host/agent-memory.js.
  agentMemoryScopes: {},
}

/**
 * The three sub-agent memory scopes. Mirrors `isAgentMemoryScope` in
 * `src/agent-memory.js`, which stays the runtime gate.
 */
const AGENT_MEMORY_SCOPE = Schema.union(['user', 'project', 'local'])

/**
 * The configuration this plugin receives, including each `Volatile<T>`
 * reference. The plain-JavaScript equivalent of the `export interface Config`
 * the settings-card cookbook asks for: it describes what `apply` is handed, so
 * a reader sees the reading shape without opening every consumer.
 *
 * An ordinary field arrives as its plain value (`config.enabled === true`); a
 * `Volatile<T>` field arrives as a stable reference whose `.get()` yields the
 * value, defaulting to the schema's `.default()` when the row omits it. Read
 * `.get()` when starting an operation; capture the values once when one
 * operation needs a consistent snapshot.
 *
 * @typedef {object} MemoryConfig
 * @property {boolean} enabled Master switch; when false only the status routes mount.
 * @property {string} storageRoot Memory root; empty follows `~/.dsh/memories`.
 * @property {import('@deepseek-ai/cordis').Volatile<boolean>} extractionEnabled Auto-extract after each turn.
 * @property {boolean} injectRules Inject the memory rules section.
 * @property {boolean} injectIndex Inject the layered memory view: the always-on rules as text and the remaining entries as pointers.
 * @property {number} indexLineLimit Index line budget.
 * @property {number} indexCharLimit Index character budget.
 * @property {import('@deepseek-ai/cordis').Volatile<number>} minUserChars English characters that trigger extraction.
 * @property {import('@deepseek-ai/cordis').Volatile<number>} minCjkChars CJK characters that trigger extraction.
 * @property {import('@deepseek-ai/cordis').Volatile<number>} recentBodiesInPrompt Recent bodies the extraction prompt sees.
 * @property {number} extractionDebounceMs Debounce before extraction runs.
 * @property {number} drainTimeoutMs How long a drain waits for the session log.
 * @property {import('@deepseek-ai/cordis').Volatile<boolean>} includeSubagents Extract sub-agent sessions too.
 * @property {import('@deepseek-ai/cordis').Volatile<number>} extractionMinTurns Closed turns a session needs before extraction starts; 0 disables the turn half of the gate.
 * @property {import('@deepseek-ai/cordis').Volatile<number>} extractionMinSteps Closed steps a session needs before extraction starts; 0 disables the step half of the gate.
 * @property {import('@deepseek-ai/cordis').Volatile<string>} model Extraction model; empty follows the session.
 * @property {boolean} allowMemoryWrites Allow direct writes inside the memory root.
 * @property {import('@deepseek-ai/cordis').Volatile<string>} memoryWidth How much room one memory gets: `extended`, `balanced` or `slim`. `balanced` is the pre-dial behaviour; `slim` caps bodies and prefers folding into existing files.
 * @property {Record<string, 'user'|'project'|'local'>} agentMemoryScopes Sub-agent identity → scope; empty disables the feature.
 */

/**
 * The config schema.
 *
 * Schemastery rather than a hand-written Standard Schema object, because the
 * settings page derives its form from `schema.meta.volatile`
 * (`packages/settings/settings/src/schema.ts`, `volatileForm`) and refuses
 * `settings.update` on a field the schema does not mark volatile. A bare
 * `{'~standard': {...}}` object carries no `.meta` and no traversable
 * structure, so it can drive neither.
 *
 * Schemastery implements Standard Schema itself
 * (`Schema.prototype['~standard']`, `vendor/schemastery/src/index.ts:290`), so
 * Cordis's `resolveConfig` (`vendor/cordis/src/fiber.ts:50-62`) — which only
 * calls `~standard.validate` and rejects an async result — keeps working
 * unchanged.
 *
 * Reading shape is documented on {@link MemoryConfig}. Nothing normalizes the
 * volatile references away here: {@link apply} passes the validated config
 * through untouched and every consumer reads the reference at its point of
 * use, because a volatile-only patch is committed into the running fiber
 * without a remount and a snapshot taken during `apply` would go stale.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  storageRoot: Schema.string().default(''),
  extractionEnabled: Schema.boolean().default(true).volatile(),
  injectRules: Schema.boolean().default(true),
  injectIndex: Schema.boolean().default(true),
  indexLineLimit: Schema.number().step(1).min(0).default(200),
  indexCharLimit: Schema.number().step(1).min(0).default(25_000),
  minUserChars: Schema.number().step(1).min(0).default(12).volatile(),
  minCjkChars: Schema.number().step(1).min(0).default(3).volatile(),
  recentBodiesInPrompt: Schema.number().step(1).min(0).default(20).volatile(),
  extractionDebounceMs: Schema.number().step(1).min(0).default(1_500),
  drainTimeoutMs: Schema.number().step(1).min(0).default(60_000),
  includeSubagents: Schema.boolean().default(false).volatile(),
  // Session warm-up gate: extraction starts only once the session has closed at
  // least this many turns AND steps (the `sessionStats` figures the session
  // panel shows). Both 0 disables the gate.
  extractionMinTurns: Schema.number().step(1).min(0).default(5).volatile(),
  extractionMinSteps: Schema.number().step(1).min(0).default(40).volatile(),
  model: Schema.string().default('').volatile(),
  allowMemoryWrites: Schema.boolean().default(true),
  // Memory width: `extended` / `balanced` / `slim`, resolved through
  // `src/memory-width.js`. `balanced` reproduces the pre-dial behaviour, so
  // the default changes nothing for an existing deployment.
  memoryWidth: Schema.union(MEMORY_WIDTHS).default('balanced').volatile(),
  // Sub-agent persistent memory: sub-agent identity → scope. Empty by
  // default, which keeps the feature off; see host/agent-memory.js.
  agentMemoryScopes: Schema.dict(AGENT_MEMORY_SCOPE).default({}),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} configInput validated by {@link Config}.
 *
 * The nine `.volatile()` fields arrive as `{ get() }` references, not values, so
 * a consumer must read `config.<field>.get()`. Unwrapping them once here would
 * look tidier, but it is wrong: a volatile-only patch is committed into the
 * running fiber without a remount (`vendor/loader/src/config/entry.ts:162-194`),
 * so a snapshot taken in `apply` goes stale the moment the user saves a new
 * value in the Plugins page, and the edit silently does nothing until some
 * unrelated change forces a reload. Reading at the point of use is the pattern
 * the harness packages follow (`packages/llm/llm-deepseek/README.md:106`).
 *
 * The readers are `host/extract.js`, `host/status.js`, `host/context.js` and
 * the prompt fiber in {@link apply} itself. Adding another volatile key
 * means updating every one of them; the `.volatile()` marks in {@link Config}
 * above are the checklist.
 */
export function apply(ctx, configInput) {
  const logger = ctx.logger
  const config = configInput
  const registry = new MemoryContextRegistry({ config })

  if (config.enabled === false) {
    // Still expose the routes so the settings page can explain that memory is off.
    ctx.inject(['webServer', 'connection'], (scope) => {
      installMemoryRoutes({ ctx: scope, registry, config, logger })
    })
    return
  }

  ctx.inject(['agents', 'systemPrompt', 'tools', 'webServer', 'connection', 'workspaceRegistry'], (scope) => {
    scope.effect(() => scope.tools.register(createMemoryTool({ registry, logger })), 'dsh-memory: memory tool')
    installMemoryWritePermission({ ctx: scope, registry, config, logger })
    installMemoryRoutes({ ctx: scope, registry, config, logger })

    /** @type {Map<string, ReturnType<import('@deepseek-ai/cordis').Context['inject']>>} */
    const promptFibers = new Map()

    const installPrompt = (agent) => {
      const existing = promptFibers.get(agent.session.id)
      if (existing !== undefined) return existing
      const fiber = agent.ctx.inject(['systemPrompt'], (agentScope) => {
        if (config.injectRules !== false) {
          agentScope.systemPrompt.section({
            name: 'Memory',
            order: MEMORY_SECTION_ORDER,
            text: () => buildMemoryContent(
              registry.get(agent.session.id)?.rootDir ?? '',
              // Volatile: read per prompt build, so a width saved in the
              // Plugins page reaches the next turn. `memoryWidthPreset`
              // tolerates a stale or unknown value by falling back to
              // `balanced`, which is the pre-dial text.
              memoryWidthPreset(configValue(config.memoryWidth)).width,
            ),
          })
        }
        if (config.injectIndex !== false) {
          agentScope.systemPrompt.context({
            name: 'MemoryIndex',
            order: MEMORY_INDEX_ORDER,
            // The layered view: always-on rules as text, the rest as pointers.
            // Both budgets are read per assembly, because `memoryWidth` is
            // volatile and a saved width must reach the next turn.
            text: () => registry.get(agent.session.id)
              ?.indexForPrompt(registry.indexLimits(), registry.alwaysOnLimits()) ?? '',
          })
        }
        // Sub-agent persistent memory rides the same fiber, so the section
        // registration, the identity cache and the dispose path all unwind
        // with `disposePrompt`. The call itself is contained: a failure here
        // must not cost the agent its Memory sections.
        try {
          const agentMemory = createAgentMemorySection({ ctx: agentScope, agent, registry, config, logger })
          if (agentMemory !== undefined) {
            agentScope.systemPrompt.section(agentMemory)
          }
        } catch (error) {
          logger.warn(`dsh-memory: agent memory section failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
      promptFibers.set(agent.session.id, fiber)
      return fiber
    }

    const disposePrompt = (sessionId) => {
      const fiber = promptFibers.get(sessionId)
      if (fiber === undefined) return
      promptFibers.delete(sessionId)
      void Promise.resolve(fiber.dispose()).catch((error) => {
        logger.warn(`dsh-memory: prompt cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    for (const agent of scope.agents.list()) {
      void registry.contextFor(agent, scope.workspaceRegistry).then(() => installPrompt(agent))
    }

    scope.on('agent/created', async ({ agent }) => {
      try {
        await registry.contextFor(agent, scope.workspaceRegistry)
      } catch (error) {
        logger.warn(`dsh-memory: memory root setup failed: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      installPrompt(agent)
    })

    scope.on('agent/disposed', ({ agent }) => {
      disposePrompt(agent.session.id)
      registry.drop(agent.session.id)
    })

    scope.effect(() => async () => {
      for (const sessionId of [...promptFibers.keys()]) disposePrompt(sessionId)
      registry.dispose()
    }, 'dsh-memory: agent memory contexts')
  })

  // Automatic extraction is a soft dependency: it needs the model route, the
  // session log and timers, none of which every profile mounts. Keeping it in
  // its own `ctx.inject` means a profile without them still gets the tool, the
  // write policy and the routes — only extraction stays off (design decision
  // D1; see host/extract.js).
  ctx.inject(['llm', 'agentDefaultModel', 'sessionQuery', 'timer'], (scope) => {
    installMemoryExtraction({ ctx: scope, registry, config, logger })
  })
}
