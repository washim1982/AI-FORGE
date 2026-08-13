import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { __testables } from "./agent.js";
import { assertSafeRelativePath, createSnapshot, createWorkspaceEntry, deleteWorkspaceEntry, renameWorkspaceEntry, setWorkspaceRoot, workspaceRoot } from "./workspace.js";
import type { ExecutionBrief } from "../shared/types.js";

test("workspace paths reject traversal and discussion content", () => {
  assert.equal(assertSafeRelativePath("src/client/App.tsx"), "src/client/App.tsx");
  assert.throws(() => assertSafeRelativePath("../outside.txt"), /outside|escapes/i);
  assert.throws(() => assertSafeRelativePath("discussion/notes.md"), /outside|scope/i);
  assert.throws(() => assertSafeRelativePath("src/discussion/notes.md"), /outside|scope/i);
  assert.throws(() => assertSafeRelativePath("vendor/code-oss/product.json"), /outside|scope/i);
  assert.throws(() => assertSafeRelativePath("release/application.exe"), /outside|scope/i);
});

test("Apply output must match the declared write set exactly", () => {
  const brief: ExecutionBrief = {
    version: 1,
    task_id: "task",
    snapshot_id: "snap",
    objective: "Change one file",
    evidence: [],
    changes: [{
      id: "c1",
      path: "src/example.ts",
      operation: "modify",
      intent: "Update behavior",
      preimage_sha: "abc",
      evidence_ids: ["ev1"],
      depends_on: [],
    }],
    invariants: [],
    validation: { required_checks: [], suggested_commands: [] },
    blockers: [],
    risk: { level: "low", reasons: [] },
  };

  const accepted = __testables.validateMutations({
    mutations: [{ change_id: "c1", path: "src/example.ts", operation: "modify", content: "export {};" }],
  }, brief);
  assert.equal(accepted.mutations[0].path, "src/example.ts");

  assert.throws(() => __testables.validateMutations({
    mutations: [{ change_id: "c1", path: "src/other.ts", operation: "modify", content: "" }],
  }, brief), /declared path/i);
});

test("Forge v2 planner accepts only bounded ordered tasks", () => {
  const plan = __testables.validateTaskPlan({
    tasks: [
      {
        id: "foundation",
        title: "Update foundation",
        objective: "Change the shared contract",
        scope_hint: ["src/shared/types.ts"],
        acceptance_criteria: ["The contract typechecks"],
        depends_on: [],
      },
      {
        id: "client",
        title: "Update client",
        objective: "Consume the shared contract",
        scope_hint: ["src/client/App.tsx"],
        acceptance_criteria: ["The client builds"],
        depends_on: ["foundation"],
      },
    ],
  }, "Implement Forge v2", 4);
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks[1].depends_on, ["foundation"]);

  // Non-safety fields are repaired rather than rejected so a small local model
  // is not blocked by bookkeeping. Task order, not depends_on, drives execution.
  const repaired = __testables.validateTaskPlan({
    tasks: [
      "not an object",
      { title: "Create the module", scope_hint: ["src/mod.ts", "../escape.ts"], depends_on: ["future"] },
      { objective: "Wire the module into the entry point. It must build." },
    ],
  }, "Bad plan", 4);
  assert.equal(repaired.tasks.length, 2);
  assert.deepEqual(repaired.tasks[0].depends_on, []);
  assert.deepEqual(repaired.tasks[0].scope_hint, ["src/mod.ts"]);
  assert.equal(repaired.tasks[0].acceptance_criteria.length, 1);
  assert.equal(repaired.tasks[1].title, "Wire the module into the entry point.");

  assert.throws(() => __testables.validateTaskPlan({ tasks: ["nonsense", 5] }, "Bad plan", 4), /no usable task/i);
  assert.throws(() => __testables.validateTaskPlan({ tasks: [] }, "Bad plan", 4), /at least one task/i);
});

test("Forge v2 Apply requests cannot silently widen the write set", () => {
  const brief: ExecutionBrief = {
    version: 1,
    task_id: "task",
    snapshot_id: "snap",
    objective: "Change one file",
    evidence: [],
    changes: [{ id: "c1", path: "src/example.ts", operation: "modify", intent: "Update", preimage_sha: "abc", evidence_ids: ["ev1"], depends_on: [] }],
    invariants: [],
    validation: { required_checks: [], suggested_commands: [] },
    blockers: [],
    risk: { level: "low", reasons: [] },
  };
  const snapshot = { id: "snap", createdAt: new Date(0).toISOString(), files: [{ path: "src/example.ts", sha: "abc", size: 1 }] };
  const context = __testables.validateApplyOutcome({ status: "context_request", queries: ["Example signature"], file_hints: ["src/example.ts"] }, brief, snapshot);
  assert.equal(context.kind, "context");
  const amendment = __testables.validateApplyOutcome({ status: "scope_amendment", paths: ["src/helper.ts"], reason: "Helper is required" }, brief, snapshot);
  assert.equal(amendment.kind, "scope");
  assert.throws(() => __testables.validateApplyOutcome({ status: "mutations", mutations: [{ change_id: "c1", path: "src/other.ts", operation: "modify", content: "" }] }, brief, snapshot), /declared path/i);
});

test("Forge v2 classifies deterministic verification failures", () => {
  assert.equal(__testables.classifyVerificationFailure({ passed: false, diagnostics: "npm run typecheck failed", commands: [] }), "type-lint");
  assert.equal(__testables.classifyVerificationFailure({ passed: false, diagnostics: "npm run test failed", commands: [] }), "test-semantic");
  assert.equal(__testables.classifyVerificationFailure({ passed: false, diagnostics: "invalid JSON", commands: [] }), "syntax");
});

test("workspace snapshots exclude generated, vendored, and discussion trees", async () => {
  const originalRoot = workspaceRoot();
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-snapshot-test-"));
  try {
    await Promise.all([
      fs.mkdir(path.join(fixtureRoot, "src"), { recursive: true }),
      fs.mkdir(path.join(fixtureRoot, "vendor", "runtime", "data"), { recursive: true }),
      fs.mkdir(path.join(fixtureRoot, "release"), { recursive: true }),
      fs.mkdir(path.join(fixtureRoot, "discussion"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(fixtureRoot, "src", "index.ts"), "export const ok = true;", "utf8"),
      fs.writeFile(path.join(fixtureRoot, "vendor", "runtime", "data", "Cookies"), "locked profile", "utf8"),
      fs.writeFile(path.join(fixtureRoot, "release", "artifact.txt"), "generated", "utf8"),
      fs.writeFile(path.join(fixtureRoot, "discussion", "notes.md"), "excluded", "utf8"),
    ]);
    await setWorkspaceRoot(fixtureRoot);
    const snapshot = await createSnapshot();
    assert.deepEqual(snapshot.files.map((file) => file.path), ["src/index.ts"]);
  } finally {
    await setWorkspaceRoot(originalRoot);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("a brief may create a file in an empty workspace", () => {
  // The reported failure: an empty folder, a request to create one file, and a
  // model that named the verb its own way. Every field the orchestrator can
  // derive must be derived rather than demanded back.
  const snapshot = { id: "snap_empty", createdAt: new Date().toISOString(), files: [] };
  const brief = __testables.validateBrief(
    {
      objective: "Create hello_world.py",
      changes: [{ id: "c1", path: "hello_world.py", operation: "add", intent: "print Hello, World!" }],
      risk: { level: "low", reasons: [] },
    },
    snapshot,
    "Create hello_world.py",
    [],
  );
  assert.equal(brief.changes.length, 1);
  assert.equal(brief.changes[0].operation, "create");
  assert.equal(brief.changes[0].path, "hello_world.py");
  assert.equal(brief.changes[0].preimage_sha, undefined);
});

test("the change verb is derived from the snapshot, never trusted blindly", () => {
  const snapshot = {
    id: "snap_one",
    createdAt: new Date().toISOString(),
    files: [{ path: "src/app.ts", sha: "a".repeat(64), size: 12 }],
  };
  const resolve = (operation: unknown, targetPath: string) => __testables.validateBrief(
    {
      objective: "x",
      changes: [{ id: "c1", path: targetPath, operation, intent: "i" }],
      risk: { level: "low", reasons: [] },
    },
    snapshot,
    "x",
    [],
  ).changes[0];

  // Wording varies; ground truth decides create versus modify.
  for (const verb of ["create", "Create", " NEW ", "add", "write", "modify", "update", "nonsense", undefined]) {
    assert.equal(resolve(verb, "src/app.ts").operation, "modify", `existing path with verb ${String(verb)}`);
    assert.equal(resolve(verb, "src/fresh.ts").operation, "create", `new path with verb ${String(verb)}`);
  }

  // A modify carries the snapshot's own hash, so the pre-Apply CAS has
  // something real to compare the live file against.
  assert.equal(resolve("modify", "src/app.ts").preimage_sha, "a".repeat(64));

  // A delete only ever happens when the model explicitly asked for one, so a
  // garbled verb can never escalate into removing a file.
  assert.equal(resolve("delete", "src/app.ts").operation, "delete");
  assert.equal(resolve("remove", "src/app.ts").operation, "delete");
  assert.throws(
    () => resolve("delete", "src/missing.ts"),
    /cannot be deleted because it is not a path in the snapshot/i,
  );
});

test("a stale preimage hash from the model does not fail the brief", () => {
  // The value is replaced by the snapshot's, and hydrateTargets plus promote
  // do the real compare-and-swap against the live file.
  const snapshot = {
    id: "snap_one",
    createdAt: new Date().toISOString(),
    files: [{ path: "src/app.ts", sha: "b".repeat(64), size: 12 }],
  };
  const brief = __testables.validateBrief(
    {
      objective: "x",
      changes: [{ id: "c1", path: "src/app.ts", operation: "modify", intent: "i", preimage_sha: "totally-wrong" }],
      risk: { level: "low", reasons: [] },
    },
    snapshot,
    "x",
    [],
  );
  assert.equal(brief.changes[0].preimage_sha, "b".repeat(64));
});

test("explorer creation refuses unsafe paths and never overwrites", async () => {
  const originalRoot = workspaceRoot();
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-create-test-"));
  try {
    await setWorkspaceRoot(fixtureRoot);

    assert.equal(await createWorkspaceEntry("notes.md", "file"), "notes.md");
    assert.equal(await fs.readFile(path.join(fixtureRoot, "notes.md"), "utf8"), "");

    // Nested paths create their parents, and a trailing slash is tolerated.
    assert.equal(await createWorkspaceEntry("src/lib/util.ts", "file"), "src/lib/util.ts");
    assert.equal(await createWorkspaceEntry("assets/icons/", "directory"), "assets/icons");
    assert.ok((await fs.stat(path.join(fixtureRoot, "assets", "icons"))).isDirectory());

    // An existing path is never blanked.
    await fs.writeFile(path.join(fixtureRoot, "keep.txt"), "precious", "utf8");
    await assert.rejects(() => createWorkspaceEntry("keep.txt", "file"), /already exists/i);
    assert.equal(await fs.readFile(path.join(fixtureRoot, "keep.txt"), "utf8"), "precious");
    await assert.rejects(() => createWorkspaceEntry("src/lib", "directory"), /already exists/i);

    // Same path gate the agent writes through.
    await assert.rejects(() => createWorkspaceEntry("../escape.txt", "file"), /outside|escapes/i);
    await assert.rejects(() => createWorkspaceEntry("node_modules/pkg/index.js", "file"), /outside|scope/i);
    await assert.rejects(() => createWorkspaceEntry("discussion/notes.md", "file"), /outside|scope/i);
    await assert.rejects(() => createWorkspaceEntry("C:/Windows/evil.txt", "file"), /workspace-relative/i);
  } finally {
    await setWorkspaceRoot(originalRoot);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("explorer rename and delete respect the workspace boundary", async () => {
  const originalRoot = workspaceRoot();
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-mutate-test-"));
  try {
    await setWorkspaceRoot(fixtureRoot);
    await createWorkspaceEntry("src/old.ts", "file");
    await fs.writeFile(path.join(fixtureRoot, "src", "old.ts"), "export const keep = 1;", "utf8");

    // Renaming preserves content and can move between folders.
    assert.equal(await renameWorkspaceEntry("src/old.ts", "src/new.ts"), "src/new.ts");
    assert.equal(await fs.readFile(path.join(fixtureRoot, "src", "new.ts"), "utf8"), "export const keep = 1;");
    await createWorkspaceEntry("lib", "directory");
    assert.equal(await renameWorkspaceEntry("src/new.ts", "lib/moved.ts"), "lib/moved.ts");

    // Refusals: missing source, occupied destination, escaping the workspace.
    await assert.rejects(() => renameWorkspaceEntry("src/new.ts", "src/other.ts"), /no longer exists/i);
    await createWorkspaceEntry("taken.txt", "file");
    await createWorkspaceEntry("also.txt", "file");
    await assert.rejects(() => renameWorkspaceEntry("also.txt", "taken.txt"), /already exists/i);
    await assert.rejects(() => renameWorkspaceEntry("also.txt", "../escaped.txt"), /outside|escapes/i);
    await assert.rejects(() => renameWorkspaceEntry("also.txt", "node_modules/sneaky.txt"), /outside|scope/i);
    await assert.rejects(() => renameWorkspaceEntry("lib", "lib/inner"), /inside itself/i);

    // Deleting removes a whole subtree, and never the workspace root.
    await createWorkspaceEntry("doomed/nested/deep.txt", "file");
    assert.equal(await deleteWorkspaceEntry("doomed"), "doomed");
    assert.equal(await pathIsPresent(path.join(fixtureRoot, "doomed")), false);
    await assert.rejects(() => deleteWorkspaceEntry("doomed"), /no longer exists/i);
    await assert.rejects(() => deleteWorkspaceEntry("../"), /workspace-relative|outside|escapes/i);
    assert.ok(await pathIsPresent(path.join(fixtureRoot, "taken.txt")));
  } finally {
    await setWorkspaceRoot(originalRoot);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function pathIsPresent(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test("the planner accepts the shapes models actually return", () => {
  const task = { title: "Create the script", objective: "Write hello.py", acceptance_criteria: ["It runs"] };

  // A bare array, the model's own wrapper key, a nested wrapper, and a single
  // unwrapped task all describe the same plan.
  for (const shape of [
    [task],
    { tasks: [task] },
    { plan: [task] },
    { steps: [task] },
    { plan: { tasks: [task] } },
    task,
  ]) {
    const plan = __testables.validateTaskPlan(shape, "Write hello.py", 4);
    assert.equal(plan.tasks.length, 1, `shape ${JSON.stringify(shape).slice(0, 40)}`);
    assert.equal(plan.tasks[0].objective, "Write hello.py");
  }

  assert.throws(() => __testables.validateTaskPlan({ tasks: [] }, "x", 4), /at least one task/i);
  assert.throws(() => __testables.validateTaskPlan({ notes: "no plan here" }, "x", 4), /at least one task/i);
});
