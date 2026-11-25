import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { auditMemory } from '../src/memory-audit.js'
import { MemoryStore } from '../src/memory-store.js'
import { atomicWriteFile } from '../src/memory-fs.js'
import { createMemoryTool } from '../host/tool.js'

const EM_DASH = '\u2014'

function entry(file, body, description, type = 'project') {
  return {
    file,
    title: file.replace(/\.md$/u, ''),
    hook: description,
    frontmatter: { name: file.replace(/\.md$/u, ''), description, type },
    body,
  }
}

test('auditMemory flags duplicates, dangling pointers, unindexed files, layer conflicts and index budget', () => {
  const report = auditMemory({
    rootDir: '/mem',
    entries: [
      { filename: 'a.md', type: 'project', name: 'dup', description: 'same desc', bodyChars: 10 },
      { filename: 'b.md', type: 'project', name: 'dup', description: 'same desc', bodyChars: 10 },
      { filename: 'fb1.md', type: 'feedback', name: 'fb-one', description: 'x', bodyChars: 5 },
      { filename: 'fb2.md', type: 'feedback', name: 'fb-two', description: 'y', bodyChars: 5 },
      { filename: 'orphan.md', type: 'project', name: 'orphan', description: 'z', bodyChars: 5 },
    ],
    pointers: new Map([
      ['a.md', { title: 'A', hook: 'h' }],
      ['b.md', { title: 'B', hook: 'h' }],
      ['fb1.md', { title: 'FB1', hook: 'h' }],
      ['fb2.md', { title: 'FB2', hook: 'h' }],
      ['missing.md', { title: 'Missing', hook: 'h' }],
    ]),
    indexLimits: { lineLimit: 2, charLimit: 1000 },
    alwaysOn: { files: 2, lines: 2, chars: 20, lineLimit: 10, charLimit: 800, overBudget: false },
  })

  assert.equal(report.ok, true)
  assert.equal(report.action, 'audit')
  // a.md, b.md and the dangling missing.md are on-demand; fb1/fb2 are always-on.
  assert.equal(report.index.pointerLines, 3)
  assert.equal(report.index.overBudget, true)

  assert.ok(report.danglingPointers.some((item) => item.file === 'missing.md'))
  assert.ok(report.unindexedFiles.includes('orphan.md'))
  assert.ok(report.duplicates.some((group) => group.kind === 'name' && group.files.join(',') === 'a.md,b.md'))
  assert.ok(report.conflicts.some((conflict) => conflict.type === 'feedback' && conflict.files.includes('fb1.md')))
  assert.ok(report.mergeCandidates.length >= 2)
  assert.ok(report.totals.issues > 0)
})

test('auditMemory reports a clean root as no issues', () => {
  const report = auditMemory({
    rootDir: '/mem',
    entries: [{ filename: 'a.md', type: 'project', name: 'a', description: 'just one', bodyChars: 10 }],
    pointers: new Map([['a.md', { title: 'A', hook: 'h' }]]),
    indexLimits: { lineLimit: 200, charLimit: 25000 },
    alwaysOn: { files: 0, lines: 0, chars: 0, lineLimit: 10, charLimit: 800, overBudget: false },
  })
  assert.equal(report.totals.issues, 0)
})

test('auditMemory flags an oversized body only when a body cap applies', () => {
  const input = {
    rootDir: '/mem',
    entries: [{ filename: 'big.md', type: 'project', name: 'big', description: 'd', bodyChars: 900 }],
    pointers: new Map([['big.md', { title: 'Big', hook: 'h' }]]),
    indexLimits: { lineLimit: 200, charLimit: 25000 },
  }
  assert.equal(auditMemory(input).oversizedBodies.length, 0)
  assert.equal(auditMemory({ ...input, bodyCharLimit: 800 }).oversizedBodies.length, 1)
})

test('the memory tool audit action reports real on-disk problems without modifying anything', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-memory-audit-'))
  const store = new MemoryStore({ rootDir, sessionId: 's' })
  await store.ensureRoot()
  try {
    await store.writeMemory(entry('alpha.md', 'alpha body', 'first'))
    await store.writeMemory(entry('beta.md', 'beta body', 'second'))
    await store.writeMemory(entry('fb_a.md', 'rule a', 'rule one', 'feedback'))
    await store.writeMemory(entry('fb_b.md', 'rule b', 'rule two', 'feedback'))

    // A file on disk with no index pointer (written outside the tool).
    await atomicWriteFile(join(rootDir, 'orphan.md'), [
      '---', 'name: orphan', 'description: orphaned fact', 'metadata:', '  type: project', '---', '', 'body', '',
    ].join('\n'))
    // A pointer whose file does not exist.
    const before = await store.readRawIndex()
    await atomicWriteFile(join(rootDir, 'MEMORY.md'), `${before}\n- [Ghost](ghost.md) ${EM_DASH} gone`)

    const tool = createMemoryTool({
      registry: {
        get: () => ({ rootDir, store }),
        alwaysOnLimits: () => ({ lineLimit: 10, charLimit: 800 }),
        indexLimits: () => ({ lineLimit: 200, charLimit: 25000 }),
        config: { memoryWidth: 'balanced' },
      },
      logger: { warn() {} },
    })
    const result = await tool.execute({ action: 'audit' }, { agent: { session: { id: 's' } } })

    assert.equal(result.ok, true)
    assert.equal(result.action, 'audit')
    assert.ok(result.danglingPointers.some((item) => item.file === 'ghost.md'))
    assert.ok(result.unindexedFiles.includes('orphan.md'))
    assert.ok(result.conflicts.some((conflict) => conflict.type === 'feedback'))
    // Read-only: the index still has the dangling pointer we injected.
    assert.ok((await store.readRawIndex()).includes('(ghost.md)'))
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
