/**
 * Shared filesystem primitives for the memory store.
 *
 * Two concerns that used to live implicitly in `MemoryStore` and
 * `host/permission.js`:
 *
 *  1. **Atomic replaces.** `MEMORY.md` and every memory file are written with a
 *     same-directory temp file followed by `rename`, so a crash never leaves a
 *     half-written index or a half-written memory, and a concurrent reader sees
 *     either the old or the new file — never a torn mix.
 *  2. **Per-root serialization.** `MEMORY.md` is maintained by a read-modify-
 *     write. Two writers on the same memory root (the `memory` tool, the
 *     extraction pass, or a direct `write`/`edit` widened by the permission
 *     hook) would otherwise interleave and drop each other's index lines. Every
 *     such write now runs inside {@link withMemoryRootLock}.
 *
 * Scope of the lock: **one host process**. Memory roots are shared across
 * sessions of one workspace, but a single `dsh` process owns all of them, so an
 * in-process async queue is enough for the tool/extraction/permission writers.
 * A second *process* (e.g. a CLI `dsh` run against the same workspace while the
 * web server is live) is NOT covered; that residual race is accepted rather
 * than papered over with a lockfile whose stale-lock failure modes are worse
 * than the rare overlap. Atomic rename still protects that case from torn
 * files — only a concurrent read-modify-write of `MEMORY.md` could lose a line.
 *
 * @module dsh-memory/fs
 */

import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Current tail of the serialized queue per root, keyed by the resolved root
 * path. Each value is a promise that always fulfils, so a failed task never
 * poisons the tasks queued behind it.
 * @type {Map<string, Promise<void>>}
 */
const lockTails = new Map()

/**
 * Run `task` after every earlier task on the same memory root has settled.
 *
 * The returned promise mirrors `task`: its value on success, its rejection on
 * failure. The next queued task still runs regardless of this one's outcome.
 *
 * @template T
 * @param {string} rootDir the memory root whose writes must be serialized.
 * @param {() => Promise<T>} task the critical section.
 * @returns {Promise<T>}
 */
export function withMemoryRootLock(rootDir, task) {
  const key = resolve(rootDir)
  const previous = lockTails.get(key) ?? Promise.resolve()
  // `then(run, run)`: a rejection in `previous` is already swallowed by its own
  // tail (below), but run on both paths so an unforeseen rejection never stalls
  // the chain forever.
  const run = previous.then(() => task(), () => task())
  const tail = run.then(() => undefined, () => undefined)
  lockTails.set(key, tail)
  // Drop the entry only when this tail is still the current one. If a newer
  // task chained on, the map already points at that newer tail.
  void tail.then(() => {
    if (lockTails.get(key) === tail) lockTails.delete(key)
  })
  return run
}

/**
 * Atomically replace `filePath` with `data`.
 *
 * The temp file lives in the same directory (so `rename` stays on one
 * filesystem and is atomic) and its name never ends in `.md`, so the manifest
 * scan in `src/memory-manifest.js` cannot mistake a half-written temp for a
 * memory. On any failure the temp is removed and the original file is left
 * untouched.
 *
 * @param {string} filePath destination path.
 * @param {string} data full UTF-8 contents.
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(filePath, data) {
  const dir = dirname(filePath)
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(tempPath, data, 'utf8')
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => { /* best effort */ })
    throw error
  }
}
