# @alotop/dsh-matlab-bridge

Run and interactively debug MATLAB code from a [DSH](https://github.com/deepseek-ai) session,
through a persistent MATLAB Engine session.

[![npm](https://img.shields.io/npm/v/@alotop/dsh-matlab-bridge.svg)](https://www.npmjs.com/package/@alotop/dsh-matlab-bridge)
[![license](https://img.shields.io/npm/l/@alotop/dsh-matlab-bridge.svg)](LICENSE)

[中文文档](README.zh-CN.md)

---

## Why this exists

MATLAB cannot start under DSH's default `workspace-write` file sandbox. It writes
outside the workspace during startup (preferences, licence cache) and dies with:

```
Fatal Startup Error: System error: File system inconsistency
```

Relocating its preference directory does not help. Driving `matlab -batch`
through a shell therefore costs one sandbox escalation **per call**.

This plugin spawns its driver through the unconfined `ctx.subprocess` seam
instead, so that cost is paid once — and it keeps a MATLAB Engine session alive,
which is what makes debugging possible at all.

### Why a persistent session, not `matlab -batch`

`matlab -batch` pays a ~20 second cold start on every call and keeps nothing: no
variables, no open figures, no breakpoints. It also **cannot single-step**,
because a breakpoint blocks MATLAB's own command loop. Stepping needs an
out-of-band evaluator, which is exactly what the official MATLAB Engine API
provides.

```
DSH session ──ctx.subprocess.spawn──▶ python ml_driver.py
                                       │ matlab.engine
                                       ▼
                              persistent, debuggable MATLAB
```

## Requirements

| | |
|---|---|
| MATLAB | R2020a or newer (for `exportgraphics`). Any standard install — the Python engine under `extern/engines/python` is what this uses. |
| Python | 3.9 – 3.13 on `PATH` |
| Node.js | 20 or newer |

The bundled engine advertises Python 3.9–3.12, but it ships a stable-ABI
(`abi3`) extension module that loads and runs correctly on 3.13 as well.

## Install

```sh
# 1. install the package into your DSH profile
dsh plugin --profile <profile> add @alotop/dsh-matlab-bridge

# 2. lay out the MATLAB Engine runtime inside that installed copy
node "<profile>/node_modules/@alotop/dsh-matlab-bridge/scripts/setup-engine.mjs"

# 3. restart DSH so the new bundle layer is composed
```

Step 2 copies the engine out of the MATLAB you already have and generates the
`_arch.txt` file the engine needs to find MATLAB's native libraries. Nothing is
downloaded, and no MathWorks code is redistributed — see [LICENSE](LICENSE).

**Run step 2 against the installed copy, not a checkout.** The script writes to
`python/pylibs` beside itself, and the plugin loads the runtime from its own
installation — laying it out anywhere else leaves the installed copy empty. The
same copy also exposes the command as
`<profile>/node_modules/.bin/dsh-matlab-bridge-setup`.

### Why `dsh.bundle` is declared

`dsh plugin add` records a package as a **profile layer** only when its
`package.json` declares `dsh.bundle`. This package points that at
[`cordis.patch.yml`](cordis.patch.yml), which inserts the `matlab-bridge` row.
Without it the install still succeeds but nothing is registered, and DSH says so:
*declares no dsh.bundle — installed as a plain dependency, not a profile layer*.

### Alternative: a preset row

The same plugin can be composed from an agent preset instead of a profile
bundle. The row publishes no service and registers tools only, so it sits at the
top level of a preset and needs no `isolate` realm.

```yaml
- id: matlab-bridge
  name: '@alotop/dsh-matlab-bridge'
```

### Standalone, or from a checkout

For developing the bridge itself, or before it is on npm:

```sh
npm pack                                                       # -> alotop-dsh-matlab-bridge-<version>.tgz
npx ./alotop-dsh-matlab-bridge-<version>.tgz                   # run setup straight from the tarball
npm install -g ./alotop-dsh-matlab-bridge-<version>.tgz        # or install it globally
npm install --no-save ./alotop-dsh-matlab-bridge-<version>.tgz # or into a project
```

Pass `--no-save` when you only want to try the tarball; without it npm records a
`file:` dependency on the tarball in that project's `package.json`.

There is only **one** package. `dsh-matlab-bridge-setup` is a `bin` entry of it,
not a separate package — `npx @alotop/dsh-matlab-bridge` resolves to that
executable because it is the package's only one.

### Row options

All optional; the defaults need no configuration on a normal machine.

```yaml
- id: matlab-bridge
  name: '@alotop/dsh-matlab-bridge'
  config:
    pythonPath: python3.12        # default: first of python3, python on PATH
    workDir: /path/to/project     # default: the calling session's cwd
    figureDir: /tmp/figures       # default: <workDir>/.matlab-figures
    timeoutMs: 180000             # default: 180000
```

## Tools

### `matlab_run`

Runs MATLAB code in the persistent session and returns its command-window
output. **Variables, figures and loaded data persist across calls.** Print with
`disp`/`fprintf`, or pass a single bare expression to have its value shown. On
failure the MATLAB error message and error stack come back.

```
matlab_run: A = magic(4); disp(trace(A))
```

### `matlab_debug`

Drives the MATLAB debugger. Actions: `break`, `breakError`, `clearBreaks`,
`run`, `status`, `stack`, `vars`, `get`, `eval`, `step`, `stepIn`, `stepOut`,
`continue`, `quit`, `finish`.

A worked session:

```
matlab_debug action=break file=myfunc line=12   → ok
matlab_debug action=run   code="myfunc(data)"   → state: paused
matlab_debug action=vars                        → the paused frame's locals
matlab_debug action=get   name=startIndex       → 7
matlab_debug action=eval  code="n - k + 1"      → 8
matlab_debug action=step                        → state: paused (next line)
matlab_debug action=continue                    → state: completed
```

`eval` runs an expression inside the paused frame, so a hypothesis about a live
local can be confirmed without editing the file. A breakpoint on a comment or
blank line binds to the next executable line, exactly as in the MATLAB editor.

### `matlab_figure`

Inspects and exports figures. `list` reports open figures, `save` writes each
one to a 150 DPI PNG and returns the paths, `close` closes one or all.

Plot first with `matlab_run`, export afterwards — figures stay open in the
session. **Read the exported PNGs back with `read_image`;** a path alone shows
nothing.

### `matlab_session`

`start`, `status`, `stop`. MATLAB takes tens of seconds to start, so the session
stays warm and is reused. `status` reports the package path, whether the driver
is running, and whether the engine runtime has been laid out.

## How it works

| File | Role |
|---|---|
| `src/plugin.mjs` | The Cordis plugin: locates its own files, owns the driver process, registers the tools |
| `python/ml_driver.py` | Persistent driver. Newline-delimited JSON on stdin/stdout, owning one MATLAB Engine session |
| `python/mfiles/dsh_evalbase.m` | Evaluates in the base workspace and reproduces command-window echo semantics |
| `python/mfiles/dsh_figure_*.m` | List and export figures as JSON |
| `scripts/setup-engine.mjs` | Lays out the engine runtime from a local MATLAB |
| `python/selftest.py` | End-to-end self-test against a real MATLAB |

### The `@@DSH:` protocol prefix

The MATLAB Engine forwards the MATLAB command window to the driver's stdout, so
a bare JSON protocol would race with MATLAB's own output. Every protocol line is
prefixed with `@@DSH:`; every unprefixed line is MATLAB chatter and is surfaced
as diagnostics rather than parsed.

### Command-window echo semantics

`dsh_evalbase.m` calls `evalc('evalin(''base'', code)')` and deliberately asks
`evalin` for **no output argument**. That is what makes capture match the command
window: an assignment echoes `x = 41`, a bare expression echoes `ans = 42`, and a
statement with no value prints nothing. Asking for an output argument suppresses
all three, and guessing from the source text whether the code is an expression
misclassifies command syntax such as `dbstop in f at 4` and output-less calls
such as `disp('hi')`.

## Development

```sh
git clone https://github.com/alotop/dsh-matlab.git
cd dsh-matlab
npm run setup      # lay out the engine runtime from your local MATLAB
npm run selftest   # end-to-end checks against a real MATLAB (starts one)
npm run check      # syntax-check the plugin and scripts
```

`npm run selftest` exercises the protocol, output capture, error reporting,
figure export and the full breakpoint stepping sequence. A failure there is a
driver bug, not a plugin or transport bug, which keeps the fault domain small.

## Releasing

Publishing runs only on a version tag, and only
[`.github/workflows/release.yml`](.github/workflows/release.yml) can do it:

```sh
npm version patch        # or minor / major; commits and tags
git push --follow-tags
```

The workflow refuses to publish when the tag and `package.json` version
disagree, and refuses to publish a tarball containing the engine runtime.

Authentication is **OIDC Trusted Publishing**, so no npm token is stored in the
repository. One-time setup on npmjs.com:

1. The package must exist — do a first manual `npm publish` from a checkout.
2. Package → Settings → **Trusted Publisher** → GitHub Actions, with
   repository `alotop/dsh-matlab` and workflow `release.yml`.

After that, `id-token: write` in the workflow is the only credential needed, and
every published version carries a signed provenance attestation.

## Limitations

- **Figures are delivered as files, not inline images.** `matlab_figure` returns
  PNG paths. An inline image block would have to go through the attachments
  service to obtain an attachment reference; a path plus `read_image` already
  makes the plot visible and carries no service-contract dependency.
- **A hard-killed driver can leave MATLAB behind.** The driver quits the engine
  on `atexit`, which does not run on a hard kill. Use `matlab_session` with
  `action="stop"` to shut down cleanly.
- **Queries queue while MATLAB is busy.** The engine serializes requests on one
  thread, so a `dbstack` probe issued while a background run is mid-execution
  blocks until that run yields. `run` checks completion before probing the stack
  to avoid the worst of it.
- **Single-step debugging is Windows-verified.** The engine layout logic handles
  `glnxa64` and `maca64`/`maci64`, but only Windows has been exercised
  end-to-end. Reports from other platforms are welcome.

## License

[MIT](LICENSE). This package does not redistribute MathWorks code; see the note
at the end of the license file.
