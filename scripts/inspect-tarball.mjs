#!/usr/bin/env node
/**
 * Validate what `npm pack` is about to publish.
 *
 * Reads the JSON that `npm pack --dry-run --json` writes to pack.json, so the
 * assertions live in one file instead of being duplicated as inline `node -e`
 * snippets in ci.yml and release.yml.
 *
 * WHY NOT AN INLINE `node -e`
 * This package is `"type": "module"`, and a recent Node 22.x began evaluating
 * `-e` input according to that field. Under ESM there is no `require`, so the
 * previous inline version died with "require is not a function" -- on CI but
 * not on the older Node used locally, which is the worst way for a check to
 * fail. A script file has an unambiguous module type and needs no shell
 * quoting either.
 *
 *   npm pack --dry-run --json > pack.json
 *   node scripts/inspect-tarball.mjs
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

/**
 * Files the runtime needs at run time. A `files` entry that drops one of these
 * installs cleanly and then fails in the user's session, which is exactly the
 * regression this list exists to catch.
 */
const REQUIRED_FILES = [
  'src/plugin.mjs',
  'cordis.patch.yml',
  'python/ml_driver.py',
  'python/mfiles/dsh_evalbase.m',
  'python/mfiles/dsh_figure_info.m',
  'python/mfiles/dsh_figure_save.m',
  'scripts/setup-engine.mjs',
]

let pack
try {
  pack = JSON.parse(readFileSync('pack.json', 'utf8'))
} catch (error) {
  console.error('error: could not read pack.json')
  console.error('       run `npm pack --dry-run --json > pack.json` first')
  console.error('       ' + String((error && error.message) || error))
  process.exit(1)
}

// `npm pack --json` emits an array; tolerate a bare object for safety.
const entry = Array.isArray(pack) ? pack[0] : pack
if (entry === undefined || !Array.isArray(entry.files)) {
  console.error('error: pack.json did not describe a packaged file list')
  process.exit(1)
}

const paths = entry.files.map((file) => file.path)
const failures = []

// The engine runtime is MathWorks code laid out from the user's own MATLAB
// installation. Redistributing it through the registry would be a licence
// problem, so this is a hard stop rather than a warning.
const leaked = paths.filter((path) => path.includes('pylibs'))
if (leaked.length > 0) {
  failures.push('engine runtime must not be published: ' + leaked.join(', '))
}

const missing = REQUIRED_FILES.filter((path) => !paths.includes(path))
if (missing.length > 0) {
  failures.push('package is missing required files: ' + missing.join(', '))
}

if (failures.length > 0) {
  for (const failure of failures) console.error('error: ' + failure)
  process.exit(1)
}

const sizeKb = Math.round(entry.size / 1024)
console.log('tarball ok: ' + entry.entryCount + ' files, ' + sizeKb + ' kB, no engine runtime')
