/**
 * The extraction scheduler: a single-flight, coalescing state machine that
 * decides when one memory extraction pass runs and advances the durable
 * message cursor once a pass has consumed its window.
 *
 * The factory creates the scheduler plus its `acquireSnapshot` /
 * `waitForSnapshotAcquisitionOrShutdown` helpers. The state machine (queue
 * depth 1, overwrite coalescing, shutdown/drain semantics) is the core.
 *
 * Design notes, all forced by this plugin's split of responsibilities:
 *
 * 1. **The snapshot is opaque.** The scheduler does not type it; the host owns
 *    the snapshot shape and the scheduler reads only `snapshot.cursorToken` —
 *    an opaque string (possibly `undefined`) marking the last message the
 *    snapshot covers.
 * 2. **The trigger decision is injected, not computed.** Evaluating the
 *    trigger needs a normalized message window plus a host-provided
 *    `isMemoryTarget` predicate (see `extraction-trigger.js`), neither of
 *    which belongs inside a state machine. The host may pass an
 *    `evaluate(snapshot)` hook returning `{ decision: 'run' | 'skip' }` to
 *    keep the original `skip` semantics; when the hook is omitted every
 *    snapshot is treated as `run` (a host that folds the trigger into
 *    `execute` and returns `'no-op'` for a skip gets the same cursor
 *    behaviour).
 * 3. **`execute` input is the host contract** `{ abortSignal, snapshot }`; the
 *    message count is not forwarded, because a host that evaluates the trigger
 *    itself already knows it.
 *
 * @module dsh-memory/extraction-scheduler
 */

/**
 * @typedef {'success'|'no-op'|'error'|'aborted'} ExtractionStatus
 *   `success` and `no-op` advance the cursor; `error` and `aborted` do not.
 */

/**
 * @typedef {{status: 'acquired', snapshot: any} | {status: 'error'}} SnapshotAcquisition
 *   A resolved snapshot, or a snapshot acquisition that failed.
 */

/**
 * @typedef {{status: 'acquired', snapshot: any} | {status: 'error'} | {status: 'shutdown'}} SnapshotAcquisitionWait
 */

/**
 * Wrap a snapshot (or a promise of one) so a rejection becomes a value.
 * @param {any | Promise<any>} snapshot
 * @returns {Promise<SnapshotAcquisition>}
 */
function acquireSnapshot(snapshot) {
  return Promise.resolve(snapshot).then(
    (value) => ({ status: 'acquired', snapshot: value }),
    () => ({ status: 'error' }),
  )
}

/**
 * Race a snapshot acquisition against the shutdown signal: an already-aborted
 * signal short-circuits, otherwise the first of {acquired, error, abort} wins
 * and the listener is always removed.
 * @param {Promise<SnapshotAcquisition>} acquisition
 * @param {AbortSignal} signal
 * @returns {Promise<SnapshotAcquisitionWait>}
 */
function waitForSnapshotAcquisitionOrShutdown(acquisition, signal) {
  if (signal.aborted) return Promise.resolve({ status: 'shutdown' })

  return new Promise((resolve) => {
    const onAbort = () => {
      cleanup()
      resolve({ status: 'shutdown' })
    }
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }

    signal.addEventListener('abort', onAbort, { once: true })
    void acquisition.then((result) => {
      cleanup()
      resolve(result)
    })
  })
}

/**
 * Create the scheduler.
 *
 * @param {{
 *   execute: (input: { abortSignal: AbortSignal, snapshot: any }) => Promise<ExtractionStatus>,
 *   evaluate?: (snapshot: any) => { decision: 'run' | 'skip', reason?: string },
 * }} options
 *   `execute` runs one extraction pass. `evaluate` is the optional
 *   trigger hook: returning `{ decision: 'skip' }` consumes the window without
 *   running `execute` and still advances the cursor. A skip only advances the
 *   in-memory cursor — it is never persisted, so after a restart the same
 *   window is judged again and skipped again; that idempotent repeat is the
 *   accepted cost of not writing scheduler state on every turn.
 * @returns {{
 *   schedule: (snapshot: any | Promise<any>) => void,
 *   drain: () => Promise<void>,
 *   getCursor: () => string | undefined,
 *   hasPendingWork: () => boolean,
 *   shutdown: () => void,
 * }}
 */
export function createMemoryExtractionScheduler({ execute, evaluate }) {
  /** @type {string | undefined} */
  let cursor
  /** @type {Promise<SnapshotAcquisition> | undefined} */
  let latestPending
  /** @type {Promise<void> | undefined} */
  let running
  let shuttingDown = false
  const shutdownController = new AbortController()

  const processSnapshot = async (snapshot) => {
    const decision = typeof evaluate === 'function'
      ? evaluate(snapshot)
      : { decision: 'run' }
    // Optional chaining here: an unconditional property read would make a host
    // that schedules `undefined` throw a TypeError that the run loop swallows
    // as a processing error, hiding the real bug.
    const snapshotEnd = snapshot?.cursorToken

    if (decision.decision === 'skip') {
      // A skipped window is consumed too, so the cursor advances exactly like
      // a successful pass.
      if (snapshotEnd) cursor = snapshotEnd
      return
    }

    let status
    try {
      status = await execute({ abortSignal: shutdownController.signal, snapshot })
    } catch {
      // A throwing execute must not advance the cursor (the window was not
      // consumed) and must not escape to the caller.
      return
    }

    // `aborted` and `error` deliberately fall through without advancing; a
    // success after shutdown does not advance either, because the window may
    // have been re-scheduled elsewhere.
    if (!shuttingDown && (status === 'success' || status === 'no-op') && snapshotEnd) {
      cursor = snapshotEnd
    }
  }

  const run = async (first) => {
    try {
      let current = first
      while (current && !shuttingDown) {
        const acquisition = await waitForSnapshotAcquisitionOrShutdown(
          current,
          shutdownController.signal,
        )
        if (acquisition.status === 'shutdown' || shuttingDown) break
        if (acquisition.status === 'acquired') {
          try {
            await processSnapshot(acquisition.snapshot)
          } catch {
            // This error does not advance the cursor; the coalesced pending
            // snapshot still runs.
          }
        }
        // Queue depth is exactly one: `schedule` during a run overwrites
        // `latestPending`, and taking it here clears the slot.
        current = shuttingDown ? undefined : latestPending
        latestPending = undefined
      }
    } finally {
      if (shuttingDown) latestPending = undefined
      running = undefined
    }
  }

  return {
    async drain() {
      while (running) {
        await running
      }
    },
    getCursor() {
      return cursor
    },
    hasPendingWork() {
      return running !== undefined || latestPending !== undefined
    },
    schedule(snapshot) {
      if (shuttingDown) return
      const acquisition = acquireSnapshot(snapshot)
      if (running) {
        // Overwrite coalescing: only the newest pending snapshot survives.
        latestPending = acquisition
        return
      }

      running = run(acquisition)
    },
    shutdown() {
      if (shuttingDown) return
      // The process stays alive after a session closes, so an aborted
      // scheduler must stop waiting for work that may still be in flight:
      // pending snapshots are dropped and the in-flight execute is signalled.
      shuttingDown = true
      latestPending = undefined
      shutdownController.abort()
    },
  }
}
