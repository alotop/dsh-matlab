#!/usr/bin/env python3
"""DSH MATLAB bridge driver.

Owns exactly one persistent MATLAB Engine session and speaks newline-delimited
JSON on stdin/stdout.

Why every protocol line carries an `@@DSH:` prefix: the MATLAB Engine forwards
the MATLAB command window to this process's stdout, so a bare JSON protocol
would race with MATLAB's own output. Lines carrying the prefix are protocol;
every other line is MATLAB chatter that the caller can surface as diagnostics.

Request:  {"id": <int>, "op": "<name>", ...}
Response: {"id": <int>, "ok": <bool>, ...}

Ops
  ping                                  liveness + whether MATLAB is up
  start                                 launch MATLAB (idempotent)
  eval    {code}                        run code in the base workspace
  debug   {action, ...}                 breakpoints, stepping, frame inspection
  figure  {action, ...}                 list, export and close figures
  shutdown                              quit MATLAB and exit

Figure actions
  list                                  every open figure, in creation order
  save    {figure, dir}                 export to PNG; figure=0 means all
  close   {figure}                      close one figure, or all when 0

Debug actions
  break       {file, line}              dbstop in <file> at <line>
  breakError                            dbstop if error
  clearBreaks                           dbclear all
  run         {code, waitMs}            launch code; stop when it pauses or ends
  status                                paused?, stack text, future running?
  stack                                 dbstack text of the paused frame
  vars                                  whos text of the paused frame
  get         {name}                    value of NAME in the paused frame
  eval        {code}                    evaluate CODE in the paused frame
  step | stepIn | stepOut | continue    dbstep / dbcont
  quit                                  dbquit
  finish      {waitMs}                  await the outstanding run
"""

import json
import os
import sys
import time
import warnings

# The bundled engine advertises Python 3.9-3.12 and warns on 3.13. The shipped
# abi3 module loads and runs correctly on 3.13, so the warning is pure noise on
# the stderr channel the caller surfaces as diagnostics.
warnings.filterwarnings("ignore", message=".*MATLAB Engine for Python supports Python version.*")
warnings.filterwarnings("ignore", message=".*Python versions .* are supported.*")


# Import the engine without depending on the caller setting PYTHONPATH. The
# Cordis plugin spawns this file through the subprocess seam, where building a
# full environment is awkward; a self-contained driver removes that coupling.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PYLIBS = os.path.join(_HERE, "pylibs")
if os.path.isdir(_PYLIBS) and _PYLIBS not in sys.path:
    sys.path.insert(0, _PYLIBS)

# Speak protocol over the raw byte streams with an explicit encoding. The
# Windows console code page is not UTF-8, and MATLAB output here is routinely
# non-ASCII (localized error messages), so relying on the locale would corrupt
# both the JSON and the captured text.
_STDIN = sys.stdin.buffer
_STDOUT = sys.stdout.buffer

PROTOCOL_PREFIX = "@@DSH:"

# Every action op_debug implements. Kept here so an unknown action can be
# rejected before the engine is touched -- see op_debug.
DEBUG_ACTIONS = (
    "break", "breakError", "clearBreaks", "run", "status", "stack",
    "vars", "get", "eval", "step", "stepIn", "stepOut", "continue",
    "quit", "finish",
)

_engine = None
_future = None
_last_run_error = None


def emit(payload):
    """Write one protocol line. A dead pipe ends the process quietly."""
    try:
        line = PROTOCOL_PREFIX + json.dumps(payload, ensure_ascii=False)
        _STDOUT.write(line.encode("utf-8", "replace") + b"\n")
        _STDOUT.flush()
    except Exception:
        raise SystemExit(0)


def engine():
    """Return the live MATLAB engine, starting it on first use."""
    global _engine
    if _engine is None:
        try:
            import matlab.engine
        except ImportError as exc:
            # A bare ImportError here is the single most likely first-run
            # failure, and it names neither the cause nor the fix.
            raise RuntimeError(
                "the MATLAB Engine for Python runtime is not available (%s). "
                "Lay it out from your MATLAB installation first: "
                "`npx @alotop/dsh-matlab-bridge` (or `npm run setup` in a "
                "checkout). It was expected under %s." % (exc, _PYLIBS)
            )
        _engine = matlab.engine.start_matlab("-nodesktop")
        # dsh_evalbase lives beside this driver; MATLAB must be able to see it.
        helpers = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mfiles")
        _engine.addpath(helpers, nargout=0)
    return _engine


def capture(code):
    """Run CODE in the MATLAB base workspace; return (out, err, stack)."""
    result = engine().dsh_evalbase(code, nargout=1)
    out = result.get("out", "") or ""
    err = result.get("err", "") or ""
    stack = result.get("stack", "") or ""
    return out, err, stack


def control(command):
    """Run a debugger control statement; return (out, err).

    These are command-syntax statements (`dbstop in f at 4`), never expressions,
    so they bypass the base-workspace capture helper and go straight to the
    engine, which runs them with no output argument.
    """
    try:
        engine().eval(command, nargout=0)
        return "", ""
    except Exception as exc:  # noqa: BLE001
        return "", str(exc)


def dbstack_text():
    """Command-window text of the current stack, empty when not debugging."""
    try:
        return engine().eval("evalc('dbstack')", nargout=1) or ""
    except Exception as exc:  # noqa: BLE001
        return ""

def is_paused():
    return dbstack_text().strip() != ""


def await_future(wait_ms):
    """Wait up to WAIT_MS for the outstanding run; return its outcome string."""
    global _future, _last_run_error
    if _future is None:
        return "no-run"
    deadline = time.time() + (wait_ms / 1000.0)
    while time.time() < deadline:
        if _future.done():
            try:
                _future.result()
                _future = None
                return "completed"
            except Exception as exc:  # noqa: BLE001
                _last_run_error = str(exc)
                _future = None
                return "failed"
        time.sleep(0.05)
    return "running"


def op_eval(req):
    code = req.get("code", "")
    if not code.strip():
        return {"ok": True, "out": "", "err": "", "stack": ""}
    out, err, stack = capture(code)
    return {"ok": err == "", "out": out, "err": err, "stack": stack}


def op_debug(req):
    global _future, _last_run_error
    action = req.get("action", "")
    # Validate before touching the engine: a typo must not pay a ~20s MATLAB
    # launch, which is otherwise a very expensive way to learn you misspelled
    # an action.
    if action not in DEBUG_ACTIONS:
        return {"ok": False, "err": "unknown debug action: %s" % action}
    eng = engine()

    if action == "break":
        name = (req.get("file") or "").strip()
        if not name:
            return {"ok": False, "err": "debug break requires 'file'"}
        line = req.get("line")
        command = "dbstop in %s at %d" % (name, int(line)) if line else "dbstop in %s" % name
        out, err = control(command)
        return {"ok": err == "", "out": out, "err": err}

    if action == "breakError":
        out, err = control("dbstop if error")
        return {"ok": err == "", "out": out, "err": err}

    if action == "clearBreaks":
        out, err = control("dbclear all")
        return {"ok": err == "", "out": out, "err": err}

    if action == "run":
        code = (req.get("code") or "").strip()
        if not code:
            return {"ok": False, "err": "debug run requires 'code'"}
        wait_ms = int(req.get("waitMs") or 8000)
        _last_run_error = None
        _future = eng.eval(code, background=True, nargout=0)
        deadline = time.time() + (wait_ms / 1000.0)
        while time.time() < deadline:
            # Check completion before probing the stack: a query issued while
            # MATLAB is busy running the background call blocks until that call
            # yields, so testing `done` first reports a fast run immediately.
            if _future.done():
                try:
                    _future.result()
                    _future = None
                    return {"ok": True, "state": "completed", "out": ""}
                except Exception as exc:  # noqa: BLE001
                    _future = None
                    return {"ok": False, "state": "failed", "err": str(exc)}
            if is_paused():
                return {"ok": True, "state": "paused", "stack": dbstack_text()}
            time.sleep(0.1)
        return {"ok": True, "state": "running", "stack": dbstack_text()}

    if action == "status":
        paused = is_paused()
        stack = dbstack_text() if paused else ""
        running = _future is not None and not _future.done()
        payload = {"ok": True, "paused": paused, "running": running, "stack": stack}
        if _future is not None and _future.done():
            payload["finished"] = True
        return payload

    if action == "stack":
        if not is_paused():
            return {"ok": False, "err": "MATLAB is not paused at a breakpoint"}
        return {"ok": True, "out": dbstack_text()}

    if action == "vars":
        if not is_paused():
            return {"ok": False, "err": "MATLAB is not paused at a breakpoint"}
        return {"ok": True, "out": eng.eval("evalc('whos')", nargout=1) or ""}

    if action in ("get", "eval"):
        if not is_paused():
            return {"ok": False, "err": "MATLAB is not paused at a breakpoint"}
        code = req.get("name") if action == "get" else req.get("code")
        if not code:
            return {"ok": False, "err": "debug %s requires a value" % action}
        try:
            value = eng.eval(str(code))
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "err": str(exc)}
        return {"ok": True, "out": _format_value(value)}

    if action in ("step", "stepIn", "stepOut", "continue", "quit"):
        if not is_paused():
            return {"ok": False, "err": "MATLAB is not paused at a breakpoint"}
        command = {
            "step": "dbstep",
            "stepIn": "dbstep in",
            "stepOut": "dbstep out",
            "continue": "dbcont",
            "quit": "dbquit",
        }[action]
        try:
            eng.eval(command, nargout=0)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "err": str(exc)}
        if action == "continue":
            outcome = await_future(int(req.get("waitMs") or 15000))
            return {"ok": True, "state": outcome, "err": _last_run_error or ""}
        if action == "quit":
            _future = None
            return {"ok": True, "state": "debug-quit"}
        return {"ok": True, "state": "paused", "stack": dbstack_text()}

    if action == "finish":
        outcome = await_future(int(req.get("waitMs") or 15000))
        return {"ok": True, "state": outcome, "err": _last_run_error or ""}

    return {"ok": False, "err": "unknown debug action: %s" % action}


def _format_value(value):
    """Render a MATLAB value as text for the model.

    Formatting happens in Python because that is where the value already lives.
    Calling back into MATLAB with `evalc('disp(value)')` would name a MATLAB
    variable `value` that does not exist, so it merely leaked a spurious
    "unrecognized function or variable 'value'" onto stderr beside a value that
    was on its way out anyway. Engine array wrappers stringify to a readable
    nested list, which is a fine rendering for a debugger readout.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        # MATLAB prints an integral double without a trailing ".0".
        return str(int(value)) if value.is_integer() else repr(value)
    return str(value)


def _load_json(payload, label):
    """Parse the JSON text a MATLAB helper returned."""
    try:
        return json.loads(payload)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("MATLAB %s returned unparsable JSON: %s" % (label, exc))


def _figure_records(payload, label):
    """Normalize a MATLAB figure payload into a list of record dicts.

    JSONENCODE emits a bare OBJECT when the struct array holds exactly one
    element and an ARRAY otherwise, so both shapes are legitimate. Iterating the
    object directly would walk its KEY names instead of its records, which is
    why this normalizes before any caller sees it.
    """
    parsed = _load_json(payload, label)
    if isinstance(parsed, dict):
        return [parsed]
    if isinstance(parsed, list):
        return [entry for entry in parsed if isinstance(entry, dict)]
    return []


def _figure_record(entry):
    """Reduce one MATLAB figure record to the scalars the caller needs."""
    if not isinstance(entry, dict):
        return {"number": None, "name": "", "visible": "", "path": "", "error": ""}
    number = entry.get("number")
    return {
        "number": int(number) if isinstance(number, (int, float)) else None,
        "name": str(entry.get("name") or ""),
        "visible": str(entry.get("visible") or ""),
        "path": str(entry.get("path") or ""),
        "error": str(entry.get("error") or ""),
    }


def op_figure(req):
    action = req.get("action", "save")
    # Validate before touching the engine: a typo must not pay a MATLAB launch.
    if action not in ("list", "save", "close"):
        return {"ok": False, "err": "unknown figure action: %s" % action}
    eng = engine()

    if action == "list":
        try:
            records = _figure_records(eng.dsh_figure_info(nargout=1), "dsh_figure_info")
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "err": str(exc)}
        return {"ok": True, "figures": [_figure_record(entry) for entry in records]}

    if action == "save":
        which = int(req.get("figure") or 0)
        directory = str(req.get("dir") or os.path.join(os.getcwd(), ".matlab-figures"))
        try:
            records = _figure_records(
                eng.dsh_figure_save(directory, float(which), nargout=1), "dsh_figure_save"
            )
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "err": str(exc)}
        return {
            "ok": True,
            "dir": directory,
            "figures": [_figure_record(entry) for entry in records],
        }

    if action == "close":
        which = int(req.get("figure") or 0)
        command = "close all" if which == 0 else "close %d" % which
        out, err = control(command)
        return {"ok": err == "", "out": out, "err": err}

    # Unreachable: the action was validated at the top of this function.
    return {"ok": False, "err": "unknown figure action: %s" % action}


def dispatch(req):
    global _engine
    op = req.get("op", "")
    if op == "ping":
        return {"ok": True, "engineRunning": _engine is not None}
    if op == "start":
        eng = engine()
        version = eng.eval("version", nargout=1)
        return {"ok": True, "version": str(version)}
    if op == "eval":
        return op_eval(req)
    if op == "debug":
        return op_debug(req)
    if op == "figure":
        return op_figure(req)
    if op == "shutdown":
        if _engine is not None:
            try:
                _engine.quit()
            except Exception:  # noqa: BLE001
                pass
            _engine = None
        emit({"id": req.get("id"), "ok": True, "state": "shutdown"})
        raise SystemExit(0)
    return {"ok": False, "err": "unknown op: %s" % op}


def main():
    for raw in _STDIN:
        line = raw.decode("utf-8-sig", "replace").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            emit({"id": None, "ok": False, "err": "bad request json: %s" % exc})
            continue
        try:
            response = dispatch(req)
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001
            response = {"ok": False, "err": "%s: %s" % (type(exc).__name__, exc)}
        response["id"] = req.get("id")
        emit(response)


if __name__ == "__main__":
    main()
