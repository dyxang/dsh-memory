import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { atomicWriteFile, withMemoryRootLock } from '../src/memory-fs.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-memory-fs-'))
}

test('atomicWriteFile replaces contents and leaves no temp file', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, 'a.md')
    await atomicWriteFile(file, 'first')
    await atomicWriteFile(file, 'second')
    assert.equal(await readFile(file, 'utf8'), 'second')
    const leftovers = (await readdir(dir)).filter((name) => name.includes('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('atomicWriteFile cleans up its temp file when the rename fails', async () => {
  const dir = await tempDir()
  try {
    // A directory at the destination makes rename fail.
    await mkdir(join(dir, 'busy'))
    await assert.rejects(atomicWriteFile(join(dir, 'busy'), 'x'))
    const leftovers = (await readdir(dir)).filter((name) => name.includes('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('withMemoryRootLock serializes tasks on the same root', async () => {
  const dir = await tempDir()
  try {
    let active = 0
    let maxActive = 0
    const task = () => withMemoryRootLock(dir, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
    })
    await Promise.all([task(), task(), task(), task()])
    assert.equal(maxActive, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failing locked task does not stall the queue behind it', async () => {
  const dir = await tempDir()
  try {
    const order = []
    const failing = withMemoryRootLock(dir, async () => {
      order.push('a')
      throw new Error('boom')
    })
    const after = withMemoryRootLock(dir, async () => {
      order.push('b')
    })
    await assert.rejects(failing)
    await after
    assert.deepEqual(order, ['a', 'b'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
