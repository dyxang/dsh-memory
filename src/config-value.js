/**
 * One config value, read now.
 *
 * A `.volatile()` field arrives as a reference object whose `.get()` yields the
 * current value; an ordinary field — and every value a unit test hands this
 * plugin — arrives as the value itself. Reading through this helper accepts
 * both shapes, which keeps the unit tests free of schema wrappers while the
 * production path takes the `.get()` branch.
 *
 * Call it at the point of use rather than caching the result during `apply`:
 * a volatile-only change is committed into the running fiber without a remount
 * (`vendor/loader/src/config/entry.ts:162-194`,
 * `packages/boot/hmr/README.md:57`), so anything captured at install time goes
 * stale the moment the user saves a new value in the Plugins page. That is the
 * whole point of the nine volatile fields.
 *
 * The fields this applies to are the nine marked `.volatile()` in `index.js`:
 * `extractionEnabled`, `minUserChars`, `minCjkChars`, `recentBodiesInPrompt`,
 * `includeSubagents`, `extractionMinTurns`, `extractionMinSteps`, `model`,
 * `memoryWidth`. Adding another means reading it through here too — reading it
 * raw would hand the consumer a reference object, and `typeof x === 'number'`
 * would silently become false.
 *
 * @param {unknown} field one config field: a volatile reference or a plain value.
 * @returns {unknown} the field's current value.
 */
export function configValue(field) {
  return typeof field === 'object' && field !== null && typeof field.get === 'function'
    ? field.get()
    : field
}
