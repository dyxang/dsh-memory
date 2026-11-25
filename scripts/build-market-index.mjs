/**
 * Build a format-1 DSH plugin market index (`market/index.json`) from
 * `package.json` and `market/plugin.json`.
 *
 * The index names the package others install, so a build refuses a `private`
 * package or an `@local/*` name: the dev copy stays private, and the release
 * copy — the same tree with a public name and `private` removed — is the one
 * that produces an index. The output is hosted at a public https URL and added
 * to DSH Discover as an index source; DSH does not crawl npm by itself.
 *
 * Run with `npm run build:market`. `SOURCE_DATE_EPOCH` (Unix seconds) makes
 * `publishTimestamp` reproducible.
 *
 * @module dsh-memory/build-market-index
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const plugin = JSON.parse(await readFile(join(root, 'market', 'plugin.json'), 'utf8'))

const name = plugin.name ?? pkg.name
if (typeof name !== 'string' || name.length === 0) throw new Error('package.json has no name')
if (pkg.private === true) {
  throw new Error('refusing to build a public market index for a private package: remove "private" from package.json')
}
if (name.startsWith('@local/')) {
  throw new Error('refusing to build: package name is @local/*; set a public npm name (for example @dyxang/dsh-memory) first')
}

const version = pkg.version
if (typeof version !== 'string' || version.length === 0) throw new Error('package.json has no version')
const publishTimestamp = Number.isFinite(Number(process.env.SOURCE_DATE_EPOCH))
  ? Number(process.env.SOURCE_DATE_EPOCH)
  : Math.floor(Date.now() / 1000)

const category = typeof plugin.category === 'string' ? plugin.category : 'memory'
const index = {
  format: 1,
  title: { en: 'dsh-memory', zh: 'dsh 记忆插件' },
  description: {
    en: 'File-based persistent agent memory for DSH: always-on rules, an on-demand MEMORY.md index, automatic extraction, and a read-only audit.',
    zh: 'DSH 的文件型持久记忆：常驻规则、按需 MEMORY.md 索引、自动抽取与只读审计。',
  },
  metadata: {
    categories: { [category]: { title: { en: 'Memory', zh: '记忆' } } },
    labels: {},
    sortKeys: {},
  },
  plugins: [
    {
      name,
      ...(plugin.title === undefined ? {} : { title: plugin.title }),
      ...(plugin.description === undefined ? {} : { description: plugin.description }),
      ...(plugin.icon === undefined ? {} : { icon: plugin.icon }),
      ...(plugin.author === undefined ? {} : { author: plugin.author }),
      ...(plugin.homepage === undefined ? {} : { homepage: plugin.homepage }),
      ...(plugin.repository === undefined ? {} : { repository: plugin.repository }),
      metadata: {
        category,
        keywords: Array.isArray(plugin.keywords)
          ? plugin.keywords
          : (Array.isArray(pkg.keywords) ? pkg.keywords : []),
        labels: [],
        sortKeys: {},
      },
      versions: [
        {
          version,
          publishTimestamp,
          source: { type: 'npm' },
          engines: typeof plugin.engines === 'object' && plugin.engines !== null
            ? plugin.engines
            : (typeof pkg.engines?.dsh === 'string' ? { dsh: pkg.engines.dsh } : {}),
        },
      ],
    },
  ],
}

const out = join(root, 'market', 'index.json')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote ${out} — ${name}@${version}`)
