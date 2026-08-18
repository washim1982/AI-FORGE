# Forge — Local Agent IDE

Forge v2 is a native Windows coding-assistant IDE for local/open-weight models. It keeps the original Forge Electron/Monaco IDE and the Code-OSS workbench as two supported shells over one local agent service. A bounded planner creates an ordered task queue; every task uses a fresh read-only **Gather** phase and a fresh constrained **Apply** phase before any verified change can be promoted.

![Forge architecture](./senior_ai_dataflow.svg)

## What is implemented

- Electron + React + Monaco Windows IDE with native folder selection, multi-tab editing, frameless window controls, save conflict detection, local-model settings, and a live agent event timeline.
- Local adapters for **Ollama**, **LM Studio**, and **llama.cpp**. The API accepts loopback endpoints only.
- Automatic runtime discovery on ports `11434`, `1234`, and `8080`; Forge selects a model that is actually available instead of assuming a model name.
- **Auto Agent** uses one prompt box and a shared weighted router for CHAT / CREATE / FIX / RESEARCH / LEARN. Failure artifacts outweigh verbs, credible repair evidence gates creation, and low-confidence or near-tied requests ask for clarification instead of guessing. A local constrained-JSON classifier is consulted only when the free deterministic tier abstains.
- Auto Agent keeps the execution boundary narrow: CREATE and FIX delegate to transactional Agent v2, RESEARCH uses source-only read access, and CHAT / LEARN never receive workspace mutation tools.
- Strict planner output, bounded task queues, explicit acceptance criteria, and one bounded replan when aggregate verification fails.
- Repository snapshot and per-file SHA-256 preconditions.
- Bounded lexical/structural-context retrieval with focused evidence regions.
- Strict `ExecutionBrief` and mutation-set validation with one correction attempt.
- Read-only context requests and explicit scope-amendment requests; the model cannot silently widen its write set.
- Just-in-time target hydration; Apply has no search, MCP, shell, or general read capability.
- Copy-on-write staging, evidence/target CAS checks, a persistent promotion journal with recovery/rollback, and an audit log at `.forge/audit.jsonl`.
- Classified repair: fast Apply-only repair for syntax/type/lint failures and deep Gather/Apply repair for other failures.
- Persistent run manifests in `.forge/runs/`, safe suspend/resume/discard controls, and final aggregate verification across completed tasks.
- High-risk plans stop for human review. `discussion` directories are excluded from browsing, retrieval, staging, and mutation.
- A per-workspace context store at `.ai-forge/` and a context budget that sizes every prompt, so the loop runs on a small local model. See [Working with small local models](#working-with-small-local-models).

## Working with small local models

Forge is built for open-weight models running on your own machine, including
ones with a 4k–8k context window. Three mechanisms make that workable on a
repository that does not fit in any prompt.

### A workspace context store at `.ai-forge/`

Forge keeps its durable understanding of the open workspace as many small files
under `<workspace>/.ai-forge/`. Each file is small enough to drop straight into
a prompt, so the agent selects a few thousand characters of relevant context
instead of pasting a repository-scale file map.

```text
.ai-forge/
  config.json      context profile and budgets for this workspace
  project.md       the project card: stack, manifests, checks, main areas
  map/index.json   directory rollup
  map/<dir>.md     one card per module, listing files and their symbols
  files/<file>.json   per-file digest: hash, size, lines, symbols, imports
  notes/<note>.md  durable decisions, conventions, and past failures
  tasks/<run>.md   one compact journal per agent run
```

The folder follows the selected workspace, is excluded from snapshots,
retrieval, staging, and mutation, and is derived data throughout — deleting it
loses accumulated learnings but never source code. `project.md` is yours to
edit; Forge only writes it when it is missing.

`.ai-forge/` is knowledge about the workspace. It is separate from `.forge/`,
which holds transaction machinery: run manifests, promotion journals, and the
audit log. Both are per-workspace and both are gitignored by default.

After every promoted task Forge refreshes the digests for the changed files and
appends what it learned, so the next task — and the next run — start from
accumulated knowledge.

### A context budget instead of fixed prompt sizes

`.ai-forge/config.json` sets the profile for the workspace:

```json
{ "profile": "small", "contextTokens": 8192, "perChangeApply": true, "editBlocks": true }
```

Profiles are `tiny` (4k), `small` (8k), `balanced` (32k), and `large` (128k), or
set `contextTokens` directly. Every prompt the loop builds — planner, retrieval,
evidence, Apply targets, repair diagnostics — is sized from that number, so
nothing silently overflows the window and gets truncated mid-JSON.

### One bounded request per change, and anchored edits for large files

Apply runs one model request per declared change rather than one request for the
whole write set. A file within the rewrite allowance is returned whole; anything
larger is edited through anchored search/replace blocks against a numbered,
windowed view of the file:

```json
{"status":"edits","edits":[{"start_line":4,"find":"  return a - b;","replace":"  return a + b;"}]}
```

Forge applies the blocks itself. An anchor that does not resolve to exactly one
place is rejected rather than guessed at, and the model gets one correction
attempt with the closest matching region quoted back to it. This is what lets a
3B model change a 500-line file it could never re-emit.

Set `perChangeApply: false` to return to a single request for the whole write
set; that is only worth doing on a large context window.

Forge also repairs, deterministically and only where unambiguous, the output
slips small models make most: a file name printed as the first line, a markdown
fence wrapped around the body, line numbers copied back into an anchor, and a
path pasted with its `:12-40` line range. Orchestrator-owned bookkeeping — the
snapshot id, the brief version, evidence id echoes — is filled in rather than
demanded back. The gates that matter are unchanged: path safety, preimage
hashes, evidence CAS, write-set enforcement, isolated staging, and verification.

Export `FORGE_DEBUG_APPLY=1` to print what a model actually returned whenever an
Apply response is rejected. It is the fastest way to tell whether a new model is
usable.

### Inspecting and configuring the store

```text
GET  /api/context            store summary, profile, and resolved budgets
POST /api/context/refresh    re-index the workspace into .ai-forge
POST /api/context/pack       preview the context pack for a task
PUT  /api/context/config     set profile, contextTokens, perChangeApply, editBlocks
```

## Code-OSS Windows application

Forge now runs as a built-in Code-OSS workbench extension. This preserves the
existing Gather/Apply agent loop as an authenticated loopback worker while
adding the full editor workbench, integrated terminal, debugger, SCM, language
services, keybindings, and the native Extensions view.

The Forge Agent chat opens automatically in the Secondary Side Bar. It contains
runtime and model selection, a task composer, and the live Gather/Apply event
timeline. Use **Forge: Open Agent Chat** from the Command Palette if the view is
closed. Model discovery remains available in Restricted Mode; autonomous
repository operations require the open folder to be trusted.

Create or refresh the workspace-contained Windows runtime, then launch it:

```powershell
npm run code-oss:runtime
npm run code-oss:run
```

The runtime is a SHA-256-verified official VSCodium release (a Code-OSS
distribution) patched with Forge branding and the built-in Forge extension. It
is not installed system-wide. User data and extensions live under `.forge/`, so
existing Visual Studio Code, VSCodium, and Forge profiles are not changed.

The default **Auto Agent** mode in the Code-OSS composer shares the same intent
router as the original Forge shell. Explicit Chat and Agent v2 modes remain
available when you want to bypass automatic routing.

Open VSX is configured as the extension gallery. You can also use **Extensions:
Install from VSIX...** from the Command Palette or Extensions view. The
standalone Forge extension is produced at `release/forge-agent-0.5.0.vsix`.

To build directly from Microsoft's official Code-OSS source instead, install
the Windows C++ build workload including the latest x64/x86 Spectre-mitigated
libraries, then run:

```powershell
npm run code-oss:bootstrap
npm run code-oss:run
```

The bootstrap uses the shallow checkout at `vendor/code-oss`, applies
`code-oss/product-overrides.json`, and copies Forge into Code-OSS's built-in
`extensions/` directory. `npm run code-oss:sync` reapplies Forge after an
upstream update.

To create a distributable portable ZIP:

```powershell
npm run code-oss:package
npm run code-oss:installer
```

## Original Forge IDE

The original Electron/React/Monaco interface remains supported as the focused
Forge experience. It includes the Forge v2 chat, local runtime/model selection,
task plan and event timeline, suspension decisions, repository tree, editor,
runtime settings, workspace content search, Git status, trusted project checks,
file navigation history, split/maximized editing, and a command palette. Auto
Agent is the default and routes requests by intent; Chat remains conversation-
only, while Agent v2 can still be selected explicitly for autonomous coding
transactions. Code-OSS remains the full-workbench option
for debugging, terminals, language services, keybindings, and VSIX/Open VSX
extensions.

Run or package the original shell independently:

```powershell
npm run forge:desktop:dev
npm run forge:dist:win
```

Its artifacts use `Forge-Original-IDE-*` names so they cannot be confused with
the `Forge-CodeOSS-*` installer and portable ZIP.

On first launch Forge opens your Documents folder. Use the folder button beside the workspace name to choose a code repository; the last workspace is remembered.

Forge scans all supported local runtimes at startup. Ollama's service normally starts with the Ollama app. For LM Studio or a llama.cpp-compatible app, make sure its local API server is running. Open Forge Settings to see live status dots, discovered model counts, and the exact model picker.

## Run from source

Requirements: Node.js 20+ and one local inference server.

```bash
npm install
npm run code-oss:runtime
npm run desktop
```

To rebuild the Forge extension, integrate it into the local Code-OSS runtime,
and launch the workbench:

```bash
npm run desktop:dev
```

The original Forge IDE runs with `npm run forge:desktop:dev`. The Code-OSS IDE
runs with `npm run codeoss:desktop:dev` (or the compatible `desktop:dev` alias).
The browser-hosted original interface uses `npm run dev` at
[http://127.0.0.1:5173](http://127.0.0.1:5173).

Default provider endpoints:

| Provider | Endpoint | API |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434` | `/api/chat`, `/api/tags` |
| LM Studio | `http://127.0.0.1:1234` | OpenAI-compatible `/v1` |
| llama.cpp | `http://127.0.0.1:8080` | OpenAI-compatible `/v1` |

Use the gear button in Forge to choose among the automatically detected providers and models or retry a custom loopback endpoint.

To make Forge operate on another repository, start the API with an explicit workspace root:

```powershell
$env:WORKSPACE_ROOT = "C:\path\to\project"
npm run dev
```

## Layout

Explorer, editor, and agent panel are all resizable. Drag the divider between
any two columns, or focus it and use the arrow keys (hold Shift for finer
steps); double-click a divider to restore its default width. Each width is
remembered per browser profile.

The editor keeps a 320px floor, so widening a side panel can never squeeze it
out. Narrowing the window compresses the panels temporarily without discarding
the widths you chose — they come back when the window grows again.

## Branding

`assets/branding/forge-mark.svg` is the master application mark and
`assets/branding/forge-mark-line.svg` is the single-colour activity-bar mark.
Every raster icon — the Windows `.ico`, the Code-OSS tiles, the extension icon,
and the in-app rail icon — is generated from those two files:

```bash
npm run icons
```

The activity-bar icon stays vector and uses `currentColor`, because the
workbench tints it: dim when the view is closed, bright when it is open.

## Verification

```bash
npm run typecheck
npm test
npm run test:code-oss
npm run build
npm run extension:package
npm run forge:dist:win
npm run code-oss:package
npm run code-oss:installer
```

In a staged candidate workspace, Forge runs recognized trusted scripts in this order when present: `typecheck`, `lint`, `test`, and `build`. Commands suggested by a model are recorded in the brief but are never executed automatically.

Every changed `.json` file is parsed and every changed `.js`, `.mjs`, or `.cjs`
file is passed through `node --check` before any script runs. In a workspace
that has no trusted script yet — a project being created from scratch — that
parse gate is the only automatic check there is, and Forge says so in the
verification result rather than reporting that everything passed.

## Safety model

```text
task → bounded plan → task queue → fresh snapshot/Gather → validate brief
     → evidence CAS/hydration → fresh Apply → validate write set → isolated stage
     → classified verification/repair → target CAS → journaled promotion → audit
     → final aggregate verification → complete or bounded replan/suspend
```

The source workspace remains untouched when a model response is invalid, a preimage is stale, a mutation escapes its declared write set, or staged verification fails. External MCP mutation is intentionally not part of this P0 implementation.

### What a single task is judged on

A task is judged on whether it *introduces* a failure, not on whether the whole
workspace is green. Building a project takes several tasks, and an intermediate
step can legitimately leave a trusted script red — a test script committed
before the tests it runs, for example. So a script is not held against a task
when it was already failing beforehand, or when the task is what introduced the
script: a check that did not exist cannot have regressed. Forge reports this as
"Failure is not a regression" rather than as a pass.

Two things bound that leniency. Static checks on the changed files themselves
are never excused. And the run cannot complete until aggregate verification
passes over the combined result; if it does not, Forge spends its remaining
replan budget on a bounded repair task and then suspends for a human decision.
