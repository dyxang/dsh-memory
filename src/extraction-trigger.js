/**
 * The extraction trigger: the "should an extraction pass run at all?"
 * predicates over a window of normalized messages.
 *
 * The predicates: `evaluateMemoryExtraction`, `containsDirectMemoryWrite`,
 * `containsEligibleUserProse`, `messagesAfterFoundCursor`,
 * `isNonMetaUserMessage`, and `isMemoryMutationToolPart`.
 *
 * The input is a normalized message, not a rich `MessageWithParts` model — the
 * host adapter (`src/extraction-source.js`) produces it:
 *
 *     { id: string, role: 'user'|'assistant', text?: string, sourceKind?: string,
 *       toolName?: string, toolInput?: Record<string, unknown> }
 *
 * `sourceKind` is required on user messages and carries `event.data.source.kind`.
 * DSH has no `synthetic` / `visibility` / `ignored` fields: dsh-probes found the
 * official criterion for a synthesized message is `source.kind !== 'user'`
 * (`packages/core/session/src/types.ts:302-309`, mirrored by the official
 * `session-turn-outline` projection and `session-title`). That single test
 * stands in for a `synthetic !== true && visibility !== 'model-only'` pair, and
 * it is what keeps injected user messages — the skill catalog, other plugins'
 * context injections — out of "real user prose".
 *
 * Design notes:
 *
 * 1. **CJK-aware eligibility (design decision D3).** A plain
 *    `countWords(text) >= MINIMUM_USER_WORDS` (whitespace word count) can never
 *    be reached by a short Chinese sentence — it is a single "word". This
 *    module uses a dual threshold instead: the whitespace-stripped
 *    code-point count >= `minChars` OR the CJK code-point count >=
 *    `minCjkChars`.
 * 2. **Code points, not UTF-16 units.** Character counting uses
 *    `Array.from` / `for…of`, so surrogate pairs (emoji) count once.
 * 3. **The memory-target predicate is injected.** This module never touches
 *    the filesystem: the host supplies `isMemoryTarget(filePath)`.
 * 4. **Cursor matching takes the LAST id match, not the first.** A `findIndex`
 *    would take the first. The normalized stream produced by
 *    `src/extraction-source.js` gives every message expanded from one event
 *    the same event-level id, so the first match can sit in the middle of the
 *    boundary event and leave that event's later parts — including its
 *    `Write` call — inside the window forever, making every subsequent round
 *    report `direct-memory-write`. With unique ids (any host that mints
 *    per-message ids) last-match and first-match are identical.
 * 5. **The meta-user criterion is `sourceKind === 'user'`.** A normalized
 *    message carries no `synthetic` / `visibility` fields.
 *    `sourceKind !== 'user'` is the single official test for a synthesized user
 *    message, and because injected context arrives as a non-user source it also
 *    covers the model-only case — both conditions collapse into this one
 *    check. A user message with no `sourceKind` at all is malformed input
 *    and is excluded rather than trusted.
 * 6. **Tool names are compared case-insensitively.** DSH registers the write
 *    tools under lower-case names (`write` / `edit` — `Tool.listTools` returns
 *    `read` / `write` / `edit` / `glob` / `grep` / `bash`) and the normalized
 *    `toolName` is the event's own `name`. Comparing an exact `Write` / `Edit`
 *    spelling would leave `containsDirectMemoryWrite` permanently false on DSH,
 *    so a manual memory write would no longer suppress the next extraction pass
 *    and the pass could duplicate files the user just wrote. Both spellings
 *    match.
 *
 * Division of labour agreed with `src/extraction-source.js`: this module owns
 * every *policy* (which tools count, what a real user utterance is) and
 * exports the single-text predicate {@link isEligibleUserText} for the source
 * module to reuse; the source module owns the *mechanism* (event stream
 * normalization and transcript rendering).
 *
 * @module dsh-memory/extraction-trigger
 */

/** Default minimum whitespace-stripped code points for eligible user prose. */
export const DEFAULT_MIN_USER_CHARS = 12

/** Default minimum CJK code points for eligible user prose. */
export const DEFAULT_MIN_CJK_CHARS = 3

/**
 * Default closed turns a session needs before extraction starts. A session
 * that has not gone anywhere yet cannot have produced much worth remembering,
 * and every qualifying turn buys a model call.
 */
export const DEFAULT_MIN_SESSION_TURNS = 5

/** Default closed steps a session needs before extraction starts. */
export const DEFAULT_MIN_SESSION_STEPS = 40

/**
 * The tools that can mutate a memory file, compared case-insensitively.
 *
 * An event stream may spell them `Write` / `Edit`, but DSH registers the same
 * tools under lower-case names — `Tool.listTools` returns
 * `read` / `write` / `edit` / `glob` / `grep` / `bash` — and the
 * normalized `toolName` comes straight from the event's `name`. The set is
 * therefore stored lower-cased and every comparison normalizes first, so both
 * spellings match (see design note 6 in the module header).
 */
const MEMORY_MUTATION_TOOLS = new Set(['write', 'edit'])

/**
 * CJK code points: Hiragana/Katakana (`\u3040-\u30ff`), CJK Extension A
 * (`\u3400-\u4dbf`), CJK Unified Ideographs (`\u4e00-\u9fff`) and Hangul
 * syllables (`\uac00-\ud7af`). Deliberately a character class, not `\w` or a
 * locale-dependent matcher: the threshold only has to separate "a real
 * sentence in a language that does not space-separate words" from noise.
 */
const CJK_CHARACTER_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u

/**
 * How many messages sit strictly after the cursor message: an absent cursor,
 * or a cursor that is not in the window any more, counts the whole window.
 * Cursor matching takes the LAST matching id — see design note 4 in the module
 * header.
 * @param {readonly any[]} messages
 * @param {string | undefined} cursor
 * @returns {number}
 */
export function countMessagesAfterCursor(messages, cursor) {
  if (!cursor) return messages.length
  const cursorIndex = lastIndexWithId(messages, cursor)
  return cursorIndex < 0 ? messages.length : messages.length - cursorIndex - 1
}

/**
 * The window strictly after the cursor, or `undefined` when the cursor is not
 * found. Note the asymmetry with {@link countMessagesAfterCursor}: a stale
 * cursor means "unknown window" here
 * (callers decide whether to fall back to everything or to nothing).
 *
 * The last matching id wins (design note 4): one normalized event can expand
 * into several messages that share its id, and the whole boundary event must
 * stay outside the window.
 * @param {readonly any[]} messages
 * @param {string | undefined} cursor
 * @returns {readonly any[] | undefined}
 */
function messagesAfterFoundCursor(messages, cursor) {
  if (!cursor) return messages
  const cursorIndex = lastIndexWithId(messages, cursor)
  return cursorIndex < 0 ? undefined : messages.slice(cursorIndex + 1)
}

/**
 * Index of the last message whose id equals `cursor`, or -1.
 * @param {readonly any[]} messages
 * @param {string} cursor
 * @returns {number}
 */
function lastIndexWithId(messages, cursor) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.id === cursor) return index
  }
  return -1
}

/**
 * Whether an assistant in the window already wrote into the memory directory
 * directly, in which case an extraction pass would duplicate that work. Three
 * details: `file_path` is read from the normalized `toolInput.file_path`, the
 * path predicate is injected, and the tool name is compared case-insensitively
 * (design note 6).
 * @param {readonly any[]} messages
 * @param {{cursor?: string, isMemoryTarget?: (filePath: string) => boolean}} [options]
 * @returns {boolean}
 */
export function containsDirectMemoryWrite(messages, options = {}) {
  const { cursor, isMemoryTarget } = options
  const window = messagesAfterFoundCursor(messages, cursor)
  // A stale cursor returns false — the window is unknown, so the host must
  // not suppress extraction on a guess.
  if (window === undefined) return false
  if (typeof isMemoryTarget !== 'function') return false

  for (const message of window) {
    if (message?.role !== 'assistant') continue
    // Normalize case: DSH emits `write`/`edit`, an event stream may spell
    // them `Write`/`Edit`. Comparing an exact spelling would make this
    // predicate permanently false on DSH.
    const toolName = typeof message.toolName === 'string' ? message.toolName.toLowerCase() : ''
    if (!MEMORY_MUTATION_TOOLS.has(toolName)) continue
    const filePath = message.toolInput?.file_path
    if (typeof filePath !== 'string' || filePath.length === 0) continue
    if (isMemoryTarget(filePath)) return true
  }

  return false
}

/**
 * Whether the window holds at least one real user utterance worth extracting
 * from. Two details: the `countWords >= MINIMUM_USER_WORDS` part test became
 * the dual character threshold of design decision D3, and a per-part `ignored`
 * flag has no DSH equivalent (the admission gate is
 * {@link isNonMetaUserMessage} alone).
 * @param {readonly any[]} messages
 * @param {{cursor?: string, minChars?: number, minCjkChars?: number}} [options]
 * @returns {boolean}
 */
export function containsEligibleUserProse(messages, options = {}) {
  const {
    cursor,
    minChars = DEFAULT_MIN_USER_CHARS,
    minCjkChars = DEFAULT_MIN_CJK_CHARS,
  } = options
  // A stale cursor falls back to the whole window here (opposite of
  // containsDirectMemoryWrite) — extraction stays possible.
  const window = messagesAfterFoundCursor(messages, cursor) ?? messages

  for (const message of window) {
    if (!isNonMetaUserMessage(message)) continue
    if (isEligibleUserText(message.text, { minChars, minCjkChars })) return true
  }
  return false
}

/**
 * `isNonMetaUserMessage`: a real user message, not a synthesized injection.
 * A `synthetic !== true && visibility !== 'model-only'` pair would express
 * this over a richer model, but DSH's normalized message has neither field,
 * and `sourceKind === 'user'` is the official criterion for a genuine user
 * message (see the module header).
 *
 * This is the ONLY definition of the "real user message" admission criterion —
 * `extraction-source.js` imports it instead of keeping its own copy, so the
 * two modules cannot drift apart (策略归 trigger、机制归 source).
 * @param {any} message
 * @returns {boolean}
 */
export function isNonMetaUserMessage(message) {
  // Optional chaining: the host feeds normalized messages, but a malformed
  // entry must be skipped, not thrown — a throw inside the scheduler's execute
  // is swallowed as an error and stalls the cursor.
  return message?.role === 'user' && message.sourceKind === 'user'
}

/**
 * The single-text eligibility predicate — the D3 dual threshold, and the only
 * place it is defined. `src/extraction-source.js` imports this instead of
 * keeping its own copy, so this module stays the single source of truth for
 * "is this user text worth extracting from" (策略归 trigger、机制归 source).
 *
 * Either threshold alone qualifies: enough characters after removing
 * whitespace, OR enough CJK characters.
 *
 * This predicate is TEXT-ONLY: it never looks at `role` or `sourceKind`. The
 * admission gate — `role === 'user' && sourceKind === 'user'` — lives in
 * {@link isNonMetaUserMessage} and therefore in
 * {@link containsEligibleUserProse}; callers that hold a bare text (the
 * extraction prompt builder, the source module's prose collector) apply that
 * gate themselves.
 * @param {unknown} text
 * @param {{minChars?: number, minCjkChars?: number}} [options] overrides for the
 *   two thresholds; both default to {@link DEFAULT_MIN_USER_CHARS} /
 *   {@link DEFAULT_MIN_CJK_CHARS}.
 * @returns {boolean}
 */
export function isEligibleUserText(text, options = {}) {
  const {
    minChars = DEFAULT_MIN_USER_CHARS,
    minCjkChars = DEFAULT_MIN_CJK_CHARS,
  } = options
  if (typeof text !== 'string') return false
  const compact = text.replace(/\s+/gu, '')
  // Array.from counts code points, so an emoji (surrogate pair) is 1, not 2.
  if (Array.from(compact).length >= minChars) return true
  return countCjkCharacters(text) >= minCjkChars
}

/**
 * CJK code points in `text`. `for…of` iterates code points, so the count is
 * stable for text containing surrogate pairs.
 * @param {string} text
 * @returns {number}
 */
function countCjkCharacters(text) {
  let count = 0
  for (const character of text) {
    if (CJK_CHARACTER_RE.test(character)) count += 1
  }
  return count
}

/**
 * The session warm-up gate: extraction is worth a model call only once the
 * session has actually gone somewhere.
 *
 * The counts are the `sessionStats` projection's own figures — one turn per
 * turn that closed its first step, one closed step per step — which is exactly
 * the `{turns} 轮 {steps} 步` the session-stats panel shows, so the threshold an
 * operator types matches the number they can read there.
 *
 * A missing count reads as 0, so the gate HOLDS: the caller must decide what an
 * absent *service* means (it passes the gate — see `warmupGatePassed` in
 * `host/extract.js`), because defaulting to "no stats, no extraction" would
 * silently switch the feature off on a profile that does not mount the
 * projection.
 *
 * Setting both minimums to 0 disables the gate entirely.
 *
 * @param {{turns?: unknown, steps?: unknown}} [counts]
 * @param {{minTurns?: unknown, minSteps?: unknown}} [minimums]
 * @returns {boolean}
 */
export function meetsSessionMinimums(counts = {}, minimums = {}) {
  const requiredTurns = nonNegativeOr(minimums.minTurns, DEFAULT_MIN_SESSION_TURNS)
  const requiredSteps = nonNegativeOr(minimums.minSteps, DEFAULT_MIN_SESSION_STEPS)
  return countOrZero(counts.turns) >= requiredTurns && countOrZero(counts.steps) >= requiredSteps
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function nonNegativeOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function countOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * The trigger decision. Direct memory writes are checked first, so a window
 * that both wrote memory and contains user prose reports `direct-memory-write`.
 * @param {readonly any[]} messages the window (or the full list plus a cursor)
 * @param {{
 *   cursor?: string,
 *   isMemoryTarget?: (filePath: string) => boolean,
 *   minChars?: number,
 *   minCjkChars?: number,
 * }} [options]
 * @returns {{decision: 'run', messageCount: number}
 *   | {decision: 'skip', messageCount: number,
 *      reason: 'direct-memory-write' | 'no-user-prose'}}
 */
export function evaluateExtractionTrigger(messages, options = {}) {
  const {
    cursor,
    isMemoryTarget,
    minChars = DEFAULT_MIN_USER_CHARS,
    minCjkChars = DEFAULT_MIN_CJK_CHARS,
  } = options

  const messageCount = countMessagesAfterCursor(messages, cursor)

  if (containsDirectMemoryWrite(messages, { cursor, isMemoryTarget })) {
    return { decision: 'skip', messageCount, reason: 'direct-memory-write' }
  }

  if (!containsEligibleUserProse(messages, { cursor, minChars, minCjkChars })) {
    return { decision: 'skip', messageCount, reason: 'no-user-prose' }
  }

  return { decision: 'run', messageCount }
}
