/**
 * 抽取游标的持久化：「上次抽取到哪」。
 *
 * 只做一件事：把游标写进状态文件
 * `<memoryRoot>/.dsh-memory-state/extraction-<sessionId>.json`。
 *
 * **为什么不用 `ctx.sessionProjections`**（理由留在这里，避免后人再试一次）：
 *
 * 1. 投影没有写入口。已用 `cordis_inspect` 核对过 Host service `sessionProjections`
 *    的方法全集：`register / onChanged / stateOf(session, key) / snapshot /
 *    cachedSnapshot / checkpoint / restoreFloor / viewCheckpoint / restore /
 *    hydrate` —— 全是事件驱动的纯 fold 与检查点，没有任何「写入一个值」的 API
 *    （docs/probes.md P3.3：「写入方式：没有 write API」）。状态只有当一条 session
 *    事件流过某个 unit 的 `apply` 时才会被 framework 推进。
 * 2. 游标的推进条件是**副作用**：只有本轮抽取成功（或明确 no-op）才该往前推，
 *    失败要停在原处等下次。这个「条件性推进」无法用「来一条事件就折一步」的纯
 *    fold 表达。
 * 3. 也不能靠「自己 append 一条 session 事件」去推投影：持久化读路径会拒读不在
 *    `KNOWN_SESSION_EVENT_TYPES` 里、又没带 `ignorable` 标记的事件类型
 *    （`packages/core/session-persistence/src/storage-contract.ts:75-77`），而
 *    `Session.append()` 从来不写 `ignorable`（probes P3.6）——自定义事件类型会让
 *    整个 log 读不出来。
 *
 * 因此状态文件是唯一落点。代价与兜底：写入原子（同目录 `.tmp` + `rename`），目录
 * 不存在就建，任何 IO 失败都被吞掉——游标丢失只意味着多抽一次，可接受。文件不存在
 * 或 JSON 损坏时 `read()` 返回 undefined（等价于「还没有抽过」：下一轮用
 * 全部消息）。`.dsh-memory-state` 与 memory-manifest.js 跳过的状态目录同名，
 * manifest 扫描永远看不到它。
 *
 * 工厂函数是**纯计算**（只算路径、不做任何文件 I/O），所以可以在同步派发里安全构造；
 * 所有 I/O 都在异步的 read/write/reset 里。传多余的参数（例如历史上的
 * `projections`）会被静默忽略。
 *
 * @module dsh-memory/cursor-store
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 与 memory-manifest.js 跳过的状态目录同名；manifest 扫描永远看不到它。 */
const STATE_DIR_NAME = '.dsh-memory-state'

/** 状态文件格式版本，形状变更时递增。 */
const STATE_VERSION = 1

/** 会话 id 进文件名前的清洗上限。 */
const SESSION_ID_MAX_LENGTH = 128

/**
 * Create the per-session cursor store. Pure construction — no filesystem access
 * happens here, so it is safe to call inside a synchronous event dispatch.
 *
 * @param {{ sessionId: string, memoryRoot: string }} options
 * @param {string} options.sessionId 会话 id，用于状态文件名（会做文件名安全清洗）。
 * @param {string} options.memoryRoot 记忆目录；状态文件写在它下面的
 *   `.dsh-memory-state/` 里。
 * @returns {{ read(): Promise<string | undefined>, write(token: string): Promise<void>,
 *   reset(): Promise<void>, dispose(): void }}
 */
export function createCursorStore({ sessionId, memoryRoot }) {
  const safeSessionId = sanitizeSessionId(sessionId)
  const stateDir = typeof memoryRoot === 'string' && memoryRoot.length > 0
    ? join(memoryRoot, STATE_DIR_NAME)
    : undefined
  const statePath = stateDir === undefined ? undefined : join(stateDir, `extraction-${safeSessionId}.json`)
  const tempPath = statePath === undefined ? undefined : `${statePath}.tmp`

  return {
    /**
     * 当前游标。对调用方它只是个不透明字符串（宿主用 `'seq:<n>'` 形态的
     * SessionSeq token）；取不到返回 undefined。
     * @returns {Promise<string | undefined>}
     */
    async read() {
      if (statePath === undefined) return undefined
      try {
        return cursorFromStateText(await readFile(statePath, 'utf8'))
      } catch {
        // 文件不存在或读不了：当作没有游标。
        return undefined
      }
    },

    /**
     * 推进游标。原子写：先 `.tmp` 再 `rename`。空 / 非字符串 token 是 no-op
     * （清空游标请用 {@link reset}）。任何 IO 失败都被吞掉——游标丢失只意味着
     * 多抽一次，可接受。
     * @param {string} token
     * @returns {Promise<void>}
     */
    async write(token) {
      if (statePath === undefined || tempPath === undefined) return
      if (typeof token !== 'string' || token.length === 0) return
      const payload = JSON.stringify({
        stateVersion: STATE_VERSION,
        cursor: token,
        updatedAt: Date.now(),
      })
      try {
        await mkdir(stateDir, { recursive: true })
        await writeFile(tempPath, payload, 'utf8')
        await rename(tempPath, statePath)
      } catch {
        // 见 JSDoc：失败不抛。清掉可能残留的 tmp，下次写会重建。
        await removeQuietly(tempPath)
      }
    },

    /**
     * 删除游标（重置为「从未抽取」）。删除失败同样不抛。
     * @returns {Promise<void>}
     */
    async reset() {
      if (statePath === undefined) return
      await removeQuietly(statePath)
      if (tempPath !== undefined) await removeQuietly(tempPath)
    },

    /**
     * 接口稳定性占位：本 store 不持有需要释放的资源（无 watcher、无缓存）。
     * @returns {void}
     */
    dispose() {},
  }
}

/* -------------------------------------------------------------- 内部 ---- */

/**
 * @param {string} text
 * @returns {string | undefined}
 */
function cursorFromStateText(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // 损坏的 JSON：当作没有游标，不抛。
    return undefined
  }
  if (typeof parsed === 'string') return nonEmptyString(parsed)
  if (!isRecord(parsed)) return undefined
  return nonEmptyString(parsed.cursor)
}

/**
 * 会话 id 进文件名前清洗：只保留 `[A-Za-z0-9_-]`，去掉开头的 `.`/`-`/`_`，
 * 截断到上限。防止 `../`、绝对路径或超长名把状态文件写出记忆目录。
 * @param {unknown} sessionId
 * @returns {string}
 */
function sanitizeSessionId(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId : String(sessionId ?? '')
  const safe = raw
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/^[._-]+/u, '')
    .slice(0, SESSION_ID_MAX_LENGTH)
  return safe.length > 0 ? safe : 'unknown'
}

/** @param {string} path @returns {Promise<void>} */
async function removeQuietly(path) {
  try {
    await rm(path, { force: true })
  } catch {
    // 删不掉就算了：reset 的语义是「下次当作没有游标」，残留文件由 write 覆盖。
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @returns {string | undefined} */
function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
