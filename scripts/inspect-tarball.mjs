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
 * WHY THE OUTPUT SHAPE IS NORMALIZED
 * `npm pack --json` changed shape without a major-version signal in the CLI:
 *
 *   npm <= 11   [ { name, entryCount, files: [{ path, size, mode }] } ]
 *   npm >= 12   { "<name>": { name, entryCount, files: [...] } }
 *
 * npm 12 passes `key: tar.name` to its logger, which wraps the record in an
 * object keyed by package name (lib/utils/tar.js). A check that only handled
 * the array form passed locally and failed on CI, which installs npm@latest.
 * findPackRecord() accepts either, and the failure path prints the keys it did
 * see so the next shape change is diagnosable from one CI log rather than a
 * source-reading session.
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

/** Find the package record inside either the array or the keyed-object shape. */
function findPackRecord(pack) {
  const hasFiles = (value) => value !== null && typeof value === 'object' && Array.isArray(value.files)
  if (Array.isArray(pack)) return pack.find(hasFiles) ?? pack[0]
  if (pack !== null && typeof pack === 'object') {
    if (hasFiles(pack)) return pack
    return Object.values(pack).find(hasFiles)
  }
  return undefined
}

let pack
try {
  pack = JSON.parse(readFileSync('pack.json', 'utf8'))
} catch (error) {
  console.error('error: could not read pack.json')
  console.error('       run `npm pack --dry-run --json > pack.json` first')
  console.error('       ' + String((error && error.message) || error))
  process.exit(1)
}

const entry = findPackRecord(pack)
if (entry === undefined) {
  console.error('error: no package record with a file list in pack.json')
  console.error('       top-level: ' + (Array.isArray(pack) ? 'array' : typeof pack))
  const keys = Array.isArray(pack) ? Object.keys(pack[0] ?? {}) : Object.keys(pack ?? {})
  console.error('       keys seen: ' + JSON.stringify(keys))
  process.exit(1)
}

const paths = entry.files.map((file) => (typeof file === 'string' ? file : file.path))
const failures = []

// The engine runtime is MathWorks code laid out from the user's own MATLAB
// installation. Redistributing it through the registry would be a licence
// problem, so this is a hard stop rather than a warning.
const leaked = paths.filter((path) => typeof path === 'string' && path.includes('pylibs'))
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

const fileCount = entry.entryCount ?? paths.length
const sizeKb = Math.round((entry.size ?? 0) / 1024)
console.log('tarball ok: ' + fileCount + ' files, ' + sizeKb + ' kB, no engine runtime')
