#!/usr/bin/env python3
"""Self-test for the MATLAB bridge driver.

Exercises the JSON-lines protocol end to end against a real MATLAB session:
engine startup, base-workspace output capture, error reporting, figure export,
and the full breakpoint stepping sequence. Run this after touching ml_driver.py,
dsh_evalbase.m or the dsh_figure_* helpers -- a failure here is unambiguously a
driver bug rather than a Cordis plugin or transport bug.

    python selftest.py            # run everything
    python selftest.py --no-debug # skip the MATLAB-starting debug half

Exits 0 when every check passes, 1 otherwise.
"""

import argparse
import itertools
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.join(HERE, "ml_driver.py")
PYLIBS = os.path.join(HERE, "pylibs")
PYEXE = sys.executable

FIXTURE = """function result = bridge_fixture()
  a = 1;
  b = 2;
  c = a + b;
  d = c * 10;
  result = d;
end
"""

failures = []


def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print("[%s] %s%s" % (status, label, (" -- " + detail) if detail else ""), flush=True)
    if not condition:
        failures.append(label)


class Driver:
    def __init__(self):
        env = dict(os.environ)
        env["PYTHONPATH"] = PYLIBS
        env["PYTHONIOENCODING"] = "utf-8"
        self.proc = subprocess.Popen(
            [PYEXE, "-u", DRIVER],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            env=env,
        )
        self.ids = itertools.count(1)
        self.chatter = []

    def call(self, op, **kw):
        req = {"id": next(self.ids), "op": op}
        req.update(kw)
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("driver died while waiting for %r" % op)
            if line.startswith("@@DSH:"):
                return json.loads(line[len("@@DSH:"):])
            self.chatter.append(line.rstrip())

    def close(self):
        try:
            self.call("shutdown")
        except Exception:  # noqa: BLE001
            pass
        try:
            self.proc.wait(timeout=30)
        except Exception:  # noqa: BLE001
            self.proc.kill()


def run_eval_checks(driver):
    started = time.time()
    resp = driver.call("start")
    check("engine starts", resp.get("ok") is True, "version=%s" % resp.get("version"))
    print("    engine start took %.1fs" % (time.time() - started), flush=True)

    resp = driver.call("eval", code="x = 41")
    out = resp.get("out", "")
    # MATLAB's display puts a newline between `x =` and the value, so compare on
    # collapsed whitespace rather than against a contiguous "x = 41".
    check("assignment echoes like the command window", "x = 41" in " ".join(out.split()), repr(out))

    resp = driver.call("eval", code="x + 1")
    out = resp.get("out", "")
    check("bare expression echoes ans", "ans" in out and "42" in out, repr(out))
    check("bare expression is not echoed twice", out.count("42") == 1, repr(out))

    resp = driver.call("eval", code="disp('hello');\ny = x * 2;\nfprintf('y=%d\\n', y);")
    check("multi-line output captured", "hello" in resp.get("out", "") and "y=82" in resp.get("out", ""), repr(resp.get("out")))

    resp = driver.call("eval", code="disp('hi')")
    check("output-less call does not error", resp.get("ok") is True and resp.get("out", "").strip() == "hi", repr(resp))

    resp = driver.call("eval", code="format short")
    check("command syntax is not treated as an expression", resp.get("ok") is True, repr(resp))

    resp = driver.call("eval", code="no_such_function_here(3)")
    check("error is reported", resp.get("ok") is False and resp.get("err"), repr(resp.get("err")))
    check("error carries a stack", bool(resp.get("stack")), repr(resp.get("stack")))

    resp = driver.call("eval", code="x")
    check("state persists across calls", "41" in resp.get("out", ""), repr(resp.get("out")))


def run_figure_checks(driver, out_dir):
    resp = driver.call(
        "eval",
        code="close all\nfigure('Visible','off')\nplot(1:5, [1 4 9 16 25], 'o-')\ntitle('selftest')\n",
    )
    check("a plot can be created", resp.get("ok") is True, repr(resp.get("err")))

    resp = driver.call("figure", action="list")
    figures = resp.get("figures", [])
    check("figure list finds the open figure", resp.get("ok") is True and len(figures) == 1, repr(resp))

    resp = driver.call("figure", action="save", dir=out_dir)
    figures = resp.get("figures", [])
    check("figure save reports one path", resp.get("ok") is True and len(figures) == 1, repr(resp))

    path = figures[0].get("path") if figures else None
    check("saved figure has no error", bool(figures) and figures[0].get("error") == "", repr(figures))
    check("exported PNG exists", bool(path) and os.path.isfile(path), repr(path))
    size = os.path.getsize(path) if path and os.path.isfile(path) else 0
    check("exported PNG is not empty", size > 1000, "%d bytes" % size)

    magic = b""
    if path and os.path.isfile(path):
        with open(path, "rb") as handle:
            magic = handle.read(8)
    check("exported file is a real PNG", magic == b"\x89PNG\r\n\x1a\n", repr(magic))

    resp = driver.call("figure", action="save", figure=99, dir=out_dir)
    check("saving a nonexistent figure is not an error",
          resp.get("ok") is True and resp.get("figures") == [], repr(resp))

    resp = driver.call("figure", action="close")
    check("close succeeds", resp.get("ok") is True, repr(resp))

    resp = driver.call("figure", action="list")
    check("no figures remain after close", resp.get("ok") is True and resp.get("figures") == [], repr(resp))
    # Rejecting an unknown action is asserted in main(), before MATLAB starts,
    # so that the same check also proves a typo does not launch the engine.


def run_debug_checks(driver, fixture_dir):
    driver.call("eval", code="addpath('%s')" % fixture_dir.replace("\\", "\\\\"))

    resp = driver.call("debug", action="break", file="bridge_fixture", line=4)
    check("breakpoint is set", resp.get("ok") is True, repr(resp))

    resp = driver.call("debug", action="run", code="bridge_fixture", waitMs=15000)
    check("run pauses at the breakpoint", resp.get("state") == "paused", repr(resp.get("state")))

    resp = driver.call("debug", action="status")
    check("status reports paused", resp.get("paused") is True, repr(resp))

    resp = driver.call("debug", action="vars")
    out = resp.get("out", "")
    check("paused frame exposes locals", "a" in out and "b" in out, repr(out))

    resp = driver.call("debug", action="get", name="a")
    check("reads a local by name", resp.get("ok") is True and resp.get("out", "").strip() == "1", repr(resp))

    resp = driver.call("debug", action="get", name="c")
    check("unassigned local is reported as an error", resp.get("ok") is False, repr(resp))

    resp = driver.call("debug", action="step")
    check("step keeps the session paused", resp.get("state") == "paused", repr(resp.get("state")))

    resp = driver.call("debug", action="get", name="c")
    check("stepping makes the next local visible", resp.get("ok") is True and resp.get("out", "").strip() == "3", repr(resp))

    resp = driver.call("debug", action="eval", code="a + b")
    check("evaluates an expression in the paused frame", resp.get("ok") is True and resp.get("out", "").strip() == "3", repr(resp))

    # Regression: _format_value once called back into MATLAB with an expression
    # naming `value`, which is a PYTHON variable -- MATLAB has no such name, so
    # every non-scalar readout leaked an error onto stderr beside its value.
    before = len(driver.chatter)
    resp = driver.call("debug", action="eval", code="[a b]")
    leaked = driver.chatter[before:]
    check("evaluating a vector in the paused frame succeeds", resp.get("ok") is True, repr(resp))
    check("a frame value readout leaks no MATLAB error to stderr",
          not any("value" in line for line in leaked), repr(leaked))

    resp = driver.call("debug", action="stack")
    check("stack is available while paused", resp.get("ok") is True and bool(resp.get("out")), repr(resp.get("out")))

    resp = driver.call("debug", action="continue")
    check("continue completes the run", resp.get("state") == "completed", repr(resp))

    resp = driver.call("debug", action="status")
    check("status reports not paused after continue", resp.get("paused") is False, repr(resp))

    resp = driver.call("debug", action="step")
    check("stepping outside a pause is refused cleanly", resp.get("ok") is False, repr(resp))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-debug", action="store_true", help="skip checks that start MATLAB")
    args = parser.parse_args()

    if not os.path.isdir(PYLIBS):
        print("engine libs missing at %s -- run setup_engine.ps1 first" % PYLIBS, flush=True)
        return 1

    with tempfile.TemporaryDirectory(prefix="dsh-matlab-selftest-") as tmp:
        with open(os.path.join(tmp, "bridge_fixture.m"), "w", encoding="utf-8", newline="\n") as handle:
            handle.write(FIXTURE)

        driver = Driver()
        try:
            resp = driver.call("ping")
            check("driver answers ping", resp.get("ok") is True, repr(resp))
            check("engine is lazy before first use", resp.get("engineRunning") is False, repr(resp))

            # Rejecting an unknown action must not pay a MATLAB launch. These
            # run before any check that starts the engine, so "still lazy" is a
            # meaningful assertion rather than a restatement of "already up".
            resp = driver.call("debug", action="nonsense")
            check("an invalid debug action is rejected", resp.get("ok") is False, repr(resp))
            resp = driver.call("figure", action="nonsense")
            check("an invalid figure action is rejected", resp.get("ok") is False, repr(resp))
            resp = driver.call("ping")
            check("a rejected action does not launch MATLAB", resp.get("engineRunning") is False, repr(resp))

            run_eval_checks(driver)
            run_figure_checks(driver, tmp)
            if not args.no_debug:
                run_debug_checks(driver, tmp)
        finally:
            driver.close()

    print(flush=True)
    if failures:
        print("SELFTEST FAILED: %d check(s): %s" % (len(failures), ", ".join(failures)), flush=True)
        return 1
    print("SELFTEST PASSED", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
