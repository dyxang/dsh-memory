import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../src/memory-store.js'
import { createMemoryTool } from '../host/tool.js'

function entry(file, body, description) {
  return {
    file,
    title: file.replace(/\.md$/u, ''),
    hook: description,
    frontmatter: { name: file.replace(/\.md$/u, ''), description, type: 'project' },
    body,
  }
}

test('search reports truncation when a body is over the per-file budget', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-memory-search-'))
  const store = new MemoryStore({ rootDir, sessionId: 's' })
  await store.ensureRoot()
  try {
    const huge = 'x'.repeat(600 * 1024) // > 512 KiB per-file body cap
    await store.writeMemory(entry('huge.md', huge, 'a huge memory'))
    await store.writeMemory(entry('small.md', 'the needle lives here', 'a small memory'))

    const tool = createMemoryTool({
      registry: { get: () => ({ rootDir, store }), alwaysOnLimits: () => ({}) },
      logger: { warn() {} },
    })
    const result = await tool.execute(
      { action: 'search', query: 'needle' },
      { agent: { session: { id: 's' } } },
    )

    assert.equal(result.ok, true)
    assert.equal(result.action, 'search')
    assert.equal(result.truncated, true)
    assert.ok(result.matches.some((match) => match.filename === 'small.md'))
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('search matches a file name without reading any body', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-memory-search-'))
  const store = new MemoryStore({ rootDir, sessionId: 's' })
  await store.ensureRoot()
  try {
    await store.writeMemory(entry('vacation-plan.md', 'nothing to see', 'trip notes'))
    const tool = createMemoryTool({
      registry: { get: () => ({ rootDir, store }), alwaysOnLimits: () => ({}) },
      logger: { warn() {} },
    })
    const result = await tool.execute(
      { action: 'search', query: 'vacation' },
      { agent: { session: { id: 's' } } },
    )
    assert.equal(result.ok, true)
    assert.equal(result.truncated, false)
    assert.ok(result.matches.some((match) => match.filename === 'vacation-plan.md'))
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
