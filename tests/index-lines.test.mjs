import test from 'node:test'
import assert from 'node:assert/strict'

import { removeMemoryIndexLine, upsertMemoryIndexLine } from '../src/memory-index.js'

test('upsert replaces an existing pointer instead of duplicating it', () => {
  const first = upsertMemoryIndexLine('', { file: 'a.md', title: 'A', hook: 'one' })
  const second = upsertMemoryIndexLine(first, { file: 'a.md', title: 'A2', hook: 'two' })
  assert.equal(second.split('\n').filter((line) => line.includes('(a.md)')).length, 1)
  assert.ok(second.includes('[A2](a.md)'))
  assert.ok(!second.includes('[A](a.md)'))
})

test('an idempotent re-save does not append a second line', () => {
  const once = upsertMemoryIndexLine('', { file: 'a.md', title: 'A', hook: 'one' })
  const twice = upsertMemoryIndexLine(once, { file: 'a.md', title: 'A', hook: 'one' })
  assert.equal(twice, once)
})

test('remove drops only the matching pointer', () => {
  let text = upsertMemoryIndexLine('', { file: 'a.md', title: 'A', hook: 'one' })
  text = upsertMemoryIndexLine(text, { file: 'b.md', title: 'B', hook: 'two' })
  const next = removeMemoryIndexLine(text, 'a.md')
  assert.ok(!next.includes('(a.md)'))
  assert.ok(next.includes('(b.md)'))
})
