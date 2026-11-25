/**
 * Automatic memory extraction after every turn.
 *
 * The design covers the hook points, the deferred snapshot promise, the
 * bounded drain, the execute skeleton, the scheduler's coalescing, its
 * "a skip advances the cursor too" semantics, and the extraction protocol.
 *
 * Design decision D1 uses ONE structured LLM call instead of a tool-using
 * agent loop (`EXTRACTION_MAX_TURNS = 5`): the extraction prompt forbids
 * investigation — "no grepping source files, no reading code, no git" — so a
 * tool loop would spend most of its turn budget on calls that must not happen.
 * The model answers with one JSON operation plan, `src/plan-validate.js`
 * checks it, and this module applies it deterministically.
 *
 * Signal source: `session/event` filtered to `turn/end` — NOT
 * `agent/turn-stopping`. The latter is serial and blocks turn close, and it
 * never fires for failed/aborted/blocked turns (`agent-loop/src/agent.ts`
 * dispatches it only on a non-throwing ending), so turns would be missed.
 * `session/event` is a post-commit fire-and-forget feed
 * (`session/src/index.ts:66-77`) that carries every ending.
 *
 * Window source: `ctx.sessionQuery.readEvent` paged backwards from the log
 * end to the persisted cursor (`docs/probes.md` P2.6/P2.7). The cursor is a
 * `SessionSeq` token (`'seq:<n>'`); `session.seq` is the log length, so the
 * last event sits at `session.seq - 1`.
 *
 * Fail-open is a hard requirement: no extraction failure may surface as a
 * turn error. Every failure path warns and returns a non-advancing status
 * (`'error'` / `'aborted'`), so the scheduler keeps its cursor and the next
 * turn simply retries.
 *
 * The `memoryWidth` setting (`src/memory-width.js`) shapes both halves of one
 * pass: the prompt layer states the writing budget and the consolidation
 * preference, and `applyOperations` enforces the `slim` body cap, so a long
 * project cannot grow one memory into an essay by accumulation.
 *
 * @module dsh-memory/host/extract
 */

import { buildExtractionPrompt, buildMemoryContent } from '../src/memory-prompt.js'
import { resolveContainedMemoryFilePath } from '../src/memory-path.js'
import { createCursorStore } from '../src/cursor-store.js'
import { createMemoryExtractionScheduler } from '../src/extraction-scheduler.js'
import { normalizeMessages, renderTranscript } from '../src/extraction-source.js'
import { evaluateExtractionTrigger, meetsSessionMinimums, DEFAULT_MIN_CJK_CHARS, DEFAULT_MIN_SESSION_STEPS, DEFAULT_MIN_SESSION_TURNS, DEFAULT_MIN_USER_CHARS } from '../src/extraction-trigger.js'
import { parseExtractionPlan, validateExtractionPlan } from '../src/plan-validate.js'
import { configValue } from '../src/config-value.js'
import { clampMemoryBody, memoryWidthPreset } from '../src/memory-width.js'

/** Fallback for `extractionDebounceMs`; matches `cordis.patch.yml`. */
const DEFAULT_EXTRACTION_DEBOUNCE_MS = 1_500

/** Fallback for `drainTimeoutMs`, in milliseconds. */
const DEFAULT_DRAIN_TIMEOUT_MS = 60_000

/** Fallback for `recentBodiesInPrompt`. */
const DEFAULT_RECENT_BODIES_IN_PROMPT = 20

/** `readEvent`'s per-page `before` cap (`SESSION_QUERY_READ_WINDOW_MAX`). */
const READ_PAGE_SIZE = 50

/**
 * Total events one extraction may read. A normal turn is far below this; the
 * cap only bites on a stale cursor (first run, post-restart, post-rewind),
 * where paging the whole log would be wasteful. Truncation keeps the NEWEST
 * events and warns.
 */
const MAX_WINDOW_EVENTS = 500

/**
 * Safety valve for one rendered transcript: a 500-event window can still
 * carry multi-hundred-kilobyte tool results, and an over-long prompt fails
 * the model call on every later turn.
 */
const MAX_TRANSCRIPT_CHARS = 120_000

/**
 * The prompt asks the model to answer `{"operations":[]}` when there is
 * nothing worth keeping (`src/memory-prompt.js`), but models still emit the
 * older "Nothing to save." phrasing, so it is tolerated as a successful
 * no-op rather than a parse failure.
 */
const NOTHING_TO_SAVE_RE = /nothing to save|没有值得保存|无可保存/iu

/**
 * The literal empty plan of this port's protocol. Matching it here short-
 * circuits before parse/validate; the structural `operations.length === 0`
 * check in `runExtraction` remains the guarantee for any other shape that
 * validates to zero operations.
 */
const EMPTY_PLAN_RE = /\{\s*"operations"\s*:\s*\[\s*\]\s*\}/u

/** The persisted cursor token: a session log position. */
const CURSOR_TOKEN_RE = /^seq:(\d+)$/u

/**
 * Install the per-turn memory extraction pipeline for the lifetime of `ctx`.
 *
 * Hooks, all owned by `ctx` so unloading the plugin removes them:
 *  - `session/event` (emit, post-commit): filtered to `turn/end`, minus
 *    aborted turns. Light guards, then a debounced `scheduler.schedule(...)`;
 *    every heavy step runs inside the scheduler's background execution.
 *  - `session/flush` (parallel, awaited by the host): a bounded drain,
 *    mirroring `drainMemoryExtractions(timeoutMs = 60_000)`.
 *  - `agent/disposed` (emit): per-session shutdown.
 *
 * @param {{ctx: import('@deepseek-ai/cordis').Context, registry: import('./context.js').MemoryContextRegistry, config: Record<string, unknown>, logger?: {warn: (message: string) => void}}} options
 */
export function installMemoryExtraction({ ctx, registry, config, logger }) {
  const warn = createWarner(logger)

  // `extractionDebounceMs` and `drainTimeoutMs` are the only extraction settings
  // captured once, here: neither is `.volatile()`, so their value cannot change
  // without a remount that re-runs this function, and an install-time read can
  // never go stale. The nine volatile settings are read at their point of use
  // through {@link configValue} instead — do not "optimize" them back into
  // install-time captures.
  const debounceMs = numberOr(config.extractionDebounceMs, DEFAULT_EXTRACTION_DEBOUNCE_MS)
  const drainTimeoutMs = numberOr(config.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS)

  /**
   * Re-entrancy guard for `ctx.sessions.flush()`: the execute step flushes
   * for durability before persisting the cursor, and that flush dispatches
   * `session/flush` back into this plugin's drain listener. Without the guard
   * the drain would wait for the very execute that is waiting for the flush.
   */
  let flushing = false

  /**
   * One entry per session with a live scheduler.
   * @type {Map<string, {
   *   sessionId: string,
   *   memory: import('./context.js').AgentMemoryContext,
   *   cursorStore: ReturnType<typeof createCursorStore> | undefined,
   *   scheduler: ReturnType<typeof createMemoryExtractionScheduler>,
   *   pendingTimer: (() => void) | undefined,
   *   lastTurn: number,
   *   session: object | undefined,
   *   disposed: boolean,
   * }>}
   */
  const sessions = new Map()

  /* ------------------------------------------------------------ per-session ---- */

  /**
   * The cursor store is created on first use rather than in the event
   * handler: `session/event` is dispatched synchronously inside
   * `Session.append()`, so nothing that may touch the filesystem belongs on
   * that path. (`createCursorStore` is in fact a pure path computation, but
   * the constraint is worth keeping enforced rather than remembered.)
   *
   * The cursor lives in the store's own state file
   * (`<memoryRoot>/.dsh-memory-state/extraction-<sessionId>.json`). A
   * projection cannot express "advance only after a successful extraction" —
   * its `apply` is an event-driven pure fold with no write API — and
   * appending a custom session event would make the persistence layer refuse
   * the whole log (`docs/probes.md` P3.6).
   * @returns {ReturnType<typeof createCursorStore>}
   */
  const cursorStoreOf = (state) => {
    state.cursorStore ??= createCursorStore({
      sessionId: state.sessionId,
      memoryRoot: state.memory.rootDir,
    })
    return state.cursorStore
  }

  const clearPendingTimer = (state) => {
    const timer = state.pendingTimer
    state.pendingTimer = undefined
    if (typeof timer !== 'function') return
    try {
      timer()
    } catch {
      /* an already-fired disposer is a no-op */
    }
  }

  const disposeState = (state) => {
    state.disposed = true
    clearPendingTimer(state)
    // Aborts the in-flight execute through its abortSignal; work already
    // running keeps its own bounded lifetime, mirroring the scheduler's
    // shutdown behaviour.
    state.scheduler.shutdown()
    const cursorStore = state.cursorStore
    state.cursorStore = undefined
    if (cursorStore === undefined) return
    try {
      void Promise.resolve(cursorStore.dispose?.()).catch((error) => {
        warn(`dsh-memory: cursor store dispose failed: ${describeError(error)}`)
      })
    } catch (error) {
      warn(`dsh-memory: cursor store dispose failed: ${describeError(error)}`)
    }
  }

  const ensureSession = (sessionId, memory) => {
    const existing = sessions.get(sessionId)
    if (existing !== undefined && !existing.disposed) return existing
    const state = {
      sessionId,
      memory,
      cursorStore: undefined,
      scheduler: undefined,
      pendingTimer: undefined,
      lastTurn: 0,
      session: undefined,
      disposed: false,
    }
    state.scheduler = createMemoryExtractionScheduler({
      execute: async (input) => {
        const status = await runExtraction(input, state)
        // Persist the boundary before reporting an advancing status. The
        // scheduler also keeps an in-memory cursor, but that dies with the
        // process; the state file is what survives a restart. The session log
        // is flushed first so a crash can never leave the cursor ahead of
        // durable events.
        const token = input.snapshot?.cursorToken
        if ((status === 'success' || status === 'no-op') && typeof token === 'string' && token.length > 0) {
          const durable = await flushSession(input.snapshot?.session)
          if (!durable) {
            warn('dsh-memory: cursor not persisted because the session log could not be flushed; the window will be rescanned')
          } else {
            try {
              await cursorStoreOf(state).write(token)
            } catch (error) {
              // A failed persist must not change the outcome: the in-memory
              // cursor already advanced, and the next run simply rescans.
              warn(`dsh-memory: cursor persist failed: ${describeError(error)}`)
            }
          }
        }
        return status
      },
    })
    sessions.set(sessionId, state)
    return state
  }

  /**
   * Durably flush one session's log. Best-effort: an unavailable `sessions`
   * service or a failing flush reports `false` so the caller keeps its
   * cursor (the safe direction — a rescan, never a skipped window).
   * @returns {Promise<boolean>}
   */
  const flushSession = async (session) => {
    if (session === undefined || session === null) return true
    const store = typeof ctx.get === 'function' ? tryCall(() => ctx.get('sessions')) : undefined
    if (typeof store?.flush !== 'function') return true
    flushing = true
    try {
      await store.flush(session)
      return true
    } catch (error) {
      warn(`dsh-memory: session flush failed: ${describeError(error)}`)
      return false
    } finally {
      flushing = false
    }
  }

  /* -------------------------------------------------------------- snapshot ---- */

  /**
   * Build the deferred snapshot: every asynchronous step (read the cursor,
   * page the window, normalize, render, resolve the route) happens here, in
   * the scheduler's background. Never rejects — a failure resolves to a
   * sentinel carrying `error`, so `execute` reports `'error'` instead of an
   * unhandled rejection (the scheduler would also swallow a rejection, but
   * silently).
   * @returns {Promise<object>}
   */
  const captureSnapshot = (state, session, turn) => {
    const memory = state.memory
    return (async () => {
      // Yield once before touching anything: this promise is created inside
      // the synchronous `session/event` dispatch (i.e. inside
      // `Session.append()`), and nothing below — least of all a filesystem
      // touch — may run on that path.
      await Promise.resolve()
      try {
        const cursorToken = normalizeCursorToken(await cursorStoreOf(state).read())
        const cursorSeq = cursorSeqOf(cursorToken, warn)
        const logLength = numberOf(session?.seq)
        const endSeq = (logLength ?? 0) - 1
        if (logLength === undefined || logLength <= 0 || (cursorSeq !== undefined && cursorSeq >= endSeq)) {
          // Empty log, or nothing appended since the cursor: the trigger will
          // skip on the empty window and the cursor stays where it is.
          return emptySnapshot(memory, turn, session, cursorToken)
        }
        const events = await readWindow(memory.sessionId, endSeq, cursorSeq)
        const messages = normalizeMessages(events)
        const transcript = truncateTranscript(renderTranscript(messages))
        return {
          cursorToken: `seq:${endSeq}`,
          messages,
          transcript,
          memory,
          turn,
          session,
          route: readRoute(session),
        }
      } catch (error) {
        return { ...emptySnapshot(memory, turn, session), error: describeError(error) }
      }
    })()
  }

  /**
   * Page `readEvent` backwards from `endSeq` down to (but not including)
   * `cursorSeq`, newest events first in the result.
   * @returns {Promise<object[]>}
   */
  const readWindow = async (sessionId, endSeq, cursorSeq) => {
    const lowSeq = cursorSeq ?? -1
    const wanted = Math.min(endSeq - lowSeq, MAX_WINDOW_EVENTS)
    const collected = []
    let anchor = endSeq
    while (anchor > lowSeq && collected.length < wanted) {
      // The page covers [anchor - before, anchor] inclusive, so `before` is
      // one less than the number of events still wanted.
      const pageSize = Math.min(anchor - lowSeq, wanted - collected.length)
      const before = Math.min(pageSize - 1, READ_PAGE_SIZE)
      const window = await ctx.sessionQuery.readEvent({ sessionId, seq: anchor, before, after: 0 })
      const events = Array.isArray(window?.events) ? window.events : []
      if (events.length === 0) break
      collected.unshift(...events)
      const startSeq = numberOf(window.startSeq)
      if (startSeq === undefined || startSeq > anchor) break
      anchor = startSeq - 1
    }
    if (anchor > lowSeq) {
      warn(`dsh-memory: extraction window truncated at ${MAX_WINDOW_EVENTS} events; ${anchor - lowSeq} older event(s) skipped [window #${anchor + 1}-#${endSeq}, needs a limit >= ${endSeq - lowSeq + 1}]`)
    }
    return collected
  }

  /**
   * The route for the extraction call: the deployment default selection,
   * falling back to the session's last real request header
   * (`docs/probes.md` P5.1). `config.model` is applied by the caller.
   * @returns {{provider: string, model: string} | undefined}
   */
  const readRoute = (session) => {
    const selection = typeof ctx.agentDefaultModel?.currentSelection === 'function'
      ? tryCall(() => ctx.agentDefaultModel.currentSelection())
      : undefined
    const header = typeof session?.requestHeader === 'function'
      ? tryCall(() => session.requestHeader()?.config)
      : undefined
    const route = selection ?? header
    if (route === undefined || route === null) return undefined
    const provider = typeof route.provider === 'string' && route.provider.length > 0 ? route.provider : undefined
    const model = typeof route.model === 'string' && route.model.length > 0 ? route.model : undefined
    return provider === undefined || model === undefined ? undefined : { provider, model }
  }

  const scheduleExtraction = (state, turn) => {
    if (state.disposed) return
    state.lastTurn = typeof turn === 'number' ? turn : state.lastTurn
    // The scheduler is single-flight and coalesces to the latest pending
    // snapshot, so no extra debounce guard is needed here.
    state.scheduler.schedule(captureSnapshot(state, state.session, turn))
  }

  /* ------------------------------------------------------------- execute ---- */

  /**
   * The scheduler's execute step for one snapshot.
   * @param {{abortSignal: AbortSignal, snapshot: object}} input
   * @returns {Promise<'success'|'no-op'|'error'|'aborted'>}
   */
  const runExtraction = async ({ abortSignal, snapshot }, state) => {
    if (snapshot === undefined || snapshot.error !== undefined) {
      warn(`dsh-memory: extraction snapshot failed: ${snapshot?.error ?? 'no snapshot'}`)
      return 'error'
    }
    const { memory, messages } = snapshot
    if (memory === undefined) {
      warn('dsh-memory: extraction snapshot has no memory context')
      return 'error'
    }
    if (abortSignal.aborted) return 'aborted'

    // Step 1 — the trigger. No `cursor` is passed: the snapshot already
    // carries the window, sliced by `readEvent` paging in the snapshot
    // promise, so the trigger judges exactly the messages it is given (an
    // omitted cursor means "use all messages"). Handing over the old token
    // instead would hit the cursor-not-found fallback and silently
    // disable the direct-memory-write check.
    // `isMemoryTarget` must be a function: without it the direct-write check
    // silently returns false and a manual memory write stops suppressing the
    // next pass.
    const decision = evaluateExtractionTrigger(messages, {
      isMemoryTarget: (filePath) => resolveContainedMemoryFilePath({
        filePath,
        rootDir: memory.rootDir,
        workingDirectory: memory.cwd,
      }) !== undefined,
      // Both thresholds are volatile: read per pass so a value saved in the
      // Plugins page reaches the next turn instead of waiting for a remount
      // that would never come for a volatile-only edit.
      minChars: numberOr(configValue(config.minUserChars), DEFAULT_MIN_USER_CHARS),
      minCjkChars: numberOr(configValue(config.minCjkChars), DEFAULT_MIN_CJK_CHARS),
    })
    if (decision.decision === 'skip') {
      // A skip advances the cursor too.
      return 'no-op'
    }
    if (snapshot.route === undefined) {
      // No route means no request: sending would guess a provider.
      warn('dsh-memory: no provider/model route is available (ctx.agentDefaultModel and the session request header both came back empty); extraction skipped')
      return 'error'
    }

    // The width is read once per pass — one pass is one operation, so its
    // prompt and its body clamp cannot disagree mid-flight — and per pass
    // rather than at install, because it is volatile. `slim` is the only width
    // that clamps; the prompt still quotes its budget at every width.
    const width = memoryWidthPreset(configValue(config.memoryWidth))

    // Step 2 — the manifest and the recent bodies.
    let manifest
    let bodies
    try {
      manifest = await memory.store.manifest()
      // Volatile: read per pass rather than capturing it in `apply`, for the
      // same reason as the thresholds above.
      bodies = await memory.store.recentBodies(numberOr(configValue(config.recentBodiesInPrompt), DEFAULT_RECENT_BODIES_IN_PROMPT))
    } catch (error) {
      warn(`dsh-memory: extraction manifest scan failed: ${describeError(error)}`)
      return 'error'
    }
    if (abortSignal.aborted) return 'aborted'

    // Steps 3-4 — one structured model call.
    const request = await requestExtractionPlan({
      abortSignal,
      memory,
      messageCount: decision.messageCount,
      transcript: snapshot.transcript,
      manifest,
      bodies,
      route: snapshot.route,
      width,
    })
    if (request.status !== 'ok') return request.status
    const text = request.text

    if (isNothingToSave(text)) return 'no-op'

    // Step 5 — parse. The result is exactly `{plan}` or `{error: string}`.
    const parsed = parseExtractionPlan(text)
    if ('error' in parsed) {
      // The raw reply is the only evidence for why a plan did not parse, and it
      // is otherwise unrecoverable: this request carries no sessionId, so it
      // never enters a session log. Bounded, because a reply can be long.
      const head = text.trim().replace(/\s+/gu, ' ').slice(0, 400)
      warn(`dsh-memory: extraction plan could not be parsed: ${parsed.error}; reply ${text.length} chars, starts: ${head}`)
      // A reply that is not a plan carries no operations, so re-asking the
      // identical window would spend the same large request for the same
      // result. Treat it as a no-op: the cursor advances, the next window gets
      // a fresh chance, and the warning above keeps the fault visible. This
      // matches step 10, where a plan that validates to zero operations is
      // also a no-op rather than an error.
      return 'no-op'
    }

    // Step 6 — validate. `operations` keeps plan order with duplicate files
    // collapsed to the last occurrence; `rejected` entries are
    // `{index, reason}` where -1 is a top-level failure.
    const { operations, rejected } = validateExtractionPlan(parsed.plan, { memoryRoot: memory.rootDir })
    const planOperations = Array.isArray(parsed.plan?.operations) ? parsed.plan.operations : []
    for (const rejection of rejected) {
      warn(`dsh-memory: extraction operation rejected: ${describeRejection(rejection, planOperations)}`)
    }

    // Step 7 — apply. Deletes first, so a same-file write-then-delete in one
    // plan cannot resurrect the file.
    const { applied } = await applyOperations(operations, memory, warn, width)

    // Step 8 — the next injected index must see the new files.
    if (applied > 0) {
      memory.invalidateIndex()
      try {
        await memory.refreshIndex(registry.indexLimits())
      } catch (error) {
        warn(`dsh-memory: index refresh after extraction failed: ${describeError(error)}`)
      }
    }

    // Step 10 — status.
    if (operations.length === 0) return 'no-op'
    return applied > 0 ? 'success' : 'error'
  }

  /**
   * Ask the model for one JSON operation plan and collect its text.
   * @param {{abortSignal: AbortSignal, memory: import('./context.js').AgentMemoryContext, messageCount: number, transcript: string, manifest: readonly object[], bodies: readonly object[], route: {provider: string, model: string}, width: import('../src/memory-width.js').MemoryWidthPreset}} options
   * @returns {Promise<{status: 'ok', text: string} | {status: 'error'|'aborted'}>}
   */
  const requestExtractionPlan = async ({ abortSignal, memory, messageCount, transcript, manifest, bodies, route, width }) => {
    if (typeof ctx.llm?.stream !== 'function') {
      warn('dsh-memory: the llm service is unavailable; extraction skipped')
      return { status: 'error' }
    }

    const protocol = buildExtractionPrompt({ manifest, messageCount, bodies, width: width.width })
    /** @type {import('@deepseek-ai/dsh-llm').GenerateOptions} */
    const options = {
      provider: route.provider,
      // Volatile, so it is read here rather than captured in `apply`: a
      // volatile-only change is committed into the running fiber without a
      // remount, and an install-time snapshot goes stale the moment the user
      // saves a new value. The field carries no provider, so it only replaces
      // the model id; a blank value defers to the resolved route.
      model: configuredModelOf(config) ?? route.model,
      // Layer 1 (the shared data-model spec) rides in the system slot, exactly
      // like the main agent's Memory section — width included, so both halves
      // of the prompt state the same writing budget.
      system: buildMemoryContent(memory.rootDir, width.width),
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: composeUserPrompt(transcript, protocol) }],
      }],
      signal: abortSignal,
    }
    // `reasoningEffort` is deliberately omitted: an effort that does not fit
    // the resolved model makes the runtime throw UNSUPPORTED_REASONING_EFFORT
    // (`docs/probes.md` P5.1), and omitting it is the documented-safe choice.
    // `sessionId` is deliberately NOT stamped: a request carrying it makes
    // `session-checkpoint-policy` flush the session from inside the
    // `llm/stream` waterfall (`docs/probes.md` 未验证 #6), and the extraction
    // request is a consumer of the transcript, not part of it — the same
    // motivation as `skipTranscript: true`: do not record the extraction
    // request in the transcript.

    // Diagnostics only: the resolved route and the request size are captured
    // here so a terminal failure names what was actually sent. Today's
    // `PI_AI_ERROR` carried a bare `{"type":"error"}` string — the harness
    // classifier recognized no 4xx/5xx/timeout/transport pattern and fell
    // through to its catch-all, so the raw payload is the only surviving
    // evidence of which provider answered and why.
    const routeLabel = `${options.provider}/${options.model}`
    const requestChars = options.system.length
      + options.messages.reduce((total, message) => total
        + (Array.isArray(message.content)
          ? message.content.reduce((sum, part) => sum + (typeof part?.text === 'string' ? part.text.length : 0), 0)
          : 0), 0)

    let text = ''
    try {
      for await (const chunk of ctx.llm.stream(options)) {
        if (abortSignal.aborted) return { status: 'aborted' }
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          // Reasoning deltas are not answer text and must not leak into the
          // plan; no BlockAssembler — it lives in @deepseek-ai/dsh-llm, which
          // a dependency-free plugin must not import.
          text += chunk.text
          continue
        }
        if (chunk?.type === 'finish') {
          // `LlmRuntime.stream()` normalizes adapter failures into a terminal
          // finish chunk, so a throw is not the only failure shape
          // (probes.md P5.3).
          const kind = finishKind(chunk.reason)
          if (kind === 'aborted') return { status: 'aborted' }
          if (kind === 'error') {
            warn(`dsh-memory: extraction model call failed: ${describeFinish(chunk.reason)} [route ${routeLabel}, ${requestChars} chars sent, ${text.length} chars received]`)
            for (const line of describeFailureDetails(chunk.reason)) {
              warn(`dsh-memory: extraction failure detail: ${line}`)
            }
            return { status: 'error' }
          }
          if (kind === 'stop' || kind === 'max-tokens') break
          // 'tool-calls' cannot happen (no tools were sent) and an unknown
          // kind is not something to guess at.
          warn(`dsh-memory: extraction model call ended unexpectedly: ${describeFinish(chunk.reason)} [route ${routeLabel}, ${requestChars} chars sent, ${text.length} chars received]`)
          for (const line of describeFailureDetails(chunk.reason)) {
            warn(`dsh-memory: extraction failure detail: ${line}`)
          }
          return { status: 'error' }
        }
      }
    } catch (error) {
      // Synchronous LlmError: NO_ADAPTER / INVALID_CREDENTIAL / AUTH /
      // RATE_LIMIT / SERVER (probes.md P5.3).
      if (abortSignal.aborted || isAbortError(error)) return { status: 'aborted' }
      warn(`dsh-memory: extraction model call threw: ${describeError(error)} [route ${routeLabel}, ${requestChars} chars sent, ${text.length} chars received]`)
      return { status: 'error' }
    }
    if (abortSignal.aborted) return { status: 'aborted' }
    return { status: 'ok', text }
  }

  /* ---------------------------------------------------------------- hooks ---- */

  ctx.on('session/event', (session, event) => {
    // Emit mode: post-commit, fire-and-forget, dispatched synchronously
    // inside Session.append(). Never block, never throw.
    if (event?.type !== 'turn/end') return
    // Volatile: read per event rather than capturing it in `apply`. A
    // volatile-only change is committed into the running fiber without a
    // remount, so a value snapshotted at install time goes stale the moment
    // the user saves a new one in the Plugins page.
    if (configValue(config.extractionEnabled) === false) return
    // Not volatile: an ordinary field whose value cannot change without a
    // remount, so a direct read is both correct and current.
    if (config.enabled === false) return
    // A cancelled turn has no settled assistant output worth extracting.
    if (event.data?.reason?.kind === 'aborted') return
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    // Volatile, same rule as the guards above: read per event.
    if (!configValue(config.includeSubagents) && isSubagentHeader(session.header)) return
    const memory = registry.get(sessionId)
    if (memory === undefined) return
    // Session warm-up gate (`extractionMinTurns` / `extractionMinSteps`): an
    // early session is exploration and clarification, and each qualifying turn
    // buys a model call. While the gate holds, nothing is scheduled and the
    // cursor does not move, so the first eligible pass still sees the session
    // (up to the log-window cap) instead of losing its beginning.
    if (!warmupGatePassed(ctx, session, config)) return
    try {
      const state = ensureSession(sessionId, memory)
      state.session = session
      const turn = numberOf(event.data?.turn) ?? state.lastTurn
      if (debounceMs <= 0 || typeof ctx.timer?.timeout !== 'function') {
        scheduleExtraction(state, turn)
        return
      }
      // Debounce: a steered or immediately-followed turn replaces the pending
      // schedule instead of queueing a second snapshot.
      clearPendingTimer(state)
      state.pendingTimer = ctx.timer.timeout(() => {
        state.pendingTimer = undefined
        scheduleExtraction(state, turn)
      }, debounceMs)
    } catch (error) {
      warn(`dsh-memory: extraction scheduling failed: ${describeError(error)}`)
    }
  })

  ctx.on('session/flush', async (session) => {
    // A rejecting listener makes SessionStore.flush throw, and the checkpoint
    // policy is fail-closed — it would stop dispatching models and tools
    // (probes.md P4.2). Contain everything.
    try {
      // Re-entrancy: our own execute step flushes for durability, and that
      // flush lands back here. Answering it would deadlock the drain against
      // the execute that is waiting for this very flush.
      if (flushing) return
      const sessionId = session?.id
      if (typeof sessionId !== 'string') return
      const state = sessions.get(sessionId)
      if (state === undefined || state.disposed) return
      // A still-pending debounce timer would otherwise lose this turn's
      // boundary: flush the schedule first, then drain.
      if (state.pendingTimer !== undefined) {
        clearPendingTimer(state)
        scheduleExtraction(state, state.lastTurn)
      }
      let timeout
      try {
        await Promise.race([
          state.scheduler.drain(),
          new Promise((resolve) => {
            timeout = setTimeout(resolve, drainTimeoutMs)
            timeout.unref?.()
          }),
        ])
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    } catch (error) {
      warn(`dsh-memory: extraction drain failed: ${describeError(error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') return
    const state = sessions.get(sessionId)
    if (state === undefined) return
    sessions.delete(sessionId)
    disposeState(state)
  })

  ctx.effect(() => async () => {
    for (const state of sessions.values()) disposeState(state)
    sessions.clear()
  }, 'dsh-memory: memory extraction')
}

/* ------------------------------------------------------------- operations ---- */

/**
 * Apply one validated plan: deletes first, then writes/edits. A single
 * failing operation warns and continues; only an all-failed plan reports
 * `'error'`.
 *
 * Fields are read straight off the confirmed contract
 * (`{op, file, title?, hook?, frontmatter?, body?}`) with no fallback names:
 * a renamed field must fail loudly here, not silently skip every operation.
 * `validateExtractionPlan` strips `delete` down to `{op, file}`, so the
 * required-field check inside {@link writeEntryOf} is only ever reached for
 * `write` / `edit` — checking it for deletes would drop every deletion.
 *
 * The width preset is the enforcement half of the `slim` dial: the prompt asks
 * for short bodies, and {@link clampMemoryBody} guarantees them, trimming at a
 * line boundary and naming the cut in the file itself. `extended` and
 * `balanced` carry no budget, so their bodies are written verbatim.
 *
 * @param {readonly {op: string, file: string}[]} operations
 * @param {import('./context.js').AgentMemoryContext} memory
 * @param {(message: string) => void} warn
 * @param {import('../src/memory-width.js').MemoryWidthPreset} width
 * @returns {Promise<{applied: number, failed: number}>}
 */
async function applyOperations(operations, memory, warn, width) {
  let applied = 0
  let failed = 0
  const deletes = operations.filter((operation) => operation.op === 'delete')
  const writes = operations.filter((operation) => operation.op !== 'delete')
  for (const operation of [...deletes, ...writes]) {
    try {
      if (operation.op === 'delete') {
        await memory.store.deleteMemory(operation.file)
        applied += 1
        continue
      }
      const entry = writeEntryOf(operation)
      if (entry === undefined) {
        // A write/edit the validator let through without its required fields
        // would render a corrupt memory file; skipping is the loud failure.
        failed += 1
        warn(`dsh-memory: extraction operation skipped (${operation.op} ${operation.file}): missing write fields`)
        continue
      }
      const clamped = clampMemoryBody(entry.body, width)
      if (clamped.trimmed) {
        // The transcript is the only other copy of what was dropped, and the
        // cursor is about to move past it, so the trim is logged with the file
        // it touched rather than left to be discovered later.
        warn(`dsh-memory: ${operation.file} body trimmed to the ${width.width} width budget of ${width.bodyCharLimit} characters`)
        entry.body = clamped.body
      }
      await memory.store.writeMemory(entry)
      applied += 1
    } catch (error) {
      failed += 1
      warn(`dsh-memory: extraction operation skipped (${operation.op} ${operation.file}): ${describeError(error)}`)
    }
  }
  return { applied, failed }
}

/* ------------------------------------------------------------------ misc ---- */

/**
 * The configured model override, or `undefined` when the field is blank. The
 * field carries no provider, so it only replaces the model id of the resolved
 * route. Volatile, so it is read per call — see {@link configValue}.
 * @param {Record<string, unknown>} config
 * @returns {string | undefined}
 */
function configuredModelOf(config) {
  const model = configValue(config?.model)
  return typeof model === 'string' && model.trim().length > 0 ? model.trim() : undefined
}

/**
 * @param {string} transcript
 * @returns {string}
 */
function truncateTranscript(transcript) {
  if (typeof transcript !== 'string') return ''
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript
  // Keep the tail: the newest messages are the ones worth extracting.
  return `[... earlier messages omitted — ${transcript.length - MAX_TRANSCRIPT_CHARS} characters ...]\n\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`
}

/**
 * @param {string} transcript
 * @param {string} protocol
 * @returns {string}
 */
function composeUserPrompt(transcript, protocol) {
  return [
    '## Conversation since the last extraction',
    '',
    transcript,
    '',
    '---',
    '',
    protocol,
  ].join('\n')
}

/**
 * @param {unknown} token
 * @returns {string | undefined}
 */
function normalizeCursorToken(token) {
  return typeof token === 'string' && token.length > 0 ? token : undefined
}

/**
 * Parse a `'seq:<n>'` cursor token into its log position.
 * @param {string | undefined} token
 * @param {(message: string) => void} warn
 * @returns {number | undefined} the seq, or undefined for "no usable cursor".
 */
function cursorSeqOf(token, warn) {
  if (token === undefined) return undefined
  const match = CURSOR_TOKEN_RE.exec(token)
  if (match === null) {
    warn(`dsh-memory: unreadable extraction cursor ${JSON.stringify(token)}; rescanning from the newest events`)
    return undefined
  }
  return Number(match[1])
}

/**
 * The snapshot used when there is nothing to read. The trigger skips on the
 * empty window and the cursor is rewritten unchanged.
 * @param {import('./context.js').AgentMemoryContext} memory
 * @param {number} turn
 * @param {object | undefined} session
 * @param {string | undefined} [cursorToken]
 * @returns {object}
 */
function emptySnapshot(memory, turn, session, cursorToken) {
  return {
    cursorToken: cursorToken ?? '',
    messages: [],
    transcript: '',
    memory,
    turn,
    session,
    route: undefined,
  }
}

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
 * @returns {boolean}
 */
function isAbortError(error) {
  return error !== null && typeof error === 'object' && error.name === 'AbortError'
}

/**
 * FinishReason is merge-extensible and object-shaped (`{kind: 'stop'}`), but a
 * simplified string form is tolerated too.
 * @param {unknown} reason
 * @returns {string | undefined}
 */
function finishKind(reason) {
  if (typeof reason === 'string') return reason
  if (reason !== null && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

/**
 * A one-line render of a finish reason. `failure` is always an object with a
 * `code` and a `message` on a harness-built reason, but a provider may deliver
 * its raw error body verbatim as the message — today's was the literal string
 * `{"type":"error"}` — so the message is never second-guessed or replaced.
 * @param {unknown} reason
 * @returns {string}
 */
function describeFinish(reason) {
  if (typeof reason === 'string') return reason
  if (reason === null || typeof reason !== 'object') return 'unknown finish reason'
  const failure = reason.failure
  const code = typeof failure?.code === 'string' ? failure.code : undefined
  const message = typeof failure?.message === 'string' ? failure.message.trim() : undefined
  // `PI_AI_ERROR: {"type":"error"}` reads as code + payload. A payload that
  // merely repeats the code adds nothing, so it is dropped rather than printed
  // twice.
  if (message === undefined || message.length === 0 || message === code) {
    return code ?? 'unknown finish reason'
  }
  return code === undefined ? message : `${code}: ${message}`
}

/**
 * Every recoverable field of a terminal failure, one string per line, for the
 * `extraction failure detail:` warning. `describeFinish` only names the shape;
 * when the payload is an opaque one-key object like `{"type":"error"}` even
 * that is thin, so the remaining keys of `failure` are surfaced too. Nothing is
 * truncated: this fires once per failed pass, not once per event.
 * @param {unknown} reason
 * @returns {string[]}
 */
function describeFailureDetails(reason) {
  if (reason === null || typeof reason !== 'object') return []
  const failure = reason.failure
  if (failure === null || typeof failure !== 'object') return []
  const details = []
  const kind = typeof reason.kind === 'string' ? reason.kind : undefined
  if (kind !== undefined) details.push(`kind=${kind}`)
  for (const [key, value] of Object.entries(failure)) {
    if (typeof value === 'string') {
      details.push(`${key}=${JSON.stringify(value)}`)
      continue
    }
    if (value === undefined) continue
    // `code`/`message` are already rendered by `describeFinish`; everything
    // else is diagnostic gold when the message itself is uninformative.
    let rendered
    try {
      rendered = JSON.stringify(value)
    } catch {
      rendered = String(value)
    }
    details.push(`${key}=${rendered ?? String(value)}`)
  }
  return details
}

/**
 * The `writeMemory` entry for a write/edit operation, or undefined when the
 * plan is missing a required field (writing a half-rendered memory file would
 * be worse than skipping the operation). Only ever called for `write`/`edit`:
 * `validateExtractionPlan` strips `delete` down to `{op, file}`.
 * @param {{op: string, file: string, title?: string, hook?: string,
 *   frontmatter?: {name: string, description: string, type: string}, body?: string}} operation
 * @returns {{file: string, title: string, hook: string, frontmatter: {name: string, description: string, type: string}, body: string} | undefined}
 */
function writeEntryOf(operation) {
  const entry = {
    file: operation.file,
    title: operation.title,
    hook: operation.hook,
    frontmatter: operation.frontmatter,
    body: operation.body,
  }
  const ok = typeof entry.title === 'string'
    && typeof entry.hook === 'string'
    && typeof entry.body === 'string'
    && typeof entry.frontmatter?.name === 'string'
    && typeof entry.frontmatter?.description === 'string'
    && typeof entry.frontmatter?.type === 'string'
  return ok ? entry : undefined
}

/**
 * An empty plan is the protocol's legal "nothing worth saving" signal
 * (`src/memory-prompt.js`: reply `{"operations":[]}`), so it is a successful
 * no-op that advances the cursor — not a write pass. The older
 * "Nothing to save." phrasing is tolerated for the same reason.
 * @param {unknown} text
 * @returns {boolean}
 */
function isNothingToSave(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  return trimmed.length === 0 || EMPTY_PLAN_RE.test(trimmed) || NOTHING_TO_SAVE_RE.test(trimmed)
}

/**
 * One rejected operation, named by its plan index. `index === -1` is a
 * top-level failure with no operation behind it.
 * @param {{index: number, reason: string}} rejection
 * @param {readonly unknown[]} planOperations
 * @returns {string}
 */
function describeRejection(rejection, planOperations) {
  const index = rejection.index
  const reason = rejection.reason
  if (index === -1) return `top-level: ${String(reason)}`
  const raw = planOperations?.[index]
  const file = raw !== null && typeof raw === 'object' ? raw.file : undefined
  const label = typeof file === 'string' ? `#${String(index)} ${file}` : `#${String(index)}`
  // `invalid-type` is the one rejection whose cause is entirely in the value the
  // model invented, and the value is otherwise unrecoverable — this request
  // never reaches a session log. Quote it so the next occurrence names itself.
  if (reason === 'invalid-type' && raw !== null && typeof raw === 'object') {
    const type = raw.frontmatter !== null && typeof raw.frontmatter === 'object'
      ? raw.frontmatter.type
      : undefined
    return `${label}: ${String(reason)} (received ${JSON.stringify(type) ?? String(type)})`
  }
  return `${label}: ${String(reason)}`
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function numberOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Whether the session has run long enough for an extraction pass to be worth a
 * model call — the `extractionMinTurns` / `extractionMinSteps` gate.
 *
 * The counts come from the `sessionStats` projection, read through `ctx.get`
 * rather than through `inject`, so the plugin keeps working on a profile that
 * does not mount it: a missing service, a missing unit or an unusable state
 * PASSES the gate and extraction behaves exactly as it did before. Failing
 * closed here would turn "no projection mounted" into "memory silently stops",
 * which is the one outcome worse than an early extraction.
 *
 * The read prefers `snapshot(session, ['sessionStats'])` — the supported
 * client-view face, `{ asOfSeq, values }`
 * (`dsh-session-projection/README.md:61-64`) — whose `values` is a PARTIAL map,
 * so an unregistered key is absent rather than `undefined`-valued. The value it
 * yields is the projection's wire view, a strict subset of the fold state with
 * all eight totals including `turns` / `steps`
 * (`dsh-session-stats/README.md:79`, `lib/types/projection.js:154-162`).
 * `stateOf` stays underneath as the fallback for an older registry, but it is
 * `@deprecated` and the registry logs one warning per key on first use, so
 * putting it first would log that warning on every profile that mounts the
 * projection.
 *
 * A throw anywhere in the read is contained the same way — this runs inside the
 * synchronous `session/event` dispatch, where nothing may throw.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{}} session
 * @param {Record<string, unknown>} config
 * @returns {boolean}
 */
function warmupGatePassed(ctx, session, config) {
  const stats = readSessionStats(ctx, session)
  if (stats === undefined) return true
  return meetsSessionMinimums(
    { turns: numberOf(stats.turns), steps: numberOf(stats.steps) },
    {
      // Volatile: read per event, like every other extraction setting.
      minTurns: numberOr(configValue(config.extractionMinTurns), DEFAULT_MIN_SESSION_TURNS),
      minSteps: numberOr(configValue(config.extractionMinSteps), DEFAULT_MIN_SESSION_STEPS),
    },
  )
}

/**
 * The `sessionStats` value the warm-up gate counts, from the first read face
 * that can answer: `snapshot` (complete, non-deprecated), then `stateOf`
 * (deprecated, kept for an older registry), then nothing — and nothing means
 * "pass the gate", never "hold it".
 *
 * Both reads are contained: this runs on the synchronous `session/event`
 * dispatch path, so a registry that throws (unusable session, disposed unit,
 * stale projection) must degrade to "no stats" rather than escape into the
 * event loop.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{}} session
 * @returns {{turns?: unknown, steps?: unknown} | undefined}
 */
function readSessionStats(ctx, session) {
  const projections = tryCall(() => ctx.get('sessionProjections'))
  if (projections === null || typeof projections !== 'object') return undefined

  if (typeof projections.snapshot === 'function') {
    const snapshot = tryCall(() => projections.snapshot(session, ['sessionStats']))
    const values = snapshot !== null && typeof snapshot === 'object' ? snapshot.values : undefined
    const stats = values !== null && typeof values === 'object' ? values.sessionStats : undefined
    // A snapshot that answers with a usable value wins; a partial `values` (key
    // not registered, or the projection not mounted) falls through to `stateOf`
    // so an older registry and a newer one agree on the gate.
    if (stats !== null && typeof stats === 'object') return stats
  }

  if (typeof projections.stateOf !== 'function') return undefined
  const stats = tryCall(() => projections.stateOf(session, 'sessionStats'))
  return stats !== null && typeof stats === 'object' ? stats : undefined
}

/**
 * A subagent session, per the two documented `SessionHeader` signals
 * (`origin` / `delegationDepth`) — the same test `workspace-changes` applies.
 * @param {unknown} header
 * @returns {boolean}
 */
function isSubagentHeader(header) {
  if (header === null || typeof header !== 'object') return false
  return header.origin === 'subagent'
    || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

/**
 * @param {string} message
 */
function fallbackWarn(message) {
  try {
    console.warn(message)
  } catch {
    /* a console-less runtime must not break an operation apply */
  }
}

/**
 * @param {unknown} logger
 * @returns {(message: string) => void}
 */
function createWarner(logger) {
  if (logger !== null && typeof logger === 'object' && typeof logger.warn === 'function') {
    return (message) => logger.warn(message)
  }
  return fallbackWarn
}
