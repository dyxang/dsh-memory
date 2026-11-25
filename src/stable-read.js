/**
 * TOCTOU-safe memory file reads.
 *
 * The read protocol: stat, open with `O_NOFOLLOW`, stat again, re-validate the
 * path, stat again, compare, read bounded, then compare once more. The five
 * inode fields catch both a concurrent replacement (different inode) and an
 * in-place overwrite (same inode, changed size/mtime/ctime).
 *
 * @module dsh-memory/stable-read
 */

import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { constants } from 'node:fs'

/** Error codes carried on the thrown errors. */
export const MEMORY_PREVIEW_LIMIT_EXCEEDED = 'MEMORY_PREVIEW_LIMIT_EXCEEDED'
export const MEMORY_FILE_CHANGED = 'MEMORY_FILE_CHANGED'

/** 5 MiB preview cap. */
export const MEMORY_PREVIEW_MAX_BYTES = 5 * 1024 * 1024

/** `O_NOFOLLOW` is unavailable on some platforms; degrade to a plain open. */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

/**
 * @param {string} message
 * @param {string} code
 * @returns {Error}
 */
function memoryError(message, code) {
  return Object.assign(new Error(message), { code })
}

/**
 * Whether two stat snapshots describe the same unchanged file.
 * @param {import('node:fs').BigIntStats} left
 * @param {import('node:fs').BigIntStats} right
 * @returns {boolean}
 */
function isSameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

/**
 * Read one memory file through a verified handle.
 * @param {{filePath: string, validatePath?: () => void}} params
 * @returns {{content: string, updatedAt: number}}
 * @throws {Error} with `code` `MEMORY_FILE_CHANGED` or `MEMORY_PREVIEW_LIMIT_EXCEEDED`.
 */
export function readProjectMemoryFileFromStableHandle(params) {
  const { filePath } = params
  const preOpenStat = lstatSync(filePath, { bigint: true })
  if (!preOpenStat.isFile() || preOpenStat.isSymbolicLink()) {
    throw memoryError('Memory file is not a regular file', MEMORY_FILE_CHANGED)
  }

  let handle
  try {
    handle = openSync(filePath, constants.O_RDONLY | O_NOFOLLOW)
    const openedStat = fstatSync(handle, { bigint: true })
    params.validatePath?.()
    const postOpenStat = lstatSync(filePath, { bigint: true })

    if (!openedStat.isFile() || !postOpenStat.isFile() || postOpenStat.isSymbolicLink()) {
      throw memoryError('Memory file changed while opening', MEMORY_FILE_CHANGED)
    }
    if (!isSameFileSnapshot(openedStat, preOpenStat) || !isSameFileSnapshot(openedStat, postOpenStat)) {
      throw memoryError('Memory file changed while opening', MEMORY_FILE_CHANGED)
    }
    if (openedStat.size > BigInt(MEMORY_PREVIEW_MAX_BYTES)) {
      throw memoryError('Memory file exceeds the preview limit', MEMORY_PREVIEW_LIMIT_EXCEEDED)
    }

    const content = readBoundedFile(handle, MEMORY_PREVIEW_MAX_BYTES + 1)
    const finalStat = fstatSync(handle, { bigint: true })
    if (!isSameFileSnapshot(finalStat, openedStat)) {
      throw memoryError('Memory file changed while reading', MEMORY_FILE_CHANGED)
    }
    if (content.length > MEMORY_PREVIEW_MAX_BYTES || finalStat.size > BigInt(MEMORY_PREVIEW_MAX_BYTES)) {
      throw memoryError('Memory file exceeds the preview limit', MEMORY_PREVIEW_LIMIT_EXCEEDED)
    }
    return { content: content.toString('utf8'), updatedAt: Number(finalStat.mtimeNs) / 1_000_000 }
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

/**
 * Read at most `maxBytes` bytes from an open handle.
 * @param {number} handle
 * @param {number} maxBytes
 * @returns {Buffer}
 */
function readBoundedFile(handle, maxBytes) {
  const chunks = []
  let total = 0
  const buffer = Buffer.allocUnsafe(Math.min(65_536, maxBytes))
  for (;;) {
    const read = readSync(handle, buffer, 0, buffer.length, total)
    if (read === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, read)))
    total += read
    if (total >= maxBytes) break
  }
  return Buffer.concat(chunks)
}
