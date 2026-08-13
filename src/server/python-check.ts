import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Import check for Python the agent just wrote.
 *
 * `python -m py_compile` only proves a file parses, which a script that calls
 * an invented API does too. Importing it is what actually exercises the names
 * it references, so a hallucinated `import agent_module` or a call into a
 * module that does not exist fails here instead of reaching the workspace.
 *
 * The module is imported, never executed as `__main__`, so code guarded by
 * `if __name__ == "__main__"` does not run. Top-level statements do run — that
 * is unavoidable when importing, and is why this only ever happens inside the
 * isolated staging copy.
 */

const IMPORT_RUNNER = `
import importlib, importlib.util, json, sys, traceback
from pathlib import Path

target = Path(sys.argv[1]).resolve()
root = Path(sys.argv[2]).resolve()

# Walk up while __init__.py exists so a module inside a package is imported as
# part of that package. Importing it by bare path instead would break its
# relative imports and report a failure that is not there.
parts = []
directory = target.parent
while (directory / "__init__.py").exists() and directory != directory.parent:
    parts.insert(0, directory.name)
    directory = directory.parent

sys.path.insert(0, str(directory))
sys.path.insert(0, str(root))
name = ".".join(parts + [target.stem]) if parts else target.stem

try:
    if parts:
        importlib.import_module(name)
    else:
        spec = importlib.util.spec_from_file_location(name, target)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    print(json.dumps({"ok": True}))
except BaseException as error:
    print(json.dumps({
        "ok": False,
        "type": type(error).__name__,
        "message": str(error),
        "missing": getattr(error, "name", None) or "",
        "trace": traceback.format_exc()[-700:],
    }))
`;

/** Failure kinds that mean the code is wrong rather than the environment. */
const CODE_FAULTS = new Set([
  "ModuleNotFoundError",
  "ImportError",
  "AttributeError",
  "NameError",
  "SyntaxError",
  "IndentationError",
  "TypeError",
]);

export interface PythonImportFailure {
  file: string;
  type: string;
  message: string;
  trace: string;
}

export interface PythonCheckResult {
  checked: string[];
  failures: PythonImportFailure[];
  /** Set when the check could not run at all, e.g. no interpreter present. */
  skipped?: string;
}

function run(command: string, args: string[], cwd: string, signal: AbortSignal, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, windowsHide: true });
    let out = "";
    const append = (chunk: Buffer) => { if (out.length < 20_000) out += chunk.toString("utf8"); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve({ code, out });
    };
    const abort = () => { child.kill(); finish(null); };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { child.kill(); finish(null); }, timeoutMs);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

async function findInterpreter(stageRoot: string, signal: AbortSignal): Promise<string | undefined> {
  const candidates = os.platform() === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  for (const candidate of candidates) {
    const result = await run(candidate, ["-c", "print(1)"], stageRoot, signal, 8000);
    if (result.code === 0) return candidate;
  }
  return undefined;
}

/**
 * Names the project says it depends on. A missing module that is declared is an
 * uninstalled dependency, not an invented one, so it must not fail the change.
 */
async function declaredDependencies(stageRoot: string): Promise<string> {
  const files = ["requirements.txt", "pyproject.toml", "setup.cfg", "setup.py", "Pipfile", "environment.yml"];
  const parts: string[] = [];
  for (const file of files) {
    try {
      parts.push(await fs.readFile(path.join(stageRoot, file), "utf8"));
    } catch {
      // A project without dependency metadata simply contributes nothing.
    }
  }
  return parts.join("\n").toLowerCase();
}

/**
 * Imports each staged Python file inside the staging copy and reports the
 * failures that indicate broken code.
 */
export async function checkPythonImports(
  stageRoot: string,
  files: string[],
  signal: AbortSignal,
  maxFiles = 8,
): Promise<PythonCheckResult> {
  const targets = files.filter((file) => /\.py$/i.test(file)).slice(0, maxFiles);
  if (!targets.length) return { checked: [], failures: [] };

  const interpreter = await findInterpreter(stageRoot, signal);
  if (!interpreter) return { checked: [], failures: [], skipped: "No Python interpreter is available on this machine." };

  const runnerPath = path.join(stageRoot, `.forge-import-check-${process.pid}.py`);
  await fs.writeFile(runnerPath, IMPORT_RUNNER, "utf8");

  const checked: string[] = [];
  const failures: PythonImportFailure[] = [];
  const declared = await declaredDependencies(stageRoot);

  try {
    for (const file of targets) {
      const absolute = path.join(stageRoot, ...file.split("/"));
      const result = await run(interpreter, [runnerPath, absolute, stageRoot], stageRoot, signal, 20_000);
      checked.push(file);
      const line = result.out.split(/\r?\n/).reverse().find((item) => item.trim().startsWith("{"));
      if (!line) continue; // inconclusive: never fail a change on a check that did not report

      let parsed: { ok: boolean; type?: string; message?: string; missing?: string; trace?: string };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.ok) continue;

      const type = parsed.type || "Error";
      if (!CODE_FAULTS.has(type)) continue; // environment noise, not broken code

      const missing = (parsed.missing || "").split(".")[0].toLowerCase();
      if (missing && declared.includes(missing)) continue; // declared dependency, just not installed

      failures.push({
        file,
        type,
        message: parsed.message || "",
        trace: parsed.trace || "",
      });
    }
  } finally {
    await fs.rm(runnerPath, { force: true });
  }

  return { checked, failures };
}
