#!/usr/bin/env node
/**
 * Materialize this plugin's runtime dependencies from `vendor/`.
 *
 * Why this exists: the plugin is installed with a `link:` dependency, and pnpm
 * does not install the linked package's own dependencies. `@deepseek-ai/
 * schemastery` is used at module load (`index.js` builds the Config schema), so
 * a missing copy means the plugin fails to import and never mounts — exactly the
 * "cannot resolve profile bundle @dyxang/dsh-memory" failure this script
 * prevents.
 *
 * The packages are committed under `vendor/`. This script copies any that are
 * not already present into `node_modules/`. It is idempotent: when a dependency
 * is already installed, it does nothing. Copies (not symlinks) keep the plugin
 * portable across machines.
 *
 * Presence is checked on the filesystem, not with `import.meta.resolve`: Node
 * caches a failed package resolution for the life of the process, so a
 * resolve-based recheck right after copying would report a false "still
 * missing". A `node_modules/<name>/package.json` on disk is exactly what the
 * loader's own resolution needs.
 *
 * Usage:
 *   node scripts/ensure-deps.mjs          # install missing deps from vendor/
 *   node scripts/ensure-deps.mjs --check  # only verify, exit 1 if any missing
 *
 * @module dsh-memory/scripts/ensure-deps
 */

import { access, cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Runtime dependencies that must live in this plugin's `node_modules/`. */
const PACKAGES = [
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cosmokit',
  '@standard-schema/spec',
]

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const checkOnly = process.argv.includes('--check')

/**
 * @param {string} name package name.
 * @returns {Promise<boolean>} whether it is installed under this plugin.
 */
async function installed(name) {
  try {
    await access(join(pluginRoot, 'node_modules', name, 'package.json'))
    return true
  } catch {
    return false
  }
}

async function main() {
  const missing = []
  for (const name of PACKAGES) {
    if (await installed(name)) {
      console.log(`ok       ${name}`)
      continue
    }
    if (checkOnly) {
      console.error(`missing  ${name}`)
      missing.push(name)
      continue
    }
    const source = join(pluginRoot, 'vendor', name)
    const target = join(pluginRoot, 'node_modules', name)
    await rm(target, { recursive: true, force: true })
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { recursive: true })
    console.log(`vendored ${name}`)
  }

  if (missing.length > 0) {
    console.error(`\nMissing dependencies: ${missing.join(', ')}`)
    console.error('Run "node scripts/ensure-deps.mjs" (without --check), or reinstall the plugin package.')
    process.exit(1)
  }

  // Confirm every package landed. Filesystem-based, so Node's negative
  // resolution cache from the loop above cannot produce a false failure.
  const stillMissing = []
  for (const name of PACKAGES) {
    if (!(await installed(name))) stillMissing.push(name)
  }
  if (stillMissing.length > 0) {
    console.error(`\nDependencies still missing after install: ${stillMissing.join(', ')}`)
    process.exit(1)
  }
  console.log('\nAll runtime dependencies are present.')
}

main().catch((error) => {
  console.error(`ensure-deps failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
