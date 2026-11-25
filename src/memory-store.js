/**
 * The memory store: every filesystem operation the plugin performs on one
 * memory directory. Uses `node:fs` directly, matching how DSH's own local
 * backends (`attachment-local`, `credentials-local`) own a subtree of
 * `$DSH_HOME`. All model-supplied paths pass through the containment and
 * sensitive-segment checks in `memory-path.js` before any write.
 *
 * @module dsh-memory/store
 */

import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MEMORY_INDEX_NAME, parseMemoryFile, stampMemoryOriginSessionId } from './memory-format.js'
import { parseMemoryIndexPointers, removeMemoryIndexLine, upsertMemoryIndexLine } from './memory-index.js'
import { alwaysOnUsage, formatLayeredMemoryIndex, isAlwaysOnType } from './memory-layers.js'
import { scanMemoryManifest } from './memory-manifest.js'
import { atomicWriteFile, withMemoryRootLock } from './memory-fs.js'
import { readProjectMemoryFileFromStableHandle } from './stable-read.js'

/**
 * @typedef {{filePath: string, filename: string, mtimeMs: number, description?: string, type?: string}} ManifestEntry
 */

/**
 * How many always-on bodies one prompt view reads. The always-on layer is
 * supposed to hold one small file per type; the cap is the difference between a
 * misconfigured root costing a few reads and costing a read per memory file.
 */
const ALWAYS_ON_BODY_LIMIT = 20

/** One memory directory and the operations allowed on it. */
export class MemoryStore {
  /**
   * @param {{rootDir: string, sessionId?: string}} options
   */
  constructor({ rootDir, sessionId }) {
    this.rootDir = rootDir
    this.sessionId = sessionId
  }

  /** Create the memory directory. Failure is logged by the caller, never fatal. */
  async ensureRoot() {
    await mkdir(this.rootDir, { recursive: true })
  }

  /**
   * The text the model should see, layered: `user` and `feedback` entries as
   * their rules, the rest as one-line pointers (see `src/memory-layers.js`).
   *
   * One manifest scan plus one body read per always-on entry. The caller caches
   * the result behind its TTL, so a prompt build does not pay for this on every
   * turn — only the first assembly inside each refresh window does.
   *
   * @param {{lineLimit?: number, charLimit?: number}} [limits] on-demand layer budget.
   * @param {{lineLimit?: number, charLimit?: number}} [alwaysOnLimits] always-on layer budget.
   * @returns {Promise<string>}
   */
  async readPromptView(limits, alwaysOnLimits) {
    const { pointers, entries, bodies } = await this.promptSources()
    return formatLayeredMemoryIndex({ pointers, entries, bodies, indexLimits: limits, alwaysOnLimits })
  }

  /**
   * The always-on layer's usage, so the write path can report it back to the
   * model: the layer is the one place where "one more line" costs every turn.
   * @param {{lineLimit?: number, charLimit?: number}} [limits]
   * @returns {Promise<{files: number, lines: number, chars: number, lineLimit: number, charLimit: number, overBudget: boolean}>}
   */
  async alwaysOnLayerUsage(limits) {
    const { pointers, entries, bodies } = await this.promptSources()
    return alwaysOnUsage({ pointers, entries, bodies, limits })
  }

  /**
   * The three sources one prompt view needs: the index pointers, the manifest
   * (types and recency) and the always-on bodies (the rules themselves).
   * @returns {Promise<{pointers: Map<string, {title: string, hook: string}>, entries: ManifestEntry[], bodies: Map<string, string>}>}
   */
  async promptSources() {
    const [raw, entries] = await Promise.all([this.readRawIndex(), this.manifest()])
    const pointers = parseMemoryIndexPointers(raw)
    const bodies = new Map()
    // The cap counts always-on reads, not manifest entries: applying it to the
    // newest N files would silently downgrade the always-on rules that happen
    // to be older than them from their body to their one-line hook.
    let reads = 0
    for (const entry of entries) {
      if (!isAlwaysOnType(entry.type)) continue
      if (reads >= ALWAYS_ON_BODY_LIMIT) break
      reads += 1
      try {
        const content = await readFile(entry.filePath, 'utf8')
        bodies.set(entry.filename, parseMemoryFile(content).body)
      } catch {
        // A file that vanished between the scan and the read is not injected as
        // text; its pointer line keeps it visible in the on-demand layer.
      }
    }
    return { pointers, entries, bodies }
  }

  /**
   * The raw index text, for maintenance.
   * @returns {Promise<string>}
   */
  async readRawIndex() {
    try {
      return await readFile(join(this.rootDir, MEMORY_INDEX_NAME), 'utf8')
    } catch {
      return ''
    }
  }

  /**
   * @returns {Promise<ManifestEntry[]>}
   */
  async manifest() {
    return scanMemoryManifest(this.rootDir)
  }

  /**
   * The bodies of the most recently updated memories, for the extraction prompt.
   *
   * Frontmatter is stripped, and that matters twice over: the `name:`,
   * `description:` and `metadata:` lines are not the model's to rewrite, and
   * feeding them back as "start from these" is what taught the extraction model
   * to paste a second header into a body. It also keeps ~250 characters of
   * non-content per file out of every extraction request.
   *
   * @param {number} count
   * @returns {Promise<Array<{filename: string, body: string}>>}
   */
  async recentBodies(count) {
    if (!Number.isFinite(count) || count <= 0) return []
    const entries = await this.manifest()
    const out = []
    for (const entry of entries.slice(0, Math.floor(count))) {
      try {
        const content = await readFile(entry.filePath, 'utf8')
        out.push({ filename: entry.filename, body: parseMemoryFile(content).body.trim() })
      } catch {
        // A file that vanished between the scan and the read is simply skipped.
      }
    }
    return out
  }

  /**
   * Read one memory file through the TOCTOU-safe path.
   * @param {string} filename bare file name.
   * @returns {Promise<{content: string, updatedAt: number}>}
   */
  async readMemoryFile(filename) {
    const filePath = this.resolveWritable(filename)
    return readProjectMemoryFileFromStableHandle({
      filePath,
      validatePath: () => { this.resolveWritable(filename) },
    })
  }

  /**
   * Write one memory file and maintain its index pointer.
   * @param {{file: string, title: string, hook: string, frontmatter: {name: string, description: string, type: string}, body: string}} entry
   * @returns {Promise<{filePath: string, indexLine: string}>}
   */
  async writeMemory(entry) {
    const filePath = this.resolveWritable(entry.file)
    const content = renderMemoryFile(entry, this.sessionId)
    // One critical section: the memory file and its index pointer land
    // together, so a concurrent writer on the same root cannot read a stale
    // index between our write and our upsert and clobber it.
    return withMemoryRootLock(this.rootDir, async () => {
      await mkdir(dirname(filePath), { recursive: true })
      await atomicWriteFile(filePath, content)
      const indexLine = `- [${entry.title}](${entry.file}) \u2014 ${entry.hook}`
      const index = await this.readRawIndex()
      await atomicWriteFile(join(this.rootDir, MEMORY_INDEX_NAME), upsertMemoryIndexLine(index, {
        file: entry.file,
        title: entry.title,
        hook: entry.hook,
      }))
      return { filePath, indexLine }
    })
  }

  /**
   * Delete one memory file and its index pointer.
   *
   * Existence is reported honestly: `rm` without `force` throws `ENOENT` for a
   * missing file, which is swallowed and surfaced as `deleted: false` rather
   * than the old unconditional `true`. Any other error still propagates.
   *
   * @param {string} filename bare file name.
   * @returns {Promise<{deleted: boolean}>} whether a file actually existed.
   */
  async deleteMemory(filename) {
    const filePath = this.resolveWritable(filename)
    return withMemoryRootLock(this.rootDir, async () => {
      let deleted = false
      try {
        await rm(filePath)
        deleted = true
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const index = await this.readRawIndex()
      const next = removeMemoryIndexLine(index, filename)
      if (next !== index) await atomicWriteFile(join(this.rootDir, MEMORY_INDEX_NAME), next)
      return { deleted }
    })
  }

  /**
   * Reconcile `MEMORY.md` with the files on disk: add a pointer line for every
   * top-level memory file the index does not mention.
   *
   * This heals the one silent gap in the layout — a file present without a
   * pointer is never injected (the index is authoritative for what the model
   * sees). It is one-directional: it only ADDS missing lines. A dangling
   * pointer (a line whose file is gone) is left in place, because the layered
   * view already tolerates it and deleting another writer's line is riskier
   * than leaving it. Idempotent.
   *
   * @returns {Promise<{added: number}>} how many pointer lines were added.
   */
  async reconcileIndex() {
    return withMemoryRootLock(this.rootDir, async () => {
      const entries = await this.manifest()
      const index = await this.readRawIndex()
      const pointers = parseMemoryIndexPointers(index)
      let next = index
      let added = 0
      for (const entry of entries) {
        // Only bare top-level files are memory-tool addressable. A nested file
        // cannot be written or read by name, so it is not indexed.
        if (entry.filename.includes('/')) continue
        if (pointers.has(entry.filename)) continue
        next = upsertMemoryIndexLine(next, {
          file: entry.filename,
          title: entry.filename.replace(/\.md$/iu, ''),
          hook: typeof entry.description === 'string' ? entry.description : '',
        })
        added += 1
      }
      if (added > 0) await atomicWriteFile(join(this.rootDir, MEMORY_INDEX_NAME), next)
      return { added }
    })
  }

  /**
   * Validate a bare memory file name against this root.
   * @param {string} filename
   * @returns {string} the absolute path.
   * @throws {Error} when the name is not a safe bare memory file name.
   */
  resolveWritable(filename) {
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new Error('memory file name is required')
    }
    if (filename !== filename.trim() || /[\\/]/.test(filename) || filename.includes('..')) {
      throw new Error(`memory file name must be a bare file name: ${filename}`)
    }
    if (!filename.toLowerCase().endsWith('.md')) {
      throw new Error(`memory file must be a Markdown file: ${filename}`)
    }
    if (filename === MEMORY_INDEX_NAME) {
      throw new Error('MEMORY.md is the index and is never a memory file')
    }
    const filePath = join(this.rootDir, filename)
    if (dirname(filePath) !== this.rootDir) {
      throw new Error(`memory file must sit directly in the memory root: ${filename}`)
    }
    return filePath
  }
}

/**
 * Render one memory file from its parts, then stamp the origin.
 * @param {{file: string, frontmatter: {name: string, description: string, type: string}, body: string}} entry
 * @param {string} [sessionId]
 * @returns {string}
 */
export function renderMemoryFile(entry, sessionId) {
  const { name, description, type } = entry.frontmatter
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'metadata:',
    `  type: ${type}`,
    '---',
    '',
    entry.body.replace(/\s+$/u, ''),
    '',
  ]
  const text = lines.join('\n')
  return sessionId === undefined ? text : stampMemoryOriginSessionId(text, sessionId)
}
