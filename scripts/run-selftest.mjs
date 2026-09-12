#!/usr/bin/env node
/**
 * Run the Python self-test with a discovered interpreter, so `npm run selftest`
 * works the same way on every platform.
 *
 * The self-test needs a real MATLAB, and it starts one; it is not part of CI.
 *
 *   npm run selftest
 *   npm run selftest -- --no-debug
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SELFTEST = join(PACKAGE_ROOT, 'python', 'selftest.py')
const PYLIBS = join(PACKAGE_ROOT, 'python', 'pylibs')

function findPython() {
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  const suffixes = process.platform === 'win32' ? ['', '.exe'] : ['']
  for (const name of ['python3', 'python']) {
    for (const dir of dirs) {
      if (dir === '') continue
      for (const suffix of suffixes) {
        const candidate = join(dir, name + suffix)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return null
}

const python = findPython()
if (python === null) {
  console.error('no Python interpreter found on PATH')
  process.exit(1)
}
if (!existsSync(join(PYLIBS, 'matlab'))) {
  console.error('engine runtime missing; run `npm run setup` first')
  process.exit(1)
}

// Report the interpreter without capturing a pipe: DSH's file sandbox refuses
// named pipes, so `execFileSync(..., { stdio: 'pipe' })` fails with EPERM
// inside a DSH session. `inherit` needs no pipe.
console.log('python: ' + python)
const probe = spawnSync(python, ['--version'], { stdio: 'inherit' })
if (probe.status !== 0) {
  console.error('failed to run ' + python)
  process.exit(1)
}

const result = spawnSync(python, ['-W', 'ignore', SELFTEST, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: PYLIBS },
})
process.exit(result.status === null ? 1 : result.status)
