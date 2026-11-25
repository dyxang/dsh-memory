import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore } from '../src/memory-store.js'
import { atomicWriteFile } from '../src/memory-fs.js'

async function freshStore() {
  const rootDir = await mkdtemp(join(tmpdir(), 'dsh-memory-store-'))
  const store = new MemoryStore({ rootDir, sessionId: 'session-test' })
  await store.ensureRoot()
  return { rootDir, store }
}

function entry(file, body, extra = {}) {
  return {
    file,
    title: file.replace(/\.md$/u, ''),
    hook: `hook for ${file}`,
    frontmatter: { name: file.replace(/\.md$/u, ''), description: `desc for ${file}`, type: 'project' },
    body,
    ...extra,
  }
}

test('concurrent writeMemory calls keep every index line', async () => {
  const { rootDir, store } = await freshStore()
  try {
    const files = Array.from({ length: 20 }, (_, i) => `mem_${i}.md`)
    await Promise.all(files.map((file) => store.writeMemory(entry(file, `body ${file}`))))

    const index = await store.readRawIndex()
    const pointers = index.split('\n').filter((line) => /^-\s*\[/u.test(line))
    assert.equal(pointers.length, 20, 'one pointer per file, none lost')
    for (const file of files) {
      assert.ok(index.includes(`(${file})`), `index mentions ${file}`)
    }
    const temps = (await readdir(rootDir)).filter((name) => name.includes('.tmp'))
    assert.deepEqual(temps, [])
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('deleteMemory reports existence honestly', async () => {
  const { rootDir, store } = await freshStore()
  try {
    await store.writeMemory(entry('gone.md', 'body'))
    assert.deepEqual(await store.deleteMemory('gone.md'), { deleted: true })
    assert.ok(!(await store.readRawIndex()).includes('(gone.md)'))

    assert.deepEqual(await store.deleteMemory('never.md'), { deleted: false })
    assert.ok(!(await store.readRawIndex()).includes('(never.md)'))
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('reconcileIndex adds pointers for files the index never saw, idempotently', async () => {
  const { rootDir, store } = await freshStore()
  try {
    // Simulate a file written outside the store: on disk, no index line.
    await atomicWriteFile(join(rootDir, 'orphan.md'), [
      '---',
      'name: orphan',
      'description: an orphaned fact',
      'metadata:',
      '  type: project',
      '---',
      '',
      'the body',
      '',
    ].join('\n'))

    assert.deepEqual(await store.reconcileIndex(), { added: 1 })
    const first = await store.readRawIndex()
    assert.ok(first.includes('(orphan.md)'))
    assert.ok(first.includes('an orphaned fact'))

    assert.deepEqual(await store.reconcileIndex(), { added: 0 })
    assert.equal(await store.readRawIndex(), first)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
