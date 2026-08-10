import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildContextPack,
  contextStoreRoot,
  digestFor,
  ensureContextStore,
  ensureProjectCard,
  extractImports,
  extractSymbols,
  readStoreConfig,
  recordNote,
  refreshProjectIndex,
  saveStoreConfig,
  summarizeStore,
} from "./context-store.js";
import { __testables } from "./agent.js";
import { applyEditBlocks, normalizeFileContent, targetView, validateEditBlocks } from "./edit-blocks.js";
import { budgetsFor, suggestedProfileForModel, truncateForBudget } from "./model-profile.js";
import { createSnapshot, setWorkspaceRoot, workspaceRoot } from "./workspace.js";

async function withFixtureWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const originalRoot = workspaceRoot();
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "forge-context-test-"));
  try {
    await setWorkspaceRoot(fixtureRoot);
    await run(fixtureRoot);
  } finally {
    await setWorkspaceRoot(originalRoot);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

test("verification blames the change only for failures it introduced", () => {
  const failing = (command: string) => ({ command, passed: false, output: "" });
  const passing = (command: string) => ({ command, passed: true, output: "" });
  const result = (commands: ReturnType<typeof failing>[], available = commands.map((item) => item.command)) =>
    ({ passed: commands.every((item) => item.passed), diagnostics: "", commands, available });

  // Already red before the task.
  assert.equal(
    __testables.isPreExistingFailure(result([failing("npm run test")]), result([failing("npm run test")])),
    true,
  );
  // Introduced by this task, because the script did not exist before.
  assert.equal(
    __testables.isPreExistingFailure(result([failing("npm run test")]), result([], [])),
    true,
  );
  // A genuine regression: the script existed and used to pass.
  assert.equal(
    __testables.isPreExistingFailure(result([failing("npm run test")]), result([passing("npm run test")])),
    false,
  );
  // Breaking a second script is a regression even when one was already red.
  assert.equal(
    __testables.isPreExistingFailure(
      result([passing("npm run typecheck"), failing("npm run test")]),
      result([failing("npm run typecheck")], ["npm run typecheck", "npm run test"]),
    ),
    false,
  );
  // A static check on the changed file itself is never excused.
  assert.equal(
    __testables.isPreExistingFailure(
      { passed: false, diagnostics: "invalid JSON", commands: [], available: [] },
      result([failing("npm run test")]),
    ),
    false,
  );
});

test("context budgets scale with the configured window and stay ordered", () => {
  const tiny = budgetsFor(4096);
  const large = budgetsFor(131072);
  assert.ok(tiny.plannerPrompt < large.plannerPrompt);
  assert.ok(tiny.wholeFileRewriteLimit < tiny.applyTarget);
  assert.ok(tiny.evidenceRegions >= 4 && tiny.evidenceRegions <= 18);
  assert.equal(budgetsFor(10).contextTokens, 2048);
  assert.equal(suggestedProfileForModel("qwen2.5-coder:1.5b"), "tiny");
  assert.equal(suggestedProfileForModel("llama3.1:8b-instruct"), "small");
  assert.equal(truncateForBudget("abcdef", 3, "text").length <= 6, true);
});

test("edit blocks apply deterministically and reject ambiguous anchors", () => {
  const original = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
  const updated = applyEditBlocks(original, [{ find: "const b = 2;", replace: "const b = 20;" }]);
  assert.equal(updated, "const a = 1;\nconst b = 20;\nconst c = 3;\n");

  assert.throws(() => applyEditBlocks("x\nx\n", [{ find: "x", replace: "y" }]), /more than once/i);
  assert.throws(() => applyEditBlocks(original, [{ find: "const d = 4;", replace: "" }]), /did not match/i);
  assert.throws(() => applyEditBlocks(original, [{ find: "const a = 1;", replace: "const a = 1;" }]), /no change/i);
});

test("edit blocks tolerate the line endings a local model returns", () => {
  const crlf = "line one\r\nline two\r\nline three\r\n";
  const updated = applyEditBlocks(crlf, [{ find: "line two\nline three", replace: "line two\nline 3" }]);
  assert.equal(updated, "line one\r\nline two\r\nline 3\r\n");
});

test("edit blocks recover from indentation a small model got wrong", () => {
  const original = "class Invoice {\n    total() {\n        return 0;\n    }\n}\n";
  const updated = applyEditBlocks(original, [{ find: "total() {\nreturn 0;\n}", replace: "total() {\n  return 1;\n}" }]);
  assert.equal(updated, "class Invoice {\n    total() {\n      return 1;\n    }\n}\n");

  // Indentation tolerance never resolves an ambiguous anchor.
  assert.throws(
    () => applyEditBlocks("if (a) {\n  run();\n}\nif (b) {\n  run();\n}\n", [{ find: "run();", replace: "walk();" }]),
    /more than once/i,
  );
});

test("a failed anchor reports the closest region in the file", () => {
  const original = "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n";
  assert.throws(
    () => applyEditBlocks(original, [{ find: "const beta = 22;", replace: "const beta = 3;" }]),
    /closest region[\s\S]*const beta = 2;/i,
  );
  assert.throws(
    () => applyEditBlocks(original, [{ find: "totally unrelated text here", replace: "x" }]),
    /No line in the file resembles/i,
  );
});

test("edit block validation rejects unusable shapes", () => {
  assert.throws(() => validateEditBlocks([]), /non-empty array/i);
  assert.throws(() => validateEditBlocks([{ find: "  ", replace: "x" }]), /non-empty find/i);
  assert.deepEqual(validateEditBlocks([{ find: "a" }]), [{ find: "a", replace: "", startLine: undefined }]);
});

test("a line anchor resolves a find block that repeats in the file", () => {
  // The exact failure a 3.4B model produced: a correct but non-unique anchor.
  const original = [
    "export function add(a, b) {",
    "  return a - b;",
    "}",
    "",
    "export function subtract(a, b) {",
    "  return a - b;",
    "}",
    "",
  ].join("\n");

  assert.throws(() => applyEditBlocks(original, [{ find: "return a - b;", replace: "return a + b;" }]), /more than once/i);

  const anchored = applyEditBlocks(original, validateEditBlocks([
    { start_line: 2, find: "return a - b;", replace: "return a + b;" },
  ]));
  assert.match(anchored, /export function add\(a, b\) \{\n {2}return a \+ b;/);
  assert.match(anchored, /export function subtract\(a, b\) \{\n {2}return a - b;/);

  // An anchor a couple of lines off still resolves when the block is unique
  // nearby, but never picks between two equally good candidates.
  const nudged = applyEditBlocks(original, validateEditBlocks([
    { start_line: 6, find: "export function subtract(a, b) {", replace: "export function difference(a, b) {" },
  ]));
  assert.match(nudged, /export function difference\(a, b\) \{/);
  assert.throws(
    () => applyEditBlocks(original, validateEditBlocks([{ start_line: 4, find: "return a - b;", replace: "return a + b;" }])),
    /more than once/i,
  );
});

test("line numbers copied back from the numbered view are stripped", () => {
  const [block] = validateEditBlocks([{ find: "4→  return a - b;", replace: "4→  return a + b;" }]);
  assert.equal(block.find, "  return a - b;");
  assert.equal(block.replace, "  return a + b;");
  assert.equal(block.startLine, 4);
});

test("large files are shown as focused windows instead of whole contents", () => {
  const lines = Array.from({ length: 800 }, (_, index) => `const value${index} = ${index};`);
  lines[500] = "export function computeInvoiceTotal(input) { return input; }";
  const content = lines.join("\n");

  const whole = targetView(content, content.length + 10, ["invoice"]);
  assert.equal(whole.windowed, false);

  const numbered = targetView(content, 2000, ["computeinvoicetotal"], { numbered: true });
  assert.match(numbered.text, /^1→const value0 = 0;/m);
  assert.match(numbered.text, /501→export function computeInvoiceTotal/m);

  const windowed = targetView(content, 2000, ["computeinvoicetotal", "invoice"]);
  assert.equal(windowed.windowed, true);
  assert.ok(windowed.text.length <= 4000);
  assert.match(windowed.text, /computeInvoiceTotal/);
  assert.match(windowed.text, /omitted/);
  assert.equal(windowed.totalLines, 800);
});

test("whole-file output is repaired only where it is unambiguous", () => {
  // Both slips were produced by a 3.4B model asked for complete file contents.
  assert.equal(normalizeFileContent('package.json\n{"name":"x"}\n', "package.json"), '{"name":"x"}\n');
  assert.equal(normalizeFileContent('```json\n{"name":"x"}\n```', "package.json"), '{"name":"x"}');
  assert.equal(normalizeFileContent("src/slug.js\nexport const a = 1;", "src/slug.js"), "export const a = 1;");

  // A stray label naming a different file is equally invalid in a code file.
  assert.equal(normalizeFileContent("package.json:\nexport const a = 1;", "src/slug.js"), "export const a = 1;");
  // Prose may legitimately open with a file name, and a label is never the
  // only thing left in a file.
  assert.equal(normalizeFileContent("README.md\n\nDocs.", "docs/guide.md"), "README.md\n\nDocs.");
  assert.equal(normalizeFileContent("notes.txt\n", "src/a.js"), "notes.txt\n");

  // Content that merely mentions the file name is left alone.
  assert.equal(normalizeFileContent('// package.json is generated\n{}', "package.json"), '// package.json is generated\n{}');
  assert.equal(normalizeFileContent("const name = \"slug.js\";", "src/slug.js"), "const name = \"slug.js\";");
  assert.equal(normalizeFileContent("const fence = \"```\";\n", "src/a.js"), "const fence = \"```\";\n");
});

test("symbol and import extraction summarizes a source file", () => {
  const digest = digestFor(
    "src/example.ts",
    ["import { helper } from \"./helper.js\";", "export function alpha() {}", "export class Beta {}"].join("\n"),
    "sha",
    64,
  );
  assert.deepEqual(digest.symbols, ["alpha", "Beta"]);
  assert.deepEqual(digest.imports, ["./helper.js"]);
  assert.equal(digest.language, "typescript");
  assert.deepEqual(extractSymbols("def compute():\n    pass"), ["compute"]);
  assert.deepEqual(extractImports("const fs = require(\"node:fs\");"), ["node:fs"]);
});

test("the .ai-forge store is created inside the selected workspace", async () => {
  await withFixtureWorkspace(async (fixtureRoot) => {
    await ensureContextStore();
    assert.equal(contextStoreRoot(), path.join(fixtureRoot, ".ai-forge"));
    const entries = await fs.readdir(path.join(fixtureRoot, ".ai-forge"));
    for (const expected of ["config.json", "README.md", "map", "files", "notes", "tasks"]) {
      assert.ok(entries.includes(expected), `expected .ai-forge/${expected}`);
    }
    const config = await readStoreConfig();
    assert.equal(config.profile, "small");
    assert.equal(config.perChangeApply, true);
  });
});

test("indexing writes small per-directory and per-file records", async () => {
  await withFixtureWorkspace(async (fixtureRoot) => {
    await fs.mkdir(path.join(fixtureRoot, "src", "billing"), { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, "src", "billing", "invoice.ts"), "export function createInvoice() { return 1; }\n", "utf8");
    await fs.writeFile(path.join(fixtureRoot, "src", "billing", "tax.ts"), "export const TAX_RATE = 0.2;\n", "utf8");
    await fs.writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");

    await ensureContextStore();
    const snapshot = await createSnapshot();
    const index = await refreshProjectIndex(snapshot);
    assert.ok(index.directories.some((entry) => entry.dir === "src/billing"));
    await ensureProjectCard(snapshot, index);

    const summary = await summarizeStore();
    assert.ok(summary.fileDigests >= 2);
    assert.ok(summary.directoryCards >= 1);
    assert.equal(summary.indexedSnapshotId, snapshot.id);

    for (const file of await fs.readdir(path.join(fixtureRoot, ".ai-forge", "files"))) {
      const stat = await fs.stat(path.join(fixtureRoot, ".ai-forge", "files", file));
      assert.ok(stat.size <= 2600, `${file} should stay small, was ${stat.size} bytes`);
    }

    const pack = await buildContextPack({ taskText: "fix invoice tax rounding", budgetChars: 4000 });
    assert.match(pack, /Project card/);
    assert.match(pack, /src\/billing/);
    assert.ok(pack.length <= 4000);
  });
});

test("notes are recalled by relevance and bounded by the pack budget", async () => {
  await withFixtureWorkspace(async () => {
    await ensureContextStore();
    await recordNote({ kind: "failure", title: "Invoice rounding regression", paths: ["src/billing/invoice.ts"], body: "Rounding must use banker's rounding." });
    await recordNote({ kind: "decision", title: "Unrelated shipping change", paths: ["src/shipping/rates.ts"], body: "Rates come from the carrier API." });

    const pack = await buildContextPack({ taskText: "invoice rounding", budgetChars: 4000 });
    assert.match(pack, /banker's rounding/);
    assert.doesNotMatch(pack, /carrier API/);

    const tiny = await buildContextPack({ taskText: "invoice rounding", budgetChars: 40 });
    assert.ok(tiny.length <= 40);
  });
});

test("store configuration clamps to a usable context window", async () => {
  await withFixtureWorkspace(async () => {
    await ensureContextStore();
    const updated = await saveStoreConfig({ profile: "tiny" });
    assert.equal(updated.contextTokens, 4096);
    const clamped = await saveStoreConfig({ contextTokens: 1 });
    assert.equal(clamped.contextTokens, 2048);
    assert.equal((await readStoreConfig()).contextTokens, 2048);
  });
});
