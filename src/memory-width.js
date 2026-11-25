/**
 * Memory width: how much room one memory gets.
 *
 * The problem this dial answers: a project worked on for a long time
 * accumulates memories about whatever was obsessed over most recently, and
 * each pass over the same topic makes the files longer. Width is the single
 * setting that bounds that growth — it decides how long a body may be, how
 * freely a topic may split into files, and (while the index budgets are left
 * at their defaults) how much index is injected.
 *
 * Three levels, all optional; the middle one is the status quo:
 *
 *  - `extended` — long bodies welcome, a topic may split into several files,
 *    a larger index budget and a larger always-on budget. For projects where
 *    the detail is the point.
 *  - `balanced` — today's behaviour, unchanged. No body cap, today's index
 *    budgets. The default, so an existing deployment changes nothing.
 *  - `slim` — a hard body cap, a consolidation preference (fold into an
 *    existing file rather than opening a new one), a tighter index budget and
 *    the smallest always-on budget.
 *
 * Pure module: no I/O, no configuration reads. Callers resolve the configured
 * value through {@link resolveMemoryWidth}, which never throws on an unknown
 * value — the schema already rejects one, and a stale patched value must
 * degrade to the default rather than crash a prompt build.
 *
 * @module dsh-memory/width
 */

/** The three widths, narrowest last. */
export const MEMORY_WIDTHS = ['extended', 'balanced', 'slim']

/** The width a deployment gets when nothing says otherwise: today's behaviour. */
export const DEFAULT_MEMORY_WIDTH = 'balanced'

/**
 * The schema defaults of the two index budgets. A config value still sitting
 * on its default is treated as "not customized" and follows the width preset;
 * any other value is the user's and wins (see `indexLimits` in
 * `host/context.js`). Kept here so the preset table and the registry cannot
 * drift apart.
 */
export const INDEX_LINE_LIMIT_DEFAULT = 200
export const INDEX_CHAR_LIMIT_DEFAULT = 25_000

/**
 * One width's budget.
 *
 * `bodyCharLimit` is `null` for "no cap"; a number is enforced by
 * {@link clampMemoryBody} on every extraction write, so slim is a guarantee
 * rather than a suggestion. `indexLineLimit` / `indexCharLimit` are the index
 * budgets a default-configured deployment gets at this width.
 *
 * `alwaysOnLineLimit` / `alwaysOnCharLimit` are the other attention budget: how
 * much of the always-on layer (`user` + `feedback`, injected as text on every
 * turn; see `src/memory-layers.js`) one deployment may carry before the prompt
 * starts telling the model to merge or delete. They are deliberately not
 * separate config keys — "how much room memory gets" is one decision, and the
 * width dial is where it is made.
 *
 * @typedef {object} MemoryWidthPreset
 * @property {'extended'|'balanced'|'slim'} width
 * @property {number | null} bodyCharLimit
 * @property {number} indexLineLimit
 * @property {number} indexCharLimit
 * @property {number} alwaysOnLineLimit
 * @property {number} alwaysOnCharLimit
 */

/** @type {Readonly<Record<'extended'|'balanced'|'slim', MemoryWidthPreset>>} */
const PRESETS = {
  extended: {
    width: 'extended',
    bodyCharLimit: null,
    indexLineLimit: 400,
    indexCharLimit: 50_000,
    alwaysOnLineLimit: 20,
    alwaysOnCharLimit: 1_600,
  },
  balanced: {
    width: 'balanced',
    bodyCharLimit: null,
    indexLineLimit: INDEX_LINE_LIMIT_DEFAULT,
    indexCharLimit: INDEX_CHAR_LIMIT_DEFAULT,
    alwaysOnLineLimit: 10,
    alwaysOnCharLimit: 800,
  },
  slim: {
    width: 'slim',
    // ~12 lines of prose: enough for one fact plus a single Why line, short
    // enough that a body cannot quietly become an essay.
    bodyCharLimit: 800,
    indexLineLimit: 100,
    indexCharLimit: 12_000,
    alwaysOnLineLimit: 10,
    alwaysOnCharLimit: 800,
  },
}

/**
 * @param {unknown} value
 * @returns {boolean} whether the value is one of the three widths.
 */
export function isMemoryWidth(value) {
  return typeof value === 'string' && Object.hasOwn(PRESETS, value)
}

/**
 * The configured width, or {@link DEFAULT_MEMORY_WIDTH} for anything else
 * (undefined, a stale patched value, a typo the schema somehow let through).
 * @param {unknown} value
 * @returns {'extended'|'balanced'|'slim'}
 */
export function resolveMemoryWidth(value) {
  return isMemoryWidth(value) ? value : DEFAULT_MEMORY_WIDTH
}

/**
 * The preset for a width value. Tolerant by design: an unknown value yields
 * the balanced preset, so one bad config value can never widen or narrow a
 * deployment's budgets by surprise.
 * @param {unknown} value
 * @returns {MemoryWidthPreset}
 */
export function memoryWidthPreset(value) {
  return PRESETS[resolveMemoryWidth(value)]
}

/**
 * Enforce one preset's body budget.
 *
 * Trims at the last line boundary that keeps the body under the limit — a
 * mid-sentence cut would leave a dangling half-thought — and appends a
 * markdown comment naming the cut, so a trimmed memory says so instead of
 * silently pretending to be complete. Measured in code points, not UTF-16
 * units, so a CJK body is budgeted the way it reads (the same rule
 * `plan-validate.js` applies to the hook).
 *
 * A `null` limit (extended, balanced) returns the body untouched.
 *
 * @param {unknown} body
 * @param {MemoryWidthPreset} preset
 * @returns {{body: string, trimmed: boolean}}
 */
export function clampMemoryBody(body, preset) {
  const text = typeof body === 'string' ? body : ''
  const limit = preset?.bodyCharLimit
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return { body: text, trimmed: false }
  }
  const codePoints = Array.from(text)
  if (codePoints.length <= limit) return { body: text, trimmed: false }

  // Keep whole lines while at least half the budget is still used, so a body
  // of one huge paragraph degrades to a hard cut rather than to nothing.
  const slice = codePoints.slice(0, limit).join('')
  const lastBreak = slice.lastIndexOf('\n')
  const kept = (lastBreak > limit * 0.5 ? slice.slice(0, lastBreak) : slice).replace(/\s+$/u, '')
  return {
    body: `${kept}\n\n<!-- trimmed: body exceeded the ${preset.width} width budget of ${limit} characters -->`,
    trimmed: true,
  }
}
