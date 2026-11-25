/**
 * Loopback HTTP routes that feed the settings page.
 *
 * The routes are registered on `ctx.webServer` exactly like
 * `@deepseek-ai/dsh-open-in-app` does, and every request is first passed
 * through `ctx.connection.requestRejection` so a non-loopback caller is
 * rejected before any memory data is read.
 *
 * @module dsh-memory/host/status
 */

import { join } from 'node:path'
import { MEMORY_INDEX_NAME } from '../src/memory-format.js'
import { readProjectMemoryFileFromStableHandle } from '../src/stable-read.js'
import { configValue } from '../src/config-value.js'

/** Status route. */
export const MEMORY_STATUS_PATH = '/memory/status'

/** File-read route. */
export const MEMORY_FILE_PATH = '/memory/file'

/**
 * Install the memory status routes for the lifetime of `ctx`.
 * @param {{ctx: import('@deepseek-ai/cordis').Context, registry: import('./context.js').MemoryContextRegistry, config: Record<string, unknown>, logger?: {warn: (message: string) => void}}} options
 */
export function installMemoryRoutes({ ctx, registry, config, logger }) {
  const reject = (req, res) => {
    const rejection = ctx.connection?.requestRejection?.(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MEMORY_STATUS_PATH,
    handler: async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET') return methodNotAllowed(res)
      try {
        sendJson(res, 200, await buildStatus(registry, config))
      } catch (error) {
        logger?.warn(`memory: status failed: ${error instanceof Error ? error.message : String(error)}`)
        sendJson(res, 500, { code: 'status-failed' })
      }
    },
  }), `dsh-memory: GET ${MEMORY_STATUS_PATH}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MEMORY_FILE_PATH,
    handler: async (req, res) => {
      if (reject(req, res)) return
      if (req.method !== 'GET') return methodNotAllowed(res)
      const url = new URL(String(req.url), 'http://localhost')
      const sessionId = url.searchParams.get('session') ?? ''
      const file = url.searchParams.get('file') ?? ''
      const memory = registry.get(sessionId)
      if (memory === undefined) return sendJson(res, 404, { code: 'unknown-session' })
      try {
        const result = await memory.store.readMemoryFile(file)
        sendJson(res, 200, { file, ...result })
      } catch (error) {
        sendJson(res, 400, { code: 'read-failed', message: error instanceof Error ? error.message : String(error) })
      }
    },
  }), `dsh-memory: GET ${MEMORY_FILE_PATH}`)
}

/**
 * @param {import('./context.js').MemoryContextRegistry} registry
 * @param {Record<string, unknown>} config
 * @returns {Promise<Record<string, unknown>>}
 */
async function buildStatus(registry, config) {
  const agents = []
  for (const [sessionId, memory] of registry.agents) {
    let files = []
    let indexLines = 0
    let lastWriteAt = 0
    try {
      const manifest = await memory.store.manifest()
      files = manifest.map((entry) => entry.filename)
      lastWriteAt = manifest.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0)
    } catch {
      /* an unreadable root reports zero */
    }
    try {
      const raw = await memory.store.readRawIndex()
      indexLines = raw.split('\n').filter((line) => line.trim().length > 0).length
    } catch {
      indexLines = 0
    }
    agents.push({ sessionId, rootDir: memory.rootDir, files, indexLines, lastWriteAt })
  }
  return {
    enabled: config.enabled !== false,
    // `extractionEnabled` is volatile, so it arrives as a reference: read it
    // here rather than snapshotting it in `apply`, or a value saved in the
    // Plugins page would not reach this status until the plugin reloads.
    extractionEnabled: configValue(config.extractionEnabled) !== false,
    storageRoot: registry.storageRoot,
    indexFile: MEMORY_INDEX_NAME,
    agents,
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * @param {import('node:http').ServerResponse} res
 */
function methodNotAllowed(res) {
  sendJson(res, 405, { code: 'method-not-allowed' })
}
