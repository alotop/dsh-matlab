#!/usr/bin/env node
/**
 * Lay out the MATLAB Engine for Python runtime that ships with a local MATLAB
 * installation, so the bridge driver can `import matlab.engine`.
 *
 * WHY THIS STEP EXISTS
 * The engine is not on PyPI for this MATLAB release, and it is MathWorks code
 * that must not be redistributed. So the package ships without it and this
 * script copies it out of the MATLAB installation the user already has.
 *
 * WHY NOT `pip install`
 * The bundled engine advertises Python 3.9-3.12 and ships a stable-ABI (`abi3`)
 * extension module. On Windows its `setup.py` also generates an `_arch.txt`
 * that tells the engine where MATLAB's `bin` and `extern/bin` DLL directories
 * are. A directory copy plus that generated file is exactly what the wheel
 * would have produced, without needing a build toolchain.
 *
 * Usage:
 *   node scripts/setup-engine.mjs
 *   node scripts/setup-engine.mjs --matlab-root <matlab-root>
 *   node scripts/setup-engine.mjs --python python3.12 --force
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEST = join(PACKAGE_ROOT, 'python', 'pylibs')

/** MATLAB's own architecture directory names, keyed by platform. */
function archDirFor(platform, arch) {
  if (platform === 'win32') return 'win64'
  if (platform === 'linux') return 'glnxa64'
  if (platform === 'darwin') return arch === 'arm64' ? 'maca64' : 'maci64'
  return null
}

function parseArgs(argv) {
  const options = { matlabRoot: null, python: null, force: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--force' || arg === '-f') options.force = true
    else if (arg === '--matlab-root') options.matlabRoot = argv[++i] ?? null
    else if (arg === '--python') options.python = argv[++i] ?? null
    else if (arg.startsWith('--matlab-root=')) options.matlabRoot = arg.slice('--matlab-root='.length)
    else if (arg.startsWith('--python=')) options.python = arg.slice('--python='.length)
    else throw new Error('unknown argument: ' + arg)
  }
  return options
}

/** Locate an executable by scanning PATH, without assuming a shell. */
function findOnPath(names) {
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const name of names) {
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

/** Release directories worth probing under a platform's install root. */
function defaultInstallRoots() {
  if (process.platform === 'win32') {
    const roots = []
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (base) roots.push(join(base, 'MATLAB'))
    }
    return roots
  }
  if (process.platform === 'darwin') return ['/Applications']
  return ['/usr/local/MATLAB', '/opt/MATLAB', '/usr/local']
}

/**
 * Pick the newest release directory under one install root. Names sort
 * lexicographically well enough for `R2023b`-style releases, and a plain
 * version directory is accepted too.
 */
function newestRelease(root, matcher) {
  if (!existsSync(root)) return null
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && matcher(entry.name))
    .map((entry) => entry.name)
    .sort()
  if (entries.length === 0) return null
  return join(root, entries[entries.length - 1])
}

function findMatlabRoot(explicit) {
  if (explicit) return explicit
  if (process.env.MATLAB_ROOT) return process.env.MATLAB_ROOT

  // A `matlab` on PATH resolves to <root>/bin/matlab[.exe].
  const exe = findOnPath(['matlab'])
  if (exe !== null) {
    const root = dirname(dirname(exe))
    if (existsSync(join(root, 'extern', 'engines', 'python'))) return root
  }

  for (const base of defaultInstallRoots()) {
    if (process.platform === 'darwin') {
      const app = newestRelease(base, (n) => n.startsWith('MATLAB_R'))
      if (app !== null) return app
    } else {
      const release = newestRelease(base, (n) => /^R\d{4}[ab]$/.test(n) || /^\d/.test(n))
      if (release !== null) return release
    }
  }
  return null
}

function findPython(explicit) {
  if (explicit) return explicit
  return findOnPath(['python3', 'python'])
}

/**
 * Run a Python program and read back what it wrote to a temp file.
 *
 * Capturing a child's output through a PIPE is deliberately avoided: DSH runs
 * commands inside a file sandbox that refuses named pipes, so the usual
 * `execFileSync(..., { stdio: 'pipe' })` fails with EPERM there. `inherit`
 * needs no pipe, and the child's own traceback still reaches the terminal.
 */
function runPython(python, program) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-matlab-setup-'))
  const outFile = join(dir, 'result.txt')
  const full = [
    program,
    'open(' + JSON.stringify(outFile) + ', "w", encoding="utf-8").write(RESULT)',
  ].join('\n')
  const result = spawnSync(python, ['-c', full], { stdio: 'inherit' })
  let text = null
  try {
    text = readFileSync(outFile, 'utf8')
  } catch {
    text = null
  }
  rmSync(dir, { recursive: true, force: true })
  return { status: result.status, text }
}

/** Major/minor version of an interpreter, or null when it will not run. */
function pythonVersion(python) {
  const result = runPython(python, 'import sys\nRESULT = "%d.%d" % sys.version_info[:2]')
  return result.status === 0 && result.text !== null ? result.text.trim() : null
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/setup-engine.mjs [--matlab-root DIR] [--python EXE] [--force]')
    return 0
  }

  const arch = archDirFor(process.platform, process.arch)
  if (arch === null) {
    throw new Error('unsupported platform: ' + process.platform + '/' + process.arch)
  }

  const matlabRoot = findMatlabRoot(options.matlabRoot)
  if (matlabRoot === null) {
    throw new Error('could not find a MATLAB installation. Pass --matlab-root <dir> or set MATLAB_ROOT.')
  }
  const engineSource = join(matlabRoot, 'extern', 'engines', 'python', 'dist', 'matlab')
  if (!existsSync(engineSource)) {
    throw new Error('no bundled Python engine under ' + matlabRoot
      + '. MATLAB ships it in extern/engines/python; check that this install is complete.')
  }

  if (existsSync(DEST) && !options.force) {
    console.log('engine runtime already present at ' + DEST)
    console.log('re-run with --force to lay it out again')
  } else {
    await rm(DEST, { recursive: true, force: true })
    await mkdir(DEST, { recursive: true })
    await cp(engineSource, join(DEST, 'matlab'), { recursive: true })
    // The four lines engine/__init__.py reads to find MATLAB's native
    // libraries: architecture, bin, the engine's own module dir, extern/bin.
    const archFile = [
      arch,
      join(matlabRoot, 'bin', arch),
      join(DEST, 'matlab', 'engine', arch),
      join(matlabRoot, 'extern', 'bin', arch),
    ].join('\n') + '\n'
    await writeFile(join(DEST, 'matlab', 'engine', '_arch.txt'), archFile)
    console.log('engine runtime -> ' + DEST)
    console.log('matlab root     -> ' + matlabRoot)
    console.log('architecture    -> ' + arch)
  }

  const python = findPython(options.python)
  if (python === null) {
    console.log('')
    console.log('No Python interpreter found on PATH. The bridge will need one at run time;')
    console.log('pass --python <exe> here, or set the pythonPath option on the preset row.')
    return 0
  }

  const version = pythonVersion(python)
  console.log('')
  console.log('python          -> ' + python + (version === null ? '' : ' (' + version + ')'))

  const check = runPython(python, [
    'import sys',
    'sys.path.insert(0, ' + JSON.stringify(DEST) + ')',
    'import matlab.engine',
    'RESULT = "ok"',
  ].join('\n'))
  if (check.status !== 0 || check.text === null) {
    console.log('import check    -> FAILED (the traceback above says why)')
    return 1
  }
  console.log('import check    -> ' + check.text.trim())
  if (version !== null && !/^3\.(9|1[0-3])$/.test(version)) {
    console.log('note: the engine advertises Python 3.9-3.12; elsewhere it may need an older interpreter.')
  }
  console.log('')
  console.log('Ready. Start MATLAB from a DSH session with the matlab_session tool (action="start").')
  return 0
}

main().then(
  (code) => { process.exitCode = code },
  (error) => {
    console.error('setup-engine failed: ' + String((error && error.message) || error))
    process.exitCode = 1
  },
)
