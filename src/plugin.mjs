/**
 * @alotop/dsh-matlab-bridge — run and interactively debug MATLAB code from a
 * DSH session, through a persistent MATLAB Engine session.
 *
 * WHY A BRIDGE AT ALL
 * MATLAB cannot start under DSH's workspace-write file sandbox: it writes
 * outside the workspace during startup (preferences, licence cache) and dies
 * with "Fatal Startup Error: System error: File system inconsistency".
 * Relocating its preference directory does not help. Driving `matlab -batch`
 * through a shell therefore costs one sandbox escalation per call.
 *
 * This plugin spawns a driver through the unconfined `ctx.subprocess` seam
 * instead, so the escalation is paid once, and every `matlab_*` call runs
 * without approval.
 *
 * WHY A PERSISTENT ENGINE, NOT `matlab -batch`
 * `-batch` pays a ~20s cold start per call and keeps nothing: no variables, no
 * figures, no breakpoints. It also cannot single-step, because a breakpoint
 * blocks MATLAB's own command loop; stepping needs an out-of-band evaluator,
 * which is exactly what the official MATLAB Engine API provides.
 *
 *   DSH (this plugin) --ctx.subprocess.spawn--> python ml_driver.py
 *                                                | matlab.engine
 *                                                v persistent, debuggable MATLAB
 *
 * PROTOCOL
 * The engine forwards the MATLAB command window to the driver's stdout, so the
 * JSON protocol is line-prefixed with `@@DSH:`; every unprefixed line is MATLAB
 * chatter and is surfaced as diagnostics rather than parsed.
 *
 * PATH RESOLUTION
 * Everything the plugin needs ships inside this package, so nothing is
 * hardcoded to one machine:
 *   - the driver and its MATLAB helpers are located relative to this module
 *     via `import.meta.url`;
 *   - the working directory defaults to the calling session's cwd;
 *   - the Python interpreter is discovered on PATH, or set explicitly with the
 *     row's `pythonPath` option.
 *
 * This row publishes NO service -- it only registers tools -- so it may sit
 * loose in a preset and needs no `isolate` realm.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'matlab-bridge'

/** The subprocess seam and the tool registry must exist before registering. */
export const inject = ['subprocess', 'tools']

/** Package root, so the driver ships with the plugin instead of a fixed path. */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DRIVER_PATH = join(PACKAGE_ROOT, 'python', 'ml_driver.py')
const PYLIBS_PATH = join(PACKAGE_ROOT, 'python', 'pylibs')

/**
 * Interpreter names to try, in order. `python3` first because a bare `python`
 * on macOS and Linux may still be a Python 2 shim.
 */
const PYTHON_CANDIDATES = ['python3', 'python']

const PROTOCOL_PREFIX = '@@DSH:'
const MAX_CHATTER_LINES = 40
const DEFAULT_TIMEOUT_MS = 180000

/** Shared output contract: the tool returns one text block. */
function toolOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  }
}

/** Trailing whitespace and NULs from MATLAB output are pure noise. */
function trimEnd(value) {
  return String(value).replace(/[\s\0]+$/, '')
}

/** Render an `eval` reply as the model-facing text block. */
function formatEval(resp) {
  const lines = []
  if (resp.out) lines.push(trimEnd(resp.out))
  if (resp.err) {
    lines.push('MATLAB error: ' + resp.err)
    if (resp.stack) lines.push('error stack:\n' + trimEnd(resp.stack))
  }
  if (Array.isArray(resp.chatter) && resp.chatter.length > 0) {
    lines.push('matlab stderr:\n' + resp.chatter.join('\n'))
  }
  if (lines.length === 0) lines.push('(no output)')
  return lines.join('\n')
}

/** Render a `debug` reply as the model-facing text block. */
function formatDebug(action, resp) {
  if (resp.ok === false) return 'matlab_debug ' + action + ' failed: ' + (resp.err || 'unknown error')
  const lines = []
  if (resp.state !== undefined) lines.push('state: ' + resp.state)
  if (resp.paused !== undefined) lines.push('paused: ' + resp.paused)
  if (resp.running !== undefined) lines.push('running: ' + resp.running)
  if (resp.out) lines.push(trimEnd(resp.out))
  if (resp.stack) lines.push('stack:\n' + trimEnd(resp.stack))
  if (resp.err) lines.push('error: ' + resp.err)
  if (Array.isArray(resp.chatter) && resp.chatter.length > 0) {
    lines.push('matlab stderr:\n' + resp.chatter.join('\n'))
  }
  if (lines.length === 0) lines.push('ok')
  return lines.join('\n')
}

/** Render a `figure` reply as the model-facing text block. */
function formatFigure(action, resp) {
  if (resp.ok === false) return 'matlab_figure ' + action + ' failed: ' + (resp.err || 'unknown error')
  const figures = Array.isArray(resp.figures) ? resp.figures : []

  if (action === 'list') {
    if (figures.length === 0) return 'no figures are open'
    return figures
      .map((f) => 'figure ' + f.number + (f.name ? ' "' + f.name + '"' : '') + ' [' + f.visible + ']')
      .join('\n')
  }

  if (action === 'save') {
    if (figures.length === 0) return 'no figures are open; nothing to export'
    const lines = []
    const exported = []
    for (const f of figures) {
      if (f.error) {
        lines.push('figure ' + f.number + ': export FAILED -- ' + f.error)
      } else {
        lines.push('figure ' + f.number + ' -> ' + f.path)
        exported.push(f.path)
      }
    }
    // Name the exported files explicitly: the caller must read them back with
    // read_image, and a bare path list makes that step easy to skip.
    if (exported.length > 0) {
      lines.push('', 'Read each PNG with the read_image tool: ' + exported.join(', '))
    }
    return lines.join('\n')
  }

  if (action === 'close') return 'figures closed'
  return 'ok'
}

/** Register the MATLAB tools and own the driver process for this mount. */
export function apply(ctx, config) {
  const configuredPython = typeof config?.pythonPath === 'string' && config.pythonPath.length > 0
    ? config.pythonPath
    : null
  const configuredWorkDir = typeof config?.workDir === 'string' && config.workDir.length > 0
    ? config.workDir
    : null
  const configuredFigureDir = typeof config?.figureDir === 'string' && config.figureDir.length > 0
    ? config.figureDir
    : null
  const timeoutMs = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : DEFAULT_TIMEOUT_MS

  /** The calling session's cwd, learned from the first tool call. */
  let sessionCwd = null
  let resolvedPython = null

  let handle = null
  let driverStart = null
  let nextId = 1
  let buffer = ''
  let chatter = []
  let lastExit = null
  const pending = new Map()

  /** Prefer the session cwd so script-relative paths behave as the user expects. */
  function workDir() {
    return sessionCwd || configuredWorkDir || process.cwd()
  }

  function figureDir() {
    return configuredFigureDir || join(workDir(), '.matlab-figures')
  }

  function rememberSession(exec) {
    const cwd = exec?.agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) sessionCwd = cwd
  }

  /**
   * Whether DSH shutting down also quits MATLAB. On by default: the driver is
   * a child process, and killing it hard leaves the MATLAB engine it started
   * with no owner.
   */
  const shutdownOnExit = config?.shutdownEngineOnExit !== false

  function setupScriptPath() {
    return join(PACKAGE_ROOT, 'scripts', 'setup-engine.mjs')
  }

  /**
   * Report the interpreter the driver actually runs on. A machine can carry
   * several (a system Python and a conda one, say), and the one that resolves
   * first is not necessarily the one that was verified during setup, so seeing
   * it is the difference between a five-second diagnosis and a long one.
   */
  async function pythonLine() {
    try {
      return 'python: ' + (await resolvePython())
    } catch (error) {
      return 'python: NOT FOUND - ' + String((error && error.message) || error)
    }
  }

  /** Shared by the `matlab_session` tool and the /matlab-status command. */
  async function statusReport() {
    const runtimePresent = existsSync(join(PYLIBS_PATH, 'matlab'))
    const lines = [
      'package: ' + PACKAGE_ROOT,
      await pythonLine(),
      'driver: ' + (handle === null ? 'not running' : 'running'),
      'engine runtime: ' + (runtimePresent ? 'present' : 'MISSING'),
      'quit MATLAB on exit: ' + (shutdownOnExit ? 'yes' : 'no'),
    ]
    if (!runtimePresent) {
      lines.push('', 'Lay it out with /matlab-setup, or: node ' + JSON.stringify(setupScriptPath()))
    }
    if (handle === null) {
      lines.push('matlab: not started')
      return lines.join('\n')
    }
    const resp = await rpc('ping', {}, 30000)
    lines.push('matlab: ' + (resp.engineRunning ? 'running' : 'not started'))
    return lines.join('\n')
  }

  /** Shared by the `matlab_session` tool and the /matlab-stop command. */
  async function stopEngine() {
    if (handle === null) return 'no MATLAB session is running'
    try {
      await rpc('shutdown', {}, 60000)
    } catch {
      // The driver exits as part of shutdown, so a dropped reply is expected.
    }
    try {
      handle.terminate()
    } catch {
      // Already gone.
    }
    handle = null
    pending.clear()
    return 'MATLAB session stopped'
  }

  /** Shared by the `matlab_session` tool and the /matlab-start command. */
  async function startEngine() {
    const resp = await rpc('start', {}, timeoutMs)
    if (resp.ok === false) return 'MATLAB failed to start: ' + resp.err
    return 'MATLAB ' + (resp.version || '') + ' started'
  }

  /** Keep a command reply readable; setup output is long and mostly progress. */
  function tailLines(text, max) {
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    return lines.length <= max ? lines.join('\n') : lines.slice(-max).join('\n')
  }

  /**
   * Run the engine-layout script. Spawning it through `ctx.subprocess` matters:
   * the script writes into this package's own directory, which lies outside the
   * session workspace, and only this unconfined seam can write there — so
   * /matlab-setup works without the user opening a separate terminal.
   * `process.execPath` is the Node already running DSH, so no PATH lookup.
   */
  async function runSetup() {
    const script = setupScriptPath()
    if (!existsSync(script)) throw new Error('setup script not found at ' + script)
    const spawned = ctx.subprocess.spawn({
      argv: [process.execPath, script],
      cwd: PACKAGE_ROOT,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64000 },
        stderr: { maxBytes: 64000 },
      },
      graceMs: 10000,
    })
    const outcome = await spawned.done
    const collected = spawned.collected ?? {}
    const read = (reader) => {
      try {
        return reader === undefined ? '' : reader.readFrom(0).text
      } catch {
        return ''
      }
    }
    const text = [read(collected.stdout), read(collected.stderr)]
      .filter((part) => part.length > 0)
      .join('\n')
    const tail = tailLines(text, 20)
    if (outcome.exitCode !== 0) {
      return 'setup-engine failed (exit code ' + outcome.exitCode + ')\n' + (tail || '(no output)')
    }
    return tail || 'setup-engine finished with no output'
  }

  function pushChatter(line) {
    if (line.trim() === '') return
    chatter.push(line)
    if (chatter.length > MAX_CHATTER_LINES) chatter.splice(0, chatter.length - MAX_CHATTER_LINES)
  }

  function feed(chunk) {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line.startsWith(PROTOCOL_PREFIX)) {
        let message
        try {
          message = JSON.parse(line.slice(PROTOCOL_PREFIX.length))
        } catch {
          continue
        }
        const waiter = pending.get(message.id)
        if (waiter !== undefined) {
          pending.delete(message.id)
          waiter.resolve(message)
        }
      } else {
        pushChatter(line)
      }
    }
  }

  function failAll(reason) {
    for (const waiter of pending.values()) waiter.reject(new Error(reason))
    pending.clear()
  }

  /** Discover a usable interpreter, once per mount. */
  async function resolvePython() {
    if (resolvedPython !== null) return resolvedPython
    if (configuredPython !== null) {
      try {
        resolvedPython = await ctx.subprocess.resolveExecutable(configuredPython)
        return resolvedPython
      } catch (error) {
        throw new Error('the configured pythonPath ' + JSON.stringify(configuredPython)
          + ' could not be resolved: ' + String((error && error.message) || error))
      }
    }
    const tried = []
    for (const candidate of PYTHON_CANDIDATES) {
      try {
        resolvedPython = await ctx.subprocess.resolveExecutable(candidate)
        return resolvedPython
      } catch {
        tried.push(candidate)
      }
    }
    throw new Error('no Python interpreter found on PATH (tried ' + tried.join(', ') + '). '
      + 'Install Python 3.9-3.13, or set the `pythonPath` option on the matlab-bridge row.')
  }

  async function spawnDriver() {
    const python = await resolvePython()
    const spawned = ctx.subprocess.spawn({
      argv: [python, '-u', DRIVER_PATH],
      cwd: workDir(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 10000,
    })
    spawned.stdout.setEncoding('utf8')
    spawned.stderr.setEncoding('utf8')
    spawned.stdout.on('data', feed)
    spawned.stderr.on('data', pushChatter)
    spawned.done.then((outcome) => {
      lastExit = 'bridge driver exited with code ' + outcome.exitCode
      failAll(lastExit)
      handle = null
    }, (error) => {
      lastExit = 'bridge driver failed: ' + error.message
      failAll(lastExit)
      handle = null
    })
    handle = spawned
    buffer = ''
    return spawned
  }

  /** Start at most one driver even when several calls race for it. */
  async function ensureDriver() {
    if (handle !== null) return handle
    if (driverStart === null) {
      driverStart = spawnDriver().finally(() => { driverStart = null })
    }
    return driverStart
  }

  /**
   * Send one request and resolve with its id-matched reply. A timeout releases
   * the caller without killing MATLAB -- a slow script must not cost the
   * session -- and the late reply is simply dropped because its id is gone.
   */
  async function rpc(op, params, limit) {
    const active = await ensureDriver()
    const id = nextId
    nextId += 1
    const budget = limit === undefined ? timeoutMs : limit
    chatter = []
    const resp = await new Promise((resolve, reject) => {
      let timer = null
      // The waiter clears its own timeout, so a reply that lands just as the
      // limit fires cannot reject an already-resolved call.
      pending.set(id, {
        resolve: (value) => { if (timer !== null) clearTimeout(timer); resolve(value) },
        reject: (error) => { if (timer !== null) clearTimeout(timer); reject(error) },
      })
      try {
        active.stdin.write(JSON.stringify({ id, op, ...params }) + '\n')
      } catch (error) {
        const waiter = pending.get(id)
        pending.delete(id)
        if (waiter !== undefined) waiter.reject(new Error('could not write to the matlab bridge: ' + error.message))
        return
      }
      timer = setTimeout(() => {
        if (!pending.has(id)) return
        pending.delete(id)
        reject(new Error('matlab bridge timed out after ' + budget + 'ms' + (lastExit === null ? '' : ' (' + lastExit + ')')))
      }, budget)
    })
    if (chatter.length > 0) resp.chatter = chatter.slice()
    return resp
  }

  /** A `run` or `continue` may legitimately block on a slow MATLAB script. */
  function debugTimeout(action, waitMs) {
    if (action === 'run') return (waitMs || 8000) + timeoutMs
    if (action === 'continue' || action === 'finish') return (waitMs || 15000) + timeoutMs
    return timeoutMs
  }

  ctx.tools.register({
    name: 'matlab_run',
    description: [
      'Run MATLAB code in a persistent MATLAB session and return its command-window output.',
      '* Variables, figures and loaded data persist across calls, so later calls can build on earlier ones.',
      '* Print with disp/fprintf, or pass a single bare expression to have its value shown.',
      '* On failure the MATLAB error message and error stack are returned.',
      '* The first call starts MATLAB and takes roughly 20 seconds; later calls are immediate.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'MATLAB statements to execute, or a single expression whose value should be shown.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      rememberSession(exec)
      const resp = await rpc('eval', { code: String(args.code) })
      return { text: formatEval(resp) }
    },
  })

  ctx.tools.register({
    name: 'matlab_debug',
    description: [
      'Drive the MATLAB debugger in the persistent session: set breakpoints, run until one hits, inspect the paused frame, and step line by line.',
      '* Typical flow: action="break" (with file and line) -> action="run" (with code) -> action="vars"/"get"/"stack" -> action="step" -> action="continue".',
      '* "eval" evaluates an expression inside the paused frame, so it can confirm a hypothesis about a live local.',
      '* When run stops at a breakpoint the session stays paused; finish it with "continue" or abandon it with "quit".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'One of: break, breakError, clearBreaks, run, status, stack, vars, get, eval, step, stepIn, stepOut, continue, quit, finish.',
        },
        file: { type: 'string', description: 'For break: function or script name holding the breakpoint, e.g. myfunc.' },
        line: { type: 'number', description: 'For break: line number. Omit to stop at the function entry. A breakpoint on a comment or blank line binds to the next executable line.' },
        name: { type: 'string', description: 'For get: variable name in the paused frame.' },
        code: { type: 'string', description: 'For run: the MATLAB code to launch. For eval: the expression to evaluate in the paused frame.' },
        waitMs: { type: 'number', description: 'For run/continue/finish: how long to wait for a pause or completion before returning. Defaults to 8000 for run and 15000 otherwise.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      rememberSession(exec)
      const action = String(args.action)
      const params = { action }
      if (args.file !== undefined) params.file = String(args.file)
      if (args.line !== undefined) params.line = Number(args.line)
      if (args.name !== undefined) params.name = String(args.name)
      if (args.code !== undefined) params.code = String(args.code)
      if (args.waitMs !== undefined) params.waitMs = Number(args.waitMs)
      const resp = await rpc('debug', params, debugTimeout(action, params.waitMs))
      return { text: formatDebug(action, resp) }
    },
  })

  ctx.tools.register({
    name: 'matlab_figure',
    description: [
      'Inspect and export MATLAB figures from the persistent session.',
      '* Plot first with matlab_run; figures stay open in the session, so export afterwards.',
      '* action="save" writes each open figure to a PNG and returns the paths. Read those PNGs with the read_image tool -- the exported file is how the plot actually becomes visible.',
      '* action="list" reports which figures are open; action="close" closes one or all of them.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'One of: list, save, close.' },
        figure: { type: 'number', description: 'A figure number for save or close. Omit, or pass 0, to cover every open figure.' },
        dir: { type: 'string', description: 'Optional output directory for save. Defaults to a .matlab-figures directory under the session working directory.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      rememberSession(exec)
      const action = String(args.action)
      const params = { action }
      if (args.figure !== undefined) params.figure = Number(args.figure)
      if (args.dir !== undefined) params.dir = String(args.dir)
      else if (action === 'save') params.dir = figureDir()
      const resp = await rpc('figure', params, timeoutMs)
      return { text: formatFigure(action, resp) }
    },
  })

  ctx.tools.register({
    name: 'matlab_session',
    description: [
      'Manage the persistent MATLAB session shared by matlab_run, matlab_debug and matlab_figure.',
      '* MATLAB takes tens of seconds to start, so the session stays warm and is reused across calls.',
      '* action="status" reports whether it is up; action="stop" shuts MATLAB down and releases it.',
      '* action="start" also reports the actionable error when the engine runtime has not been laid out yet.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'One of: start, status, stop.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: toolOutput(),
    async execute(args, exec) {
      rememberSession(exec)
      const action = String(args.action)
      if (action === 'stop') return { text: await stopEngine() }
      if (action === 'status') return { text: await statusReport() }
      if (action === 'start') return { text: await startEngine() }
      return { text: 'unknown action: ' + action + ' (use start, status or stop)' }
    },
  })

  /**
   * Ask the driver to quit MATLAB, then close its stdin.
   *
   * The disposer cannot await, and killing the driver outright would orphan the
   * MATLAB process it started, because a hard kill never runs Python's atexit.
   * Writing the shutdown request and closing the pipe hands the clean exit to
   * the driver instead. Returns false when there is no usable stdin, so the
   * caller can fall back to terminate().
   */
  function requestGracefulStop(active) {
    try {
      active.stdin.write(JSON.stringify({ id: nextId, op: 'shutdown' }) + '\n')
      nextId += 1
      active.stdin.end()
      return true
    } catch {
      return false
    }
  }

  /**
   * Human entry points for the operations that do not belong on the model's
   * tool surface. `commands` is read optionally rather than injected: a
   * deployment without a command registry must still get the tools, which are
   * this plugin's whole value.
   */
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    const command = (name, description, run) => ctx.effect(() => commands.register({
      name,
      description,
      handler: async () => {
        try {
          return { kind: 'success', text: await run() }
        } catch (error) {
          return { kind: 'error', text: String((error && error.message) || error) }
        }
      },
    }))
    command('matlab-status', 'Show MATLAB bridge status: package, interpreter, driver, engine runtime.', statusReport)
    command('matlab-start', 'Start the persistent MATLAB engine session.', startEngine)
    command('matlab-stop', 'Shut down the persistent MATLAB engine session and its driver.', stopEngine)
    command('matlab-setup', 'Lay out the MATLAB Engine runtime from the local MATLAB installation.', runSetup)
  }

  // The driver owns a MATLAB process; the mount must not leak it.
  ctx.effect(() => () => {
    const active = handle
    handle = null
    failAll('matlab-bridge plugin was stopped')
    if (active === null) return
    if (shutdownOnExit && requestGracefulStop(active)) return
    try {
      active.terminate()
    } catch {
      // Nothing left to release.
    }
  })
}
