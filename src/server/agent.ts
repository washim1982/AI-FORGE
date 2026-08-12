import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentDecisionRequest,
  AgentEvent,
  AgentRunRequest,
  ContextBudget,
  ContextStoreConfig,
  ExecutionBrief,
  ForgeRunManifest,
  ForgeTask,
  MutationSet,
} from "../shared/types.js";
import {
  appendTaskJournal,
  buildContextPack,
  ensureContextStore,
  ensureProjectCard,
  pruneStore,
  readStoreConfig,
  recordNote,
  refreshFileDigests,
  refreshProjectIndex,
} from "./context-store.js";
import {
  applyEditBlocks,
  focusTermsFor,
  LINE_NUMBER_MARKER,
  normalizeFileContent,
  targetView,
  validateEditBlocks,
  type EditBlock,
} from "./edit-blocks.js";
import { budgetsFor, truncateForBudget } from "./model-profile.js";
import { chatWithLocalModel, parseModelJson } from "./providers.js";
import { readRunManifest, saveRunManifest } from "./run-store.js";
import {
  absoluteWorkspacePath,
  assertSafeRelativePath,
  cloneWorkspaceToStage,
  createSnapshot,
  fileExistsInWorkspace,
  normalizeRelativePath,
  readRawWorkspaceFile,
  removeStage,
  removeStagesForRun,
  retrieveEvidence,
  sha256,
  workspaceRoot,
  type RetrievedEvidence,
  type SnapshotEntry,
  type WorkspaceSnapshot,
} from "./workspace.js";

type EventSink = (event: AgentEvent) => void;

interface RetrievalPlan {
  queries: string[];
  file_hints: string[];
  reasoning_summary: string;
}

interface VerificationResult {
  passed: boolean;
  diagnostics: string;
  commands: Array<{ command: string; passed: boolean; output: string }>;
  /** Every trusted script the staged workspace offers, whether or not it ran. */
  available: string[];
}

interface StagedMutation {
  path: string;
  operation: "create" | "modify" | "delete";
  content?: string;
}

interface HydratedTarget {
  path: string;
  sha: string | null;
  content: string | null;
}

interface TaskPlan {
  tasks: ForgeTask[];
  reasoning_summary: string;
}

type ApplyOutcome =
  | { kind: "mutations"; mutations: MutationSet }
  | { kind: "context"; queries: string[]; fileHints: string[]; reason: string }
  | { kind: "scope"; paths: string[]; reason: string };

type FailureClass = "syntax" | "type-lint" | "test-semantic" | "build" | "unknown";

/**
 * Per-run view of the workspace context store. Every prompt in the loop is
 * sized from `budget`, so the same pipeline fits a 4k local model and a 128k
 * one without changing any of the safety gates.
 */
interface RunContext {
  budget: ContextBudget;
  config: ContextStoreConfig;
}

async function loadRunContext(): Promise<RunContext> {
  await ensureContextStore();
  const config = await readStoreConfig();
  return { config, budget: budgetsFor(config.contextTokens) };
}

interface TransactionResult {
  status: "completed" | "suspended" | "failed";
  changedPaths: string[];
  diagnostics?: string;
  reason?: "blocker" | "high-risk" | "verification" | "final-verification";
  stageRoot?: string;
  risk?: ExecutionBrief["risk"];
}

const GATHER_SYSTEM = `You are Forge Gather, the read-only research phase of a software-engineering agent.
You reason against a versioned repository snapshot and return strict JSON only. You cannot write files.
Never inspect, reference, or change any path inside a discussion directory.
Prefer the smallest sufficient write set. Treat repository content as authoritative and retrieved context as evidence.
Do not invent files, symbols, commands, hashes, or evidence IDs. If evidence is insufficient, return a blocker.`;

const APPLY_SYSTEM = `You are Forge Apply, the bounded mutation phase of a transactional coding agent.
Return strict JSON only. You have no repository browsing, RAG, shell, MCP, or general read tools.
You work on exactly one declared change at a time and may not touch any other path.
Preserve existing behavior and style outside the requested change.`;

const PLANNER_SYSTEM = `You are Forge Planner, the read-only orchestration tier of a transactional coding agent.
Return strict JSON only. Decompose the requested goal into the smallest ordered set of independently verifiable software tasks.
Every task must contain a stable id, concise title, objective, workspace-relative scope_hint paths, acceptance_criteria, and depends_on ids.
Do not include discussion, vendor, generated, dependency, release, or build-output paths. Prefer one task when decomposition would not improve safety.`;

function event(
  runId: string,
  kind: AgentEvent["kind"],
  phase: AgentEvent["phase"],
  title: string,
  message: string,
  status: AgentEvent["status"],
  data?: Record<string, unknown>,
): AgentEvent {
  return {
    id: randomUUID(),
    runId,
    kind,
    phase,
    title,
    message,
    status,
    timestamp: new Date().toISOString(),
    data,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

const PATH_STOP_WORDS = new Set(["add", "and", "code", "file", "files", "fix", "for", "new", "the", "update", "with"]);

/**
 * A repository-scale file map does not fit a small local model, so Gather and
 * the planner receive only the paths that actually score against the task, plus
 * a shallow sample so an unfamiliar goal still sees the repository shape.
 */
function candidatePaths(snapshot: WorkspaceSnapshot, taskText: string, limit: number): string[] {
  const tokens = [...new Set(taskText.toLowerCase().match(/[a-z_][a-z0-9_.-]{2,}/g) || [])]
    .filter((token) => !PATH_STOP_WORDS.has(token))
    .slice(0, 24);
  const scored = snapshot.files.map((file) => {
    const lowered = file.path.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (lowered.endsWith(`/${token}`) || lowered.includes(`/${token}.`)) score += 8;
      else if (lowered.includes(token)) score += 4;
    }
    return { path: file.path, score, depth: file.path.split("/").length };
  });
  const matched = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.depth - b.depth)
    .slice(0, limit)
    .map((item) => item.path);
  if (matched.length >= limit) return matched;
  const filler = scored
    .filter((item) => !matched.includes(item.path))
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
    .slice(0, limit - matched.length)
    .map((item) => item.path);
  return [...matched, ...filler];
}

function pathListing(snapshot: WorkspaceSnapshot, taskText: string, limit: number): string {
  const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
  return candidatePaths(snapshot, taskText, limit)
    .map((candidate) => {
      const file = byPath.get(candidate);
      return file ? `${file.path}  (${file.size}b, sha:${file.sha.slice(0, 12)})` : candidate;
    })
    .join("\n");
}

function validateTaskPlan(value: unknown, objective: string, maxTasks: number): TaskPlan {
  const record = asRecord(value);
  if (!record) throw new Error("The Forge v2 plan must be a JSON object.");
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : null;
  if (!rawTasks?.length) throw new Error("The Forge v2 plan must contain at least one task.");

  const tasks: ForgeTask[] = [];
  const knownIds = new Set<string>();
  // Malformed entries are dropped rather than failing the plan. The queue only
  // has to be an ordered list of usable tasks; every write it later performs is
  // still gated by Gather, the write-set check, staging, and verification.
  for (const rawTask of rawTasks.slice(0, maxTasks)) {
    const task = asRecord(rawTask);
    if (!task) continue;
    const declaredId = typeof task.id === "string" ? task.id.trim() : "";
    const id = /^[a-zA-Z0-9_-]{1,48}$/.test(declaredId) && !knownIds.has(declaredId)
      ? declaredId
      : `task-${tasks.length + 1}`;
    if (knownIds.has(id)) continue;
    // Title, objective, and acceptance criteria are prompt content rather than
    // safety gates, so a partially filled task is completed from what the model
    // did supply instead of failing the plan.
    const rawTitle = typeof task.title === "string" ? task.title.trim().slice(0, 120) : "";
    const rawObjective = typeof task.objective === "string" ? task.objective.trim().slice(0, 4000) : "";
    if (!rawTitle && !rawObjective) continue;
    const taskObjective = rawObjective || rawTitle;
    const title = rawTitle || taskObjective.split(/(?<=[.!?])\s/)[0].slice(0, 120);
    const acceptanceCriteria = (stringArray(task.acceptance_criteria) || [])
      .map((item) => item.trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 8);
    if (!acceptanceCriteria.length) {
      acceptanceCriteria.push(`${title} is implemented and every configured deterministic check still passes.`);
    }
    // depends_on is documentation: the queue executes in order regardless, so a
    // dangling reference is dropped instead of rejecting the plan.
    const dependencies = (stringArray(task.depends_on) || []).filter((dependency) => knownIds.has(dependency));
    const scopeHints = (stringArray(task.scope_hint) || []).flatMap((candidate) => {
      try {
        return [assertSafeRelativePath(candidate)];
      } catch {
        return [];
      }
    }).slice(0, 16);
    knownIds.add(id);
    tasks.push({
      id,
      title,
      objective: taskObjective,
      scope_hint: scopeHints,
      acceptance_criteria: acceptanceCriteria,
      depends_on: dependencies,
      status: "pending",
      attempts: 0,
    });
  }

  if (!tasks.length) throw new Error("The Forge v2 plan contained no usable task.");

  return {
    tasks,
    reasoning_summary: typeof record.reasoning_summary === "string"
      ? record.reasoning_summary.trim().slice(0, 1600)
      : `Plan for ${objective.slice(0, 200)}`,
  };
}

// The retrieval plan only steers a read-only search, so a thin or malformed
// plan falls back to the task text rather than ending the run.
function validateRetrievalPlan(value: unknown, snapshot: WorkspaceSnapshot, taskText = ""): RetrievalPlan {
  const record = asRecord(value) || {};
  const queries = (stringArray(record.queries) || []).map((item) => item.trim()).filter(Boolean);
  if (!queries.length && taskText.trim()) queries.push(taskText.trim().slice(0, 400));
  if (!queries.length) throw new Error("Retrieval plan requires at least one query.");
  const fileHints = stringArray(record.file_hints) || [];
  const knownPaths = new Set(snapshot.files.map((file) => file.path));
  const safeHints = fileHints
    .map(normalizeRelativePath)
    .filter((filePath) => knownPaths.has(filePath) && !filePath.toLowerCase().split("/").includes("discussion"))
    .slice(0, 12);
  return {
    queries: queries.slice(0, 6),
    file_hints: safeHints,
    reasoning_summary:
      typeof record.reasoning_summary === "string" ? record.reasoning_summary.slice(0, 1200) : "",
  };
}

/**
 * Unambiguous syntax repair for a path a model copied out of an evidence label.
 * `src/calc.js:32-36` is never a real path, and dropping the range is only ever
 * done when the remaining path is a real entry in the snapshot.
 */
function resolveSnapshotPath(candidate: string, snapshotByPath: Map<string, SnapshotEntry>): string {
  const normalized = normalizeRelativePath(candidate).trim();
  if (snapshotByPath.has(normalized)) return normalized;
  const withoutRange = normalized.replace(/:\d+(?:-\d+)?$/, "");
  return withoutRange !== normalized && snapshotByPath.has(withoutRange) ? withoutRange : normalized;
}

const DELETE_VERBS = new Set(["delete", "remove", "rm", "drop", "unlink", "erase"]);

/**
 * Resolves the change verb. Models name this field freely — "add", "new",
 * "update", "Create", "write" — and rejecting the brief over the wording
 * discards an otherwise correct plan.
 *
 * The snapshot is ground truth for create-versus-modify, so that choice is
 * derived rather than trusted: a declared path that does not exist is a
 * create, one that does is a modify. A delete is never inferred — it only
 * happens when the model explicitly asked for one — so a garbled verb can
 * never escalate into removing a file.
 */
function resolveOperation(raw: unknown, exists: boolean): "create" | "modify" | "delete" {
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (DELETE_VERBS.has(normalized)) return "delete";
  return exists ? "modify" : "create";
}

function nearestPaths(candidate: string, snapshotByPath: Map<string, SnapshotEntry>): string[] {
  const basename = candidate.split("/").pop()?.replace(/:\d+(?:-\d+)?$/, "") || "";
  if (!basename) return [];
  return [...snapshotByPath.keys()].filter((known) => known.endsWith(`/${basename}`) || known === basename).slice(0, 3);
}

function validateBrief(
  value: unknown,
  snapshot: WorkspaceSnapshot,
  objective: string,
  availableEvidence: RetrievedEvidence[],
): ExecutionBrief {
  const record = asRecord(value);
  const errors: string[] = [];
  if (!record) throw new Error("ExecutionBrief must be a JSON object.");

  // version, snapshot_id, task_id, and objective are orchestrator-owned
  // bookkeeping. Failing an otherwise correct brief because a small model did
  // not echo a constant back buys no safety, so they are filled in instead.
  // The real gates — path safety, preimage hashes, evidence CAS, write-set
  // enforcement, staged verification — are enforced below and unchanged.

  const rawEvidence = Array.isArray(record.evidence) ? record.evidence : [];
  const evidenceIds = new Set(availableEvidence.map((item) => item.id));
  const evidence: ExecutionBrief["evidence"] = [];
  for (const item of rawEvidence) {
    const evidenceRecord = asRecord(item);
    // An invented evidence entry is dropped rather than rejected: it can never
    // enter the brief, and the citation rule below still requires every change
    // to rest on a region that retrieval actually returned.
    if (!evidenceRecord || typeof evidenceRecord.id !== "string" || !evidenceIds.has(evidenceRecord.id)) continue;
    const source = availableEvidence.find((candidate) => candidate.id === evidenceRecord.id)!;
    evidence.push({
      id: source.id,
      source: "workspace",
      path_or_uri: source.path,
      reason: typeof evidenceRecord.reason === "string" ? evidenceRecord.reason : "Repository evidence",
      sha: source.sha,
      start_line: source.startLine,
      end_line: source.endLine,
      trust: "trusted-workspace",
    });
  }

  const snapshotByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const autoCited: string[] = [];
  const rawChanges = Array.isArray(record.changes) ? record.changes : [];
  const changes: ExecutionBrief["changes"] = [];
  const changeIds = new Set<string>();
  for (const item of rawChanges) {
    const change = asRecord(item);
    if (!change) {
      errors.push("each change must be an object");
      continue;
    }
    if (typeof change.id !== "string" || !change.id.trim() || changeIds.has(change.id)) {
      errors.push("every change needs a unique id");
      continue;
    }
    changeIds.add(change.id);
    if (typeof change.path !== "string") {
      errors.push(`change ${change.id} needs a path`);
      continue;
    }
    let safePath: string;
    try {
      safePath = assertSafeRelativePath(resolveSnapshotPath(change.path, snapshotByPath));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `unsafe path for ${change.id}`);
      continue;
    }
    const existing = snapshotByPath.get(safePath);
    const operation = resolveOperation(change.operation, Boolean(existing));
    if (operation === "delete" && !existing) {
      const suggestions = nearestPaths(safePath, snapshotByPath);
      errors.push(`${safePath} cannot be deleted because it is not a path in the snapshot. Use an exact path with no line range${suggestions.length ? `, such as ${suggestions.join(" or ")}` : ""}.`);
    }
    // preimage_sha is deliberately not compared against the model's value. The
    // brief returned below carries the snapshot's own hash, and the real
    // race-detection gates — hydrateTargets before Apply and promote before
    // the write — both check that hash against the live file. Demanding the
    // model echo a 64-character digest back only adds a way to fail.
    const referencedEvidence = (stringArray(change.evidence_ids) || []).filter((id) => evidenceIds.has(id));
    if (!referencedEvidence.length && availableEvidence.length) {
      // Planning the right change but failing to echo an opaque evidence id is
      // the most common small-model slip here. When retrieval actually produced
      // regions for this file, the citation is attached deterministically
      // rather than failing an otherwise correct brief.
      const directory = safePath.split("/").slice(0, -1).join("/");
      const byRelevance = [
        ...availableEvidence.filter((item) => item.path === safePath),
        ...availableEvidence.filter((item) => directory && item.path.startsWith(`${directory}/`)),
        ...(operation === "create" ? availableEvidence : []),
      ];
      referencedEvidence.push(...[...new Set(byRelevance.map((item) => item.id))].slice(0, 2));
    }
    if (!referencedEvidence.length && availableEvidence.length) {
      errors.push(`change ${change.id} must cite supplied evidence IDs`);
    }
    autoCited.push(...referencedEvidence);
    changes.push({
      id: change.id,
      path: safePath,
      operation,
      intent: typeof change.intent === "string" ? change.intent : "",
      preimage_sha: operation === "create" ? undefined : existing?.sha,
      evidence_ids: referencedEvidence,
      depends_on: stringArray(change.depends_on) || [],
    });
  }

  for (const change of changes) {
    if (change.depends_on.some((dependency) => !changeIds.has(dependency) || dependency === change.id)) {
      errors.push(`change ${change.id} has an invalid dependency`);
    }
  }

  // Every cited region must also appear in the evidence list, because that list
  // is what the pre-promotion evidence CAS check verifies.
  for (const id of new Set(autoCited)) {
    if (evidence.some((item) => item.id === id)) continue;
    const source = availableEvidence.find((item) => item.id === id);
    if (!source) continue;
    evidence.push({
      id: source.id,
      source: "workspace",
      path_or_uri: source.path,
      reason: "Retrieved evidence for a declared change",
      sha: source.sha,
      start_line: source.startLine,
      end_line: source.endLine,
      trust: "trusted-workspace",
    });
  }

  const rawBlockers = Array.isArray(record.blockers) ? record.blockers : [];
  const blockers: ExecutionBrief["blockers"] = rawBlockers.flatMap((item) => {
    const blocker = asRecord(item);
    if (!blocker || typeof blocker.code !== "string" || typeof blocker.message !== "string") return [];
    return [{ code: blocker.code, message: blocker.message, needs: stringArray(blocker.needs) || undefined }];
  });
  if (!changes.length && !blockers.length) errors.push("brief must contain changes or a blocker");

  const validationRecord = asRecord(record.validation);
  const riskRecord = asRecord(record.risk);
  const declaredRisk = riskRecord?.level;
  // An unclassified brief is treated as medium: it neither claims a safety
  // review the model did not perform nor blocks on human approval.
  const riskLevel = (["low", "medium", "high"] as unknown[]).includes(declaredRisk)
    ? declaredRisk as "low" | "medium" | "high"
    : "medium";
  const riskReasons = stringArray(riskRecord?.reasons)
    || (riskLevel === "medium" && declaredRisk === undefined ? ["The model did not classify this change."] : []);

  if (errors.length) throw new Error(`ExecutionBrief validation failed:\n- ${[...new Set(errors)].join("\n- ")}`);

  const taskId = typeof record.task_id === "string" && record.task_id.trim()
    ? record.task_id.trim().slice(0, 64)
    : `task-${snapshot.id.slice(-8)}`;

  return {
    version: 1,
    task_id: taskId,
    snapshot_id: snapshot.id,
    objective: typeof record.objective === "string" && record.objective.trim() ? record.objective : objective,
    evidence,
    changes,
    invariants: stringArray(record.invariants) || [],
    validation: {
      required_checks: stringArray(validationRecord?.required_checks) || [],
      suggested_commands: stringArray(validationRecord?.suggested_commands) || [],
    },
    blockers,
    risk: { level: riskLevel, reasons: riskReasons },
  };
}

function validateMutations(value: unknown, brief: ExecutionBrief): MutationSet {
  const record = asRecord(value);
  const rawMutations = record && Array.isArray(record.mutations) ? record.mutations : null;
  if (!rawMutations) throw new Error("Apply output must contain a mutations array.");
  if (rawMutations.length !== brief.changes.length) {
    throw new Error("Apply must return exactly one mutation for every declared change.");
  }

  const byId = new Map(brief.changes.map((change) => [change.id, change]));
  const seen = new Set<string>();
  const mutations: MutationSet["mutations"] = [];
  for (const item of rawMutations) {
    const mutation = asRecord(item);
    if (!mutation || typeof mutation.change_id !== "string") throw new Error("Mutation change_id is required.");
    const change = byId.get(mutation.change_id);
    if (!change || seen.has(change.id)) throw new Error(`Mutation ${mutation.change_id} is undeclared or duplicated.`);
    seen.add(change.id);
    if (mutation.path !== change.path || mutation.operation !== change.operation) {
      throw new Error(`Mutation ${change.id} does not match its declared path and operation.`);
    }
    if (change.operation !== "delete" && typeof mutation.content !== "string") {
      throw new Error(`Mutation ${change.id} requires complete file content.`);
    }
    mutations.push({
      change_id: change.id,
      path: change.path,
      operation: change.operation,
      content: change.operation === "delete" ? undefined : String(mutation.content),
    });
  }
  return { mutations };
}

function validateApplyOutcome(value: unknown, brief: ExecutionBrief, snapshot: WorkspaceSnapshot): ApplyOutcome {
  const record = asRecord(value);
  if (!record) throw new Error("Apply output must be a JSON object.");
  const status = typeof record.status === "string" ? record.status : Array.isArray(record.mutations) ? "mutations" : "";
  if (status === "mutations") return { kind: "mutations", mutations: validateMutations(record, brief) };
  if (status === "context_request") {
    const queries = (stringArray(record.queries) || []).map((item) => item.trim()).filter(Boolean).slice(0, 4);
    if (!queries.length) throw new Error("A context request needs at least one query.");
    const knownPaths = new Set(snapshot.files.map((file) => file.path));
    const fileHints = (stringArray(record.file_hints) || [])
      .map(normalizeRelativePath)
      .filter((item) => knownPaths.has(item))
      .slice(0, 8);
    return {
      kind: "context",
      queries,
      fileHints,
      reason: typeof record.reason === "string" ? record.reason.slice(0, 1000) : "Apply requested additional read-only context.",
    };
  }
  if (status === "scope_amendment") {
    const paths = (stringArray(record.paths) || []).flatMap((candidate) => {
      try {
        return [assertSafeRelativePath(candidate)];
      } catch {
        return [];
      }
    }).slice(0, 6);
    if (!paths.length) throw new Error("A scope amendment needs at least one safe workspace path.");
    return {
      kind: "scope",
      paths,
      reason: typeof record.reason === "string" ? record.reason.slice(0, 1200) : "Apply requested a larger write set.",
    };
  }
  throw new Error("Apply must return mutations, a context_request, or a scope_amendment.");
}

async function planTasks(
  request: AgentRunRequest,
  snapshot: WorkspaceSnapshot,
  signal: AbortSignal,
  maxTasks: number,
  run: RunContext,
  runId?: string,
  replanContext?: string,
): Promise<TaskPlan> {
  const schema = `{"tasks":[{"id":"task-1","title":"...","objective":"...","scope_hint":["src/path.ts"],"acceptance_criteria":["..."],"depends_on":[]}],"reasoning_summary":"..."}`;
  const pack = await buildContextPack({
    taskText: request.prompt,
    budgetChars: run.budget.contextPack,
    runId,
    maxDirectoryCards: 3,
  });
  const listing = pathListing(snapshot, request.prompt, run.budget.contextTokens <= 8192 ? 60 : 200);
  const prompt = truncateForBudget(
    `Create the Forge v2 execution plan. Return JSON only using this shape:\n${schema}\n\nRules:\n- Use at most ${maxTasks} tasks.\n- Restate the goal faithfully. Never invert, negate, or reinterpret the requested behavior.\n- Tasks run serially and each must be independently verifiable.\n- Dependencies may reference only earlier task ids.\n- Keep each task to at most ${run.budget.maxChangesPerBrief} files so it fits one bounded transaction.\n- Files that must exist together for the project's checks to pass belong in the same task. Never add a verification script in one task and the files it needs in another.\n- scope_hint contains only safe workspace-relative paths from the candidates below or precise paths expected to be created.\n- Include concrete acceptance criteria.\n\nGOAL\n${request.prompt}\n\n${replanContext ? `REPLAN CONTEXT\n${truncateForBudget(replanContext, run.budget.diagnostics, "replan context")}\n\n` : ""}${pack ? `WORKSPACE CONTEXT (.ai-forge)\n${pack}\n\n` : ""}CANDIDATE PATHS\n${listing}`,
    run.budget.plannerPrompt,
    "planner prompt",
  );
  let raw = await chatWithLocalModel(
    request.provider,
    [{ role: "system", content: PLANNER_SYSTEM }, { role: "user", content: prompt }],
    signal,
  );
  try {
    return validateTaskPlan(parseModelJson(raw), request.prompt, maxTasks);
  } catch (firstError) {
    const diagnostics = firstError instanceof Error ? firstError.message : "Invalid planner response";
    raw = await chatWithLocalModel(
      request.provider,
      [
        { role: "system", content: PLANNER_SYSTEM },
        { role: "user", content: prompt },
        { role: "assistant", content: raw },
        { role: "user", content: `The plan was rejected. Correct it once and return only the complete JSON object.\n\nVALIDATION ERRORS\n${diagnostics}` },
      ],
      signal,
    );
    return validateTaskPlan(parseModelJson(raw), request.prompt, maxTasks);
  }
}

function taskRequest(request: AgentRunRequest, task: ForgeTask, guidance?: string): AgentRunRequest {
  const acceptance = task.acceptance_criteria.map((item) => `- ${item}`).join("\n");
  const scope = task.scope_hint.length ? task.scope_hint.join(", ") : "Gather must determine the minimal safe scope";
  return {
    ...request,
    prompt: `OVERALL GOAL\n${request.prompt}\n\nCURRENT FORGE V2 TASK\n${task.title}\n${task.objective}\n\nACCEPTANCE CRITERIA\n${acceptance}\n\nEXPECTED SCOPE\n${scope}${guidance ? `\n\nHUMAN GUIDANCE\n${guidance}` : ""}`,
  };
}

function scopeAmendmentAllowed(task: ForgeTask, requestedPaths: string[]): boolean {
  if (!task.scope_hint.length) return false;
  return requestedPaths.every((requested) => task.scope_hint.some((hint) => {
    const normalizedHint = normalizeRelativePath(hint).replace(/\/$/, "");
    return requested === normalizedHint || requested.startsWith(`${normalizedHint}/`) || normalizedHint.startsWith(`${requested}/`);
  }));
}

// The label is written as explicit key=value fields because small models
// otherwise copy a "path:12-40" header straight into a change path.
function evidenceBlock(item: RetrievedEvidence): string {
  return `--- id=${item.id} | path=${item.path} | lines=${item.startLine}-${item.endLine} | sha=${item.sha}\n${item.content}`;
}

async function gatherBrief(
  request: AgentRunRequest,
  snapshot: WorkspaceSnapshot,
  repairDiagnostics: string | undefined,
  signal: AbortSignal,
  runId: string,
  emit: EventSink,
  run: RunContext,
  focusPaths: string[] = [],
): Promise<{ brief: ExecutionBrief; evidence: RetrievedEvidence[] }> {
  emit(event(runId, "gather.started", "gather", "Gathering repository context", "Planning a focused, read-only search against the current snapshot.", "running"));

  const pack = await buildContextPack({
    taskText: request.prompt,
    budgetChars: run.budget.contextPack,
    runId,
    focusPaths,
  });
  const listing = pathListing(snapshot, request.prompt, run.budget.contextTokens <= 8192 ? 60 : 200);
  let planRaw = await chatWithLocalModel(
    request.provider,
    [
      { role: "system", content: GATHER_SYSTEM },
      {
        role: "user",
        content: truncateForBudget(
          `Create a retrieval plan for this task. Return JSON with keys queries (1-6 strings), file_hints (exact paths from the candidates), and reasoning_summary.\n\nTASK\n${request.prompt}\n\nSNAPSHOT\n${snapshot.id}\n\n${pack ? `WORKSPACE CONTEXT (.ai-forge)\n${pack}\n\n` : ""}CANDIDATE PATHS\n${listing}`,
          run.budget.retrievalPrompt,
          "retrieval prompt",
        ),
      },
    ],
    signal,
  );
  
  let plan: RetrievalPlan;
  try {
    plan = validateRetrievalPlan(parseModelJson(planRaw), snapshot, request.prompt);
  } catch (firstError) {
    const diagnostics = firstError instanceof Error ? firstError.message : "Invalid retrieval plan";
    planRaw = await chatWithLocalModel(
      request.provider,
      [
        { role: "system", content: GATHER_SYSTEM },
        {
          role: "user",
          content: truncateForBudget(
            `Create a retrieval plan for this task. Return JSON with keys queries (1-6 strings), file_hints (exact paths from the candidates), and reasoning_summary.\n\nTASK\n${request.prompt}\n\nSNAPSHOT\n${snapshot.id}\n\n${pack ? `WORKSPACE CONTEXT (.ai-forge)\n${pack}\n\n` : ""}CANDIDATE PATHS\n${listing}`,
            run.budget.retrievalPrompt,
            "retrieval prompt",
          ),
        },
        { role: "assistant", content: planRaw },
        { role: "user", content: `Your plan was rejected. Correct it once and return only the complete JSON object.\n\nVALIDATION ERRORS\n${diagnostics}` },
      ],
      signal,
    );
    plan = validateRetrievalPlan(parseModelJson(planRaw), snapshot, request.prompt);
  }
  const evidence = await retrieveEvidence([...plan.queries, request.prompt], plan.file_hints, run.budget.evidenceRegions, snapshot);
  emit(event(
    runId,
    "retrieval.complete",
    "gather",
    "Repository evidence collected",
    `${evidence.length} focused regions across ${new Set(evidence.map((item) => item.path)).size} files.`,
    "success",
    { queries: plan.queries, files: [...new Set(evidence.map((item) => item.path))] },
  ));

  const evidenceText = evidence.map(evidenceBlock).join("\n\n");
  const schema = `{
  "version": 1,
  "task_id": "short-id",
  "snapshot_id": "${snapshot.id}",
  "objective": "...",
  "evidence": [{"id":"supplied-id","reason":"..."}],
  "changes": [{"id":"c1","path":"exact/relative/path","operation":"create|modify|delete","intent":"...","evidence_ids":["supplied-id"],"depends_on":[]}],
  "invariants": ["..."],
  "validation": {"required_checks":["..."],"suggested_commands":["..."]},
  "blockers": [],
  "risk": {"level":"low|medium|high","reasons":["..."]}
}`;
  const gatherUserPrompt = `Produce the final ExecutionBrief for the task. Return JSON only and follow this shape exactly:\n${schema}\n\nRules:\n- Use only supplied evidence IDs.\n- change.path is a workspace-relative path with no line range and no id. For a file that does not exist yet, write the path you want created.\n- operation is exactly one of create, modify, or delete.\n- Do not target discussion folders.\n- Keep the write set minimal and at or below ${run.budget.maxChangesPerBrief} changes.\n- To build something new, return changes that create the files. Return a blocker only when the task genuinely cannot proceed — never as a substitute for creating a file.\n- Suggested commands are advisory; trusted infrastructure chooses what runs.\n\nTASK\n${request.prompt}\n\n${repairDiagnostics ? `PREVIOUS VERIFICATION DIAGNOSTICS\n${truncateForBudget(repairDiagnostics, run.budget.diagnostics, "diagnostics")}\n\n` : ""}REPOSITORY EVIDENCE\n${truncateForBudget(evidenceText, run.budget.gatherEvidence, "evidence")}`;

  let briefRaw = await chatWithLocalModel(
    request.provider,
    [{ role: "system", content: GATHER_SYSTEM }, { role: "user", content: gatherUserPrompt }],
    signal,
  );
  let parsed: unknown;
  try {
    parsed = parseModelJson(briefRaw);
    const brief = validateBrief(parsed, snapshot, request.prompt, evidence);
    return { brief, evidence };
  } catch (firstError) {
    const validationError = firstError instanceof Error ? firstError.message : "Unknown validation error";
    briefRaw = await chatWithLocalModel(
      request.provider,
      [
        { role: "system", content: GATHER_SYSTEM },
        { role: "user", content: gatherUserPrompt },
        { role: "assistant", content: briefRaw },
        { role: "user", content: `Your brief was rejected. Correct it once and return only the complete JSON object.\n\nVALIDATION ERRORS\n${validationError}` },
      ],
      signal,
    );
    parsed = parseModelJson(briefRaw);
    return { brief: validateBrief(parsed, snapshot, request.prompt, evidence), evidence };
  }
}

async function hydrateTargets(brief: ExecutionBrief): Promise<HydratedTarget[]> {
  const hydrated: HydratedTarget[] = [];
  for (const change of brief.changes) {
    const exists = await fileExistsInWorkspace(change.path);
    if (change.operation === "create") {
      if (exists) throw new Error(`CAS rejected: ${change.path} was created after Gather.`);
      hydrated.push({ path: change.path, sha: null, content: null });
      continue;
    }
    if (!exists) throw new Error(`CAS rejected: ${change.path} no longer exists.`);
    const raw = await readRawWorkspaceFile(change.path);
    const currentSha = sha256(raw);
    if (currentSha !== change.preimage_sha) {
      throw new Error(`CAS rejected: ${change.path} changed after Gather.`);
    }
    hydrated.push({ path: change.path, sha: currentSha, content: raw.toString("utf8") });
  }
  return hydrated;
}

type ChangeOutcome =
  | { kind: "content"; content: string }
  | { kind: "edits"; edits: EditBlock[] }
  | { kind: "delete" }
  | { kind: "context"; queries: string[]; fileHints: string[]; reason: string }
  | { kind: "scope"; paths: string[]; reason: string };

function validateChangeOutcome(
  value: unknown,
  change: ExecutionBrief["changes"][number],
  snapshot: WorkspaceSnapshot,
  mode: "content" | "edits",
): ChangeOutcome {
  const record = asRecord(value);
  if (!record) throw new Error("Apply output must be a JSON object.");
  const status = typeof record.status === "string"
    ? record.status
    : Array.isArray(record.edits) ? "edits" : typeof record.content === "string" ? "content" : "";

  if (status === "context_request" || status === "scope_amendment") {
    const outcome = validateApplyOutcome(record, { ...perChangeBriefShim, changes: [change] }, snapshot);
    if (outcome.kind === "context" || outcome.kind === "scope") return outcome;
    throw new Error("Apply returned an unusable request.");
  }

  if (change.operation === "delete") return { kind: "delete" };

  if (status === "edits") {
    if (change.operation === "create") throw new Error("A create operation must return complete file content.");
    return { kind: "edits", edits: validateEditBlocks(record.edits) };
  }

  if (status === "content") {
    if (typeof record.content !== "string") throw new Error("content must be a string holding the complete file.");
    if (mode === "edits") {
      throw new Error("This file is too large to rewrite in full. Return anchored edit blocks with {\"status\":\"edits\"}.");
    }
    return { kind: "content", content: record.content };
  }

  throw new Error(`Apply must return status "${mode}", "context_request", or "scope_amendment".`);
}

// validateApplyOutcome expects a full brief; the per-change path only needs its
// change list, so the remaining fields are supplied as inert placeholders.
const perChangeBriefShim: ExecutionBrief = {
  version: 1,
  task_id: "per-change",
  snapshot_id: "per-change",
  objective: "",
  evidence: [],
  changes: [],
  invariants: [],
  validation: { required_checks: [], suggested_commands: [] },
  blockers: [],
  risk: { level: "low", reasons: [] },
};

interface ChangeRequestContext {
  request: AgentRunRequest;
  brief: ExecutionBrief;
  run: RunContext;
  snapshot: WorkspaceSnapshot;
  supplementalEvidence: string;
  repairDiagnostics: string;
}

/**
 * Applies one declared change with one bounded model call. A file that fits the
 * rewrite allowance is returned whole; anything larger is edited through
 * anchored search/replace blocks against a windowed view, which is what lets a
 * small local model change a large file at all.
 */
async function applyChange(
  context: ChangeRequestContext,
  change: ExecutionBrief["changes"][number],
  target: HydratedTarget,
  signal: AbortSignal,
): Promise<{ outcome: ChangeOutcome; mode: "content" | "edits" }> {
  const { request, brief, run, snapshot, supplementalEvidence, repairDiagnostics } = context;
  const current = target.content ?? "";
  const mode: "content" | "edits" = change.operation === "modify"
    ? "edits"
    : "content";

  const focus = focusTermsFor(change.intent, request.prompt, repairDiagnostics);
  const view = change.operation === "create"
    ? { text: "[NEW FILE — NO CURRENT CONTENT]", windowed: false, totalLines: 0 }
    : targetView(current, run.budget.applyTarget, focus, { numbered: mode === "edits" });

  const contract = mode === "edits"
    ? `{"status":"edits","edits":[{"start_line":12,"find":"exact text copied from the file","replace":"replacement text"}]}\nThe file is shown as \`<line number>${LINE_NUMBER_MARKER}<text>\`. Do not put the number or the arrow inside find or replace. Set start_line to the number of the first line of the find block. The replacement text MUST be different from the find text. Never edit a line from an omitted region.`
    : `{"status":"content","content":"the complete new contents of this one file"}`;

  const prompt = truncateForBudget(
    [
      `Implement exactly one declared change. Return exactly one of these JSON objects:`,
      `1. ${contract}`,
      `2. {"status":"context_request","queries":["..."],"file_hints":["safe/existing/path"],"reason":"..."}`,
      `3. {"status":"scope_amendment","paths":["safe/path"],"reason":"..."}`,
      ``,
      `Use context_request only for a missing read-only signature, definition, or import. Use scope_amendment instead of editing an undeclared file. Change nothing outside the stated intent.`,
      ``,
      `TASK`,
      request.prompt,
      ``,
      `CHANGE`,
      `path: ${change.path}`,
      `operation: ${change.operation}`,
      `intent: ${change.intent}`,
      brief.invariants.length ? `invariants:\n${brief.invariants.map((item) => `- ${item}`).join("\n")}` : "",
      ``,
      repairDiagnostics ? `REPAIR DIAGNOSTICS\n${truncateForBudget(repairDiagnostics, run.budget.diagnostics, "diagnostics")}\n` : "",
      supplementalEvidence ? `APPROVED READ-ONLY CONTEXT\n${truncateForBudget(supplementalEvidence, run.budget.supplementalEvidence, "context")}\n` : "",
      `CURRENT FILE ${change.path} | sha:${target.sha || "new-file"}${view.windowed ? ` | showing selected regions of ${view.totalLines} lines` : ""}`,
      view.text,
    ].filter((line) => line !== "").join("\n"),
    run.budget.applyTarget + run.budget.supplementalEvidence + run.budget.diagnostics + 4000,
    "apply prompt",
  );

  const messages = [
    { role: "system" as const, content: APPLY_SYSTEM },
    { role: "user" as const, content: prompt },
  ];

  // Edit blocks are applied here rather than by the caller so that an anchor
  // that fails to match becomes a correction prompt instead of a failed task.
  const interpret = (raw: string): ChangeOutcome => {
    const outcome = validateChangeOutcome(parseModelJson(raw), change, snapshot, mode);
    if (outcome.kind === "edits") return { kind: "content", content: applyEditBlocks(current, outcome.edits) };
    if (outcome.kind !== "content") return outcome;

    const content = normalizeFileContent(outcome.content, change.path);
    // Catching a malformed data file here costs one correction request instead
    // of a full stage-verify-repair cycle.
    if (/\.json$/i.test(change.path)) {
      try {
        JSON.parse(content);
      } catch (error) {
        throw new Error(`${change.path} must contain valid JSON. ${error instanceof Error ? error.message : "Parse error"}. Return the file body only, with no file name line and no markdown fence.`);
      }
    }
    return { kind: "content", content };
  };

  const raw = await chatWithLocalModel(request.provider, messages, signal);
  try {
    return { outcome: interpret(raw), mode };
  } catch (firstError) {
    const diagnostics = firstError instanceof Error ? firstError.message : "Invalid Apply response";
    // Set FORGE_DEBUG_APPLY=1 to see exactly what a local model returned when
    // its response is rejected. Useful when tuning a new small model.
    if (process.env.FORGE_DEBUG_APPLY) {
      console.error(`[forge] Apply rejected for ${change.path} (${mode}): ${diagnostics}\n${raw.slice(0, 2000)}`);
    }
    const corrected = await chatWithLocalModel(
      request.provider,
      [
        ...messages,
        { role: "assistant", content: raw.slice(0, 4000) },
        { role: "user", content: `That response was rejected. Correct it once and return only the complete JSON object.\n\nERROR\n${diagnostics}${diagnostics.includes("no change") ? "\nYour replacement text MUST be different from the original text you found." : ""}` },
      ],
      signal,
    );
    return { outcome: interpret(corrected), mode };
  }
}

/**
 * Single-call Apply for workspaces that opt out of per-change mode. Only worth
 * using on a large context window: every declared target and every rewritten
 * file has to fit one request and one completion.
 */
async function applyBriefCombined(
  request: AgentRunRequest,
  brief: ExecutionBrief,
  hydrated: HydratedTarget[],
  signal: AbortSignal,
  snapshot: WorkspaceSnapshot,
  run: RunContext,
  supplementalEvidence: string,
  repairDiagnostics: string,
): Promise<ApplyOutcome> {
  const targets = hydrated
    .map((target) => `--- ${target.path} | sha:${target.sha || "new-file"}\n${target.content ?? "[NEW FILE — NO CURRENT CONTENT]"}`)
    .join("\n\n");
  let raw = await chatWithLocalModel(
    request.provider,
    [
      { role: "system", content: APPLY_SYSTEM },
      {
        role: "user",
        content: truncateForBudget(
          `Implement this validated ExecutionBrief. Return exactly one of these JSON objects:\n1. {"status":"mutations","mutations":[{"change_id":"...","path":"...","operation":"create|modify|delete","content":"complete content except for delete"}]}\n2. {"status":"context_request","queries":["..."],"file_hints":["safe/existing/path"],"reason":"..."}\n3. {"status":"scope_amendment","paths":["safe/path"],"reason":"..."}\n\nUse context_request only for missing read-only signatures, definitions, or imports. Use scope_amendment instead of writing an undeclared file. Never return partial mutations.\n\nTASK\n${request.prompt}\n\nEXECUTION BRIEF\n${JSON.stringify(brief, null, 2)}\n\n${repairDiagnostics ? `REPAIR DIAGNOSTICS\n${truncateForBudget(repairDiagnostics, run.budget.diagnostics, "diagnostics")}\n\n` : ""}${supplementalEvidence ? `APPROVED READ-ONLY CONTEXT\n${truncateForBudget(supplementalEvidence, run.budget.supplementalEvidence, "context")}\n\n` : ""}CURRENT DECLARED TARGETS\n${targets}`,
          run.budget.plannerPrompt + run.budget.applyTarget,
          "apply prompt",
        ),
      },
    ],
    signal,
  );
  
  try {
    return validateApplyOutcome(parseModelJson(raw), brief, snapshot);
  } catch (firstError) {
    const diagnostics = firstError instanceof Error ? firstError.message : "Invalid apply outcome";
    raw = await chatWithLocalModel(
      request.provider,
      [
        { role: "system", content: APPLY_SYSTEM },
        {
          role: "user",
          content: truncateForBudget(
            `Implement this validated ExecutionBrief. Return exactly one of these JSON objects:\n1. {"status":"mutations","mutations":[{"change_id":"...","path":"...","operation":"create|modify|delete","content":"complete content except for delete"}]}\n2. {"status":"context_request","queries":["..."],"file_hints":["safe/existing/path"],"reason":"..."}\n3. {"status":"scope_amendment","paths":["safe/path"],"reason":"..."}\n\nUse context_request only for missing read-only signatures, definitions, or imports. Use scope_amendment instead of writing an undeclared file. Never return partial mutations.\n\nTASK\n${request.prompt}\n\nEXECUTION BRIEF\n${JSON.stringify(brief, null, 2)}\n\n${repairDiagnostics ? `REPAIR DIAGNOSTICS\n${truncateForBudget(repairDiagnostics, run.budget.diagnostics, "diagnostics")}\n\n` : ""}${supplementalEvidence ? `APPROVED READ-ONLY CONTEXT\n${truncateForBudget(supplementalEvidence, run.budget.supplementalEvidence, "context")}\n\n` : ""}CURRENT DECLARED TARGETS\n${targets}`,
            run.budget.plannerPrompt + run.budget.applyTarget,
            "apply prompt",
          ),
        },
        { role: "assistant", content: raw },
        { role: "user", content: `Your response was rejected. Correct it once and return only the complete JSON object.\n\nVALIDATION ERRORS\n${diagnostics}` },
      ],
      signal,
    );
    return validateApplyOutcome(parseModelJson(raw), brief, snapshot);
  }
}

/**
 * Walks the validated write set one change at a time and assembles a mutation
 * set. A context or scope request from any single change stops the pass and is
 * returned to the orchestrator unchanged.
 */
async function applyBrief(
  request: AgentRunRequest,
  brief: ExecutionBrief,
  hydrated: HydratedTarget[],
  signal: AbortSignal,
  snapshot: WorkspaceSnapshot,
  run: RunContext,
  supplementalEvidence = "",
  repairDiagnostics = "",
  onChange?: (change: ExecutionBrief["changes"][number], mode: "content" | "edits", index: number) => void,
): Promise<ApplyOutcome> {
  if (!run.config.perChangeApply) {
    return applyBriefCombined(request, brief, hydrated, signal, snapshot, run, supplementalEvidence, repairDiagnostics);
  }

  const targetByPath = new Map(hydrated.map((target) => [target.path, target]));
  const context: ChangeRequestContext = { request, brief, run, snapshot, supplementalEvidence, repairDiagnostics };
  const mutations: MutationSet["mutations"] = [];

  for (const [index, change] of brief.changes.entries()) {
    if (signal.aborted) throw new DOMException("Agent run cancelled", "AbortError");
    const target = targetByPath.get(change.path);
    if (!target) throw new Error(`Apply is missing a hydrated target for ${change.path}.`);

    if (change.operation === "delete") {
      mutations.push({ change_id: change.id, path: change.path, operation: "delete" });
      continue;
    }

    const { outcome, mode } = await applyChange(context, change, target, signal);
    onChange?.(change, mode, index);
    if (outcome.kind === "context" || outcome.kind === "scope") return outcome;
    if (outcome.kind !== "content") throw new Error(`Apply returned no content for ${change.path}.`);
    mutations.push({ change_id: change.id, path: change.path, operation: change.operation, content: outcome.content });
  }

  return { kind: "mutations", mutations: validateMutations({ mutations }, brief) };
}

async function stageMutations(stageRoot: string, mutations: MutationSet): Promise<StagedMutation[]> {
  const staged: StagedMutation[] = [];
  for (const mutation of mutations.mutations) {
    const safe = assertSafeRelativePath(mutation.path);
    const target = path.resolve(stageRoot, ...safe.split("/"));
    if (!target.startsWith(`${path.resolve(stageRoot)}${path.sep}`)) throw new Error(`Unsafe staged path: ${safe}`);
    if (mutation.operation === "delete") {
      await fs.rm(target, { force: true });
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, mutation.content || "", "utf8");
    }
    staged.push({ path: safe, operation: mutation.operation, content: mutation.content });
  }
  return staged;
}

async function hydrateStageTargets(stageRoot: string, brief: ExecutionBrief): Promise<HydratedTarget[]> {
  const targets: HydratedTarget[] = [];
  for (const change of brief.changes) {
    const safe = assertSafeRelativePath(change.path);
    const absolute = path.resolve(stageRoot, ...safe.split("/"));
    if (!absolute.startsWith(`${path.resolve(stageRoot)}${path.sep}`)) throw new Error(`Unsafe staged path: ${safe}`);
    try {
      const raw = await fs.readFile(absolute);
      targets.push({ path: safe, sha: sha256(raw), content: raw.toString("utf8") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      targets.push({ path: safe, sha: null, content: null });
    }
  }
  return targets;
}

async function validateEvidenceCas(brief: ExecutionBrief): Promise<void> {
  const checked = new Set<string>();
  for (const evidence of brief.evidence) {
    if (evidence.source !== "workspace" || !evidence.sha || checked.has(evidence.path_or_uri)) continue;
    const safe = assertSafeRelativePath(evidence.path_or_uri);
    if (!await fileExistsInWorkspace(safe)) throw new Error(`Evidence CAS failed: ${safe} disappeared.`);
    const currentSha = sha256(await readRawWorkspaceFile(safe));
    if (currentSha !== evidence.sha) throw new Error(`Evidence CAS failed: ${safe} changed after Gather.`);
    checked.add(safe);
  }
}

function classifyVerificationFailure(result: VerificationResult): FailureClass {
  const text = `${result.diagnostics}\n${result.commands.map((item) => item.command).join("\n")}`.toLowerCase();
  if (/invalid json|syntax|parse error/.test(text)) return "syntax";
  if (/typecheck|lint|typescript|eslint/.test(text)) return "type-lint";
  if (/npm run test|test failed|assert/.test(text)) return "test-semantic";
  if (/npm run build|build failed/.test(text)) return "build";
  return "unknown";
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs = 120_000,
): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: "true" }, windowsHide: true });
    let output = "";
    let settled = false;
    const append = (chunk: Buffer) => {
      if (output.length < 30_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const finish = (result: { passed: boolean; output: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => {
      child.kill();
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new DOMException("Agent run cancelled", "AbortError"));
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      child.kill();
      finish({ passed: false, output: `${output}\nCommand timed out after ${timeoutMs / 1000}s.` });
    }, timeoutMs);
    child.on("error", (error) => finish({ passed: false, output: `${output}\n${error.message}` }));
    child.on("close", (code) => finish({ passed: code === 0, output: output.trim() }));
  });
}

async function verifyStage(
  stageRoot: string,
  staged: StagedMutation[],
  signal: AbortSignal,
  runId: string,
  emit: EventSink,
): Promise<VerificationResult> {
  const commandResults: VerificationResult["commands"] = [];
  const diagnostics: string[] = [];
  const available: string[] = [];

  let staticChecks = 0;
  for (const mutation of staged) {
    if (mutation.operation === "delete") continue;
    if (mutation.path.endsWith(".json")) {
      staticChecks += 1;
      try {
        JSON.parse(mutation.content || "");
      } catch (error) {
        diagnostics.push(`${mutation.path}: invalid JSON — ${error instanceof Error ? error.message : "parse error"}`);
      }
    }
  }
  if (diagnostics.length) return { passed: false, diagnostics: diagnostics.join("\n"), commands: [], available };

  // A parse gate matters most in a workspace that has no trusted script yet,
  // which is exactly the situation when a project is being created from
  // scratch. `node --check` honours the package type, so ESM parses correctly.
  for (const mutation of staged.filter((item) => item.operation !== "delete" && /\.(?:js|mjs|cjs)$/.test(item.path)).slice(0, 12)) {
    staticChecks += 1;
    const result = await runCommand(process.execPath, ["--check", mutation.path], stageRoot, signal, 20_000);
    if (!result.passed) diagnostics.push(`${mutation.path} does not parse:\n${result.output.slice(0, 1200)}`);
  }
  if (diagnostics.length) return { passed: false, diagnostics: diagnostics.join("\n"), commands: [], available };

  const packagePath = path.join(stageRoot, "package.json");
  try {
    const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = packageJson.scripts || {};
    const checks = ["typecheck", "lint", "test", "build"].filter((name) => Boolean(scripts[name]));
    
    if (checks.length > 0) {
      const installLabel = "npm install";
      emit(event(runId, "verification.command", "verify", "Installing dependencies", installLabel, "running", { command: installLabel }));
      const windows = os.platform() === "win32";
      const executable = windows ? process.env.ComSpec || "cmd.exe" : "npm";
      const args = windows ? ["/d", "/s", "/c", "npm.cmd", "install", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"];
      const installResult = await runCommand(executable, args, stageRoot, signal);
      if (!installResult.passed) {
        diagnostics.push(`${installLabel} failed:\n${installResult.output}`);
        return { passed: false, diagnostics: diagnostics.join("\n"), commands: commandResults, available };
      }
    }

    available.push(...checks.map((name) => `npm run ${name}`));
    for (const check of checks) {
      const commandLabel = `npm run ${check}`;
      emit(event(runId, "verification.command", "verify", "Running deterministic check", commandLabel, "running", { command: commandLabel }));
      const windows = os.platform() === "win32";
      const executable = windows ? process.env.ComSpec || "cmd.exe" : "npm";
      const args = windows ? ["/d", "/s", "/c", "npm.cmd", "run", check] : ["run", check];
      const result = await runCommand(executable, args, stageRoot, signal);
      commandResults.push({ command: commandLabel, passed: result.passed, output: result.output });
      if (!result.passed) {
        diagnostics.push(`${commandLabel} failed:\n${result.output}`);
        break;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      diagnostics.push(`Could not inspect package.json: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  if (diagnostics.length) return { passed: false, diagnostics: diagnostics.join("\n"), commands: commandResults, available };

  // Saying "all checks passed" when nothing behavioural ran would overstate the
  // result, which matters most in a workspace that has no scripts yet.
  const summary = commandResults.length
    ? `${commandResults.length} trusted script${commandResults.length === 1 ? "" : "s"} passed${staticChecks ? ` alongside ${staticChecks} static file check${staticChecks === 1 ? "" : "s"}` : ""}.`
    : staticChecks
      ? `${staticChecks} static file check${staticChecks === 1 ? "" : "s"} passed. No trusted verification script is configured, so behaviour was not tested.`
      : "No trusted verification script is configured and no file needed a static check, so this change was not verified.";
  return { passed: true, diagnostics: summary, commands: commandResults, available };
}

interface PromotionJournal {
  version: 1;
  runId: string;
  taskId: string;
  phase: "prepared" | "promoting" | "promoted" | "committed" | "rolled_back";
  entries: Array<{ path: string; existed: boolean }>;
  updatedAt: string;
}

async function writePromotionJournal(transactionRoot: string, journal: PromotionJournal): Promise<void> {
  await fs.mkdir(transactionRoot, { recursive: true });
  const target = path.join(transactionRoot, "transaction.json");
  const temporary = `${target}.${randomUUID()}.tmp`;
  journal.updatedAt = new Date().toISOString();
  await fs.writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

async function restorePromotion(transactionRoot: string, journal: PromotionJournal): Promise<void> {
  for (const entry of [...journal.entries].reverse()) {
    const absolute = absoluteWorkspacePath(entry.path);
    if (!entry.existed) {
      await fs.rm(absolute, { force: true });
      continue;
    }
    const backup = path.join(transactionRoot, "backups", ...entry.path.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.copyFile(backup, absolute);
  }
}

export async function recoverInterruptedPromotions(): Promise<string[]> {
  const root = path.join(workspaceRoot(), ".forge", "transactions");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const recovered: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const transactionRoot = path.join(root, entry.name);
    try {
      const journal = JSON.parse(await fs.readFile(path.join(transactionRoot, "transaction.json"), "utf8")) as PromotionJournal;
      if (!["prepared", "promoting"].includes(journal.phase)) continue;
      await restorePromotion(transactionRoot, journal);
      journal.phase = "rolled_back";
      await writePromotionJournal(transactionRoot, journal);
      recovered.push(`${journal.runId}/${journal.taskId}`);
    } catch {
      // Leave an unreadable journal untouched for manual inspection.
    }
  }
  return recovered;
}

async function promote(brief: ExecutionBrief, mutations: MutationSet, runId: string, taskId: string): Promise<string> {
  for (const change of brief.changes) {
    const exists = await fileExistsInWorkspace(change.path);
    if (change.operation === "create") {
      if (exists) throw new Error(`Promotion CAS failed: ${change.path} now exists.`);
    } else {
      if (!exists) throw new Error(`Promotion CAS failed: ${change.path} disappeared.`);
      const currentSha = sha256(await readRawWorkspaceFile(change.path));
      if (currentSha !== change.preimage_sha) throw new Error(`Promotion CAS failed: ${change.path} changed.`);
    }
  }

  const transactionRoot = path.join(workspaceRoot(), ".forge", "transactions", `${runId}-${taskId}-${randomUUID().slice(0, 8)}`);
  const journal: PromotionJournal = {
    version: 1,
    runId,
    taskId,
    phase: "prepared",
    entries: [],
    updatedAt: new Date().toISOString(),
  };
  for (const mutation of mutations.mutations) {
    const absolute = absoluteWorkspacePath(mutation.path);
    const exists = await fileExistsInWorkspace(mutation.path);
    journal.entries.push({ path: mutation.path, existed: exists });
    if (exists) {
      const backup = path.join(transactionRoot, "backups", ...mutation.path.split("/"));
      await fs.mkdir(path.dirname(backup), { recursive: true });
      await fs.copyFile(absolute, backup);
    }
  }
  await writePromotionJournal(transactionRoot, journal);
  try {
    journal.phase = "promoting";
    await writePromotionJournal(transactionRoot, journal);
    for (const mutation of mutations.mutations) {
      const absolute = absoluteWorkspacePath(mutation.path);
      if (mutation.operation === "delete") {
        await fs.rm(absolute, { force: true });
      } else {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        const temporary = `${absolute}.forge-${randomUUID()}.tmp`;
        await fs.writeFile(temporary, mutation.content || "", "utf8");
        await fs.rename(temporary, absolute);
      }
    }
  } catch (error) {
    await restorePromotion(transactionRoot, journal);
    journal.phase = "rolled_back";
    await writePromotionJournal(transactionRoot, journal);
    throw error;
  }
  journal.phase = "promoted";
  await writePromotionJournal(transactionRoot, journal);
  return transactionRoot;
}

async function commitPromotion(transactionRoot: string): Promise<void> {
  const journal = JSON.parse(await fs.readFile(path.join(transactionRoot, "transaction.json"), "utf8")) as PromotionJournal;
  journal.phase = "committed";
  await writePromotionJournal(transactionRoot, journal);
  await fs.rm(path.join(transactionRoot, "backups"), { recursive: true, force: true });
}

async function appendAudit(runId: string, request: AgentRunRequest, brief: ExecutionBrief, mutations: MutationSet): Promise<void> {
  const auditDir = path.join(workspaceRoot(), ".forge");
  await fs.mkdir(auditDir, { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    run_id: runId,
    provider: request.provider.kind,
    model: request.provider.model,
    task: request.prompt,
    brief,
    mutation_hashes: mutations.mutations.map((mutation) => ({
      path: mutation.path,
      operation: mutation.operation,
      sha: mutation.content === undefined ? null : sha256(mutation.content),
    })),
  };
  await fs.appendFile(path.join(auditDir, "audit.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Writes what the run just learned back into `.ai-forge` so the next task — and
 * the next run, days later — starts from accumulated knowledge instead of
 * rediscovering the repository from scratch.
 */
async function rememberTaskOutcome(
  runId: string,
  task: ForgeTask,
  brief: ExecutionBrief,
  changedPaths: string[],
): Promise<void> {
  await refreshFileDigests(changedPaths);
  await appendTaskJournal(
    runId,
    `${task.title} completed`,
    [
      task.objective,
      changedPaths.length ? `Changed: ${changedPaths.join(", ")}` : "No files changed.",
      brief.invariants.length ? `Invariants held: ${brief.invariants.join("; ")}` : "",
    ].filter(Boolean).join("\n"),
  );
  await recordNote({
    kind: "decision",
    title: task.title,
    paths: changedPaths,
    body: [
      task.objective,
      "",
      `Accepted changes: ${brief.changes.map((change) => `${change.operation} ${change.path}`).join(", ")}`,
      brief.risk.reasons.length ? `Risk noted: ${brief.risk.reasons.join("; ")}` : "",
    ].filter(Boolean).join("\n"),
  });
}

async function rememberTaskFailure(runId: string, task: ForgeTask, result: TransactionResult): Promise<void> {
  const diagnostics = (result.diagnostics || "No diagnostics were produced.").slice(0, 900);
  await appendTaskJournal(runId, `${task.title} ${result.status}`, diagnostics);
  await recordNote({
    kind: "failure",
    title: `${task.title} — ${result.reason || result.status}`,
    paths: result.changedPaths,
    body: [`Objective: ${task.objective}`, "", diagnostics].join("\n"),
  });
}

function failedCommands(result: VerificationResult): string[] {
  return result.commands.filter((command) => !command.passed).map((command) => command.command);
}

/**
 * Scaffolding a project takes several tasks, and an intermediate step can
 * legitimately leave a trusted script red — a test script written before its
 * tests exist, for example. A task is therefore judged on whether it introduces
 * a failure, not on whether the workspace is green. A script is not held
 * against the change when it was already failing beforehand, or when the change
 * is what introduced the script: a check that did not exist cannot regress.
 *
 * Static checks on the changed files themselves are never excused this way, and
 * the run as a whole still has to pass aggregate verification before it can
 * complete.
 */
function isPreExistingFailure(candidate: VerificationResult, baseline: VerificationResult): boolean {
  const introduced = failedCommands(candidate);
  if (!introduced.length) return false;
  const alreadyFailing = new Set(failedCommands(baseline));
  const alreadyOffered = new Set(baseline.available);
  return introduced.every((command) => alreadyFailing.has(command) || !alreadyOffered.has(command));
}

async function runTaskTransaction(
  request: AgentRunRequest,
  task: ForgeTask,
  runId: string,
  emit: EventSink,
  signal: AbortSignal,
  maxRepairCycles: number,
  riskApproved: boolean,
  run: RunContext,
  guidance?: string,
): Promise<TransactionResult> {
  let deepDiagnostics = guidance || "";
  let scopeAmendments = 0;
  const maxFastRepairs = Math.max(1, maxRepairCycles);

  let baseline: VerificationResult | undefined;
  const baselineVerification = async (): Promise<VerificationResult> => {
    if (baseline) return baseline;
    const baselineRoot = await cloneWorkspaceToStage(`${runId}-${task.id}-baseline`);
    try {
      baseline = await verifyStage(baselineRoot, [], signal, runId, emit);
      return baseline;
    } finally {
      await removeStage(baselineRoot).catch(() => undefined);
    }
  };

  deepLoop: for (let deepCycle = 0; deepCycle <= maxRepairCycles; deepCycle += 1) {
    if (signal.aborted) throw new DOMException("Agent run cancelled", "AbortError");
    const snapshot = await createSnapshot();
    emit(event(runId, "snapshot.created", "system", "Workspace snapshot captured", `${snapshot.files.length} files · ${snapshot.id}`, "success", { taskId: task.id, snapshotId: snapshot.id, fileCount: snapshot.files.length }));
    const scopedRequest = taskRequest(request, task, guidance);
    const { brief } = await gatherBrief(scopedRequest, snapshot, deepDiagnostics || undefined, signal, runId, emit, run, task.scope_hint);
    if (brief.blockers.length) {
      return { status: "suspended", reason: "blocker", changedPaths: [], diagnostics: brief.blockers.map((blocker) => blocker.message).join("; ") };
    }
    if (brief.risk.level === "high" && !riskApproved) {
      return { status: "suspended", reason: "high-risk", changedPaths: brief.changes.map((change) => change.path), diagnostics: brief.risk.reasons.join("; "), risk: brief.risk };
    }
    emit(event(runId, "brief.validated", "gather", "Execution brief validated", `${brief.changes.length} declared change${brief.changes.length === 1 ? "" : "s"} · ${brief.risk.level} risk`, "success", {
      taskId: task.id,
      changes: brief.changes.map((change) => ({ path: change.path, operation: change.operation })),
      risk: brief.risk,
    }));

    let hydrated = await hydrateTargets(brief);
    emit(event(runId, "hydration.complete", "apply", "Fresh targets hydrated", `${hydrated.length} declared target${hydrated.length === 1 ? "" : "s"} passed target CAS.`, "success", { taskId: task.id }));
    let supplementalEvidence = "";
    let contextRequests = 0;
    let fastRepairs = 0;
    let fastDiagnostics = "";
    let stageRoot: string | undefined;

    while (true) {
      if (signal.aborted) throw new DOMException("Agent run cancelled", "AbortError");
      emit(event(runId, "apply.started", "apply", "Applying bounded changes", `${brief.changes.length} declared change${brief.changes.length === 1 ? "" : "s"}, one bounded model request each.`, "running", { taskId: task.id, fastRepairs, deepCycle, changes: brief.changes.length }));
      const outcome = await applyBrief(
        scopedRequest,
        brief,
        hydrated,
        signal,
        snapshot,
        run,
        supplementalEvidence,
        fastDiagnostics,
        (change, mode, index) => emit(event(
          runId,
          "apply.started",
          "apply",
          `Change ${index + 1}/${brief.changes.length}: ${change.path}`,
          mode === "edits" ? "Anchored edit blocks against a windowed view of a large file." : "Complete file content within the rewrite budget.",
          "success",
          { taskId: task.id, path: change.path, operation: change.operation, mode },
        )),
      );
      if (outcome.kind === "context") {
        if (contextRequests >= 2) {
          return { status: "suspended", reason: "blocker", changedPaths: [], diagnostics: "Apply exhausted its bounded read-only context requests." };
        }
        const extra = await retrieveEvidence(outcome.queries, outcome.fileHints, Math.max(4, Math.round(run.budget.evidenceRegions / 2)), snapshot);
        supplementalEvidence = truncateForBudget(
          `${supplementalEvidence}\n${extra.map(evidenceBlock).join("\n\n")}`,
          run.budget.supplementalEvidence,
          "approved context",
        );
        contextRequests += 1;
        emit(event(runId, "context.requested", "gather", "Bounded context supplied", `${extra.length} read-only evidence regions returned to a fresh Apply request.`, "success", { taskId: task.id, reason: outcome.reason, files: [...new Set(extra.map((item) => item.path))] }));
        continue;
      }
      if (outcome.kind === "scope") {
        if (scopeAmendments >= 1 || !scopeAmendmentAllowed(task, outcome.paths)) {
          if (stageRoot) await removeStage(stageRoot).catch(() => undefined);
          return { status: "suspended", reason: "blocker", changedPaths: outcome.paths, diagnostics: `Scope amendment requires human guidance: ${outcome.reason}` };
        }
        scopeAmendments += 1;
        deepDiagnostics = `Apply requested a validated scope amendment for ${outcome.paths.join(", ")}: ${outcome.reason}. Gather must retrieve evidence and produce a new complete ExecutionBrief before any mutation.`;
        emit(event(runId, "scope.amendment", "gather", "Scope amendment returned to Gather", outcome.reason, "info", { taskId: task.id, paths: outcome.paths }));
        if (stageRoot) await removeStage(stageRoot).catch(() => undefined);
        deepCycle -= 1;
        continue deepLoop;
      }

      const mutations = outcome.mutations;
      stageRoot ??= await cloneWorkspaceToStage(`${runId}-${task.id}`);
      const staged = await stageMutations(stageRoot, mutations);
      emit(event(runId, "mutation.staged", "apply", "Candidate isolated in staging", `${staged.length} file mutation${staged.length === 1 ? "" : "s"}; live files are untouched.`, "success", {
        taskId: task.id,
        files: staged.map((item) => ({ path: item.path, operation: item.operation })),
      }));
      const verification = await verifyStage(stageRoot, staged, signal, runId, emit);
      const failureClass = verification.passed ? undefined : classifyVerificationFailure(verification);
      emit(event(runId, "verification.result", "verify", verification.passed ? "Verification passed" : "Verification found issues", verification.diagnostics.slice(0, 1000), verification.passed ? "success" : "error", {
        taskId: task.id,
        failureClass,
        commands: verification.commands,
        trustedScripts: verification.commands.length,
      }));

      let acceptable = verification.passed;
      if (!acceptable && isPreExistingFailure(verification, await baselineVerification())) {
        acceptable = true;
        emit(event(runId, "verification.result", "verify", "Failure is not a regression", `${failedCommands(verification).join(", ")} did not pass before this task either. The change is accepted as non-regressing; the run must still pass aggregate verification before it can complete.`, "info", {
          taskId: task.id,
          preExisting: failedCommands(verification),
        }));
      }

      if (acceptable) {
        await validateEvidenceCas(brief);
        const transactionRoot = await promote(brief, mutations, runId, task.id);
        let auditStatus: "recorded" | "degraded" = "recorded";
        try {
          await appendAudit(runId, scopedRequest, brief, mutations);
        } catch (error) {
          auditStatus = "degraded";
          emit(event(runId, "verification.result", "promote", "Audit write degraded", error instanceof Error ? error.message : "The promoted change could not be appended to the audit log.", "error", { taskId: task.id, filesPromoted: true }));
        } finally {
          await commitPromotion(transactionRoot);
        }
        const changedPaths = mutations.mutations.map((mutation) => mutation.path);
        emit(event(runId, "promotion.complete", "promote", "Verified change promoted", "Evidence and target CAS passed; the accepted mutation set is live.", "success", { taskId: task.id, files: changedPaths, auditStatus }));
        await removeStage(stageRoot).catch(() => undefined);
        await rememberTaskOutcome(runId, task, brief, changedPaths).catch(() => undefined);
        return { status: "completed", changedPaths };
      }

      const canFastRepair = (failureClass === "syntax" || failureClass === "type-lint") && fastRepairs < maxFastRepairs;
      if (canFastRepair) {
        fastRepairs += 1;
        fastDiagnostics = verification.diagnostics;
        hydrated = await hydrateStageTargets(stageRoot, brief);
        emit(event(runId, "repair.fast", "apply", "Starting fast repair", `A fresh Apply request receives compact ${failureClass} diagnostics without repeating Gather.`, "running", { taskId: task.id, attempt: fastRepairs }));
        continue;
      }
      if (deepCycle < maxRepairCycles) {
        deepDiagnostics = verification.diagnostics;
        emit(event(runId, "repair.deep", "gather", "Starting deep repair", "Verification diagnostics return to a fresh snapshot and Gather cycle.", "running", { taskId: task.id, attempt: deepCycle + 1, failureClass }));
        await removeStage(stageRoot).catch(() => undefined);
        continue deepLoop;
      }
      return { status: "failed", reason: "verification", changedPaths: mutations.mutations.map((mutation) => mutation.path), diagnostics: verification.diagnostics, stageRoot };
    }
  }
  return { status: "failed", reason: "verification", changedPaths: [], diagnostics: "The transaction exhausted its repair budget." };
}

async function finalRunVerification(manifest: ForgeRunManifest, emit: EventSink, signal: AbortSignal): Promise<VerificationResult> {
  emit(event(manifest.runId, "final.verification.started", "verify", "Running aggregate verification", "Checking the combined result of every completed Forge v2 task.", "running"));
  const stageRoot = await cloneWorkspaceToStage(`${manifest.runId}-final`);
  try {
    const result = await verifyStage(stageRoot, [], signal, manifest.runId, emit);
    emit(event(manifest.runId, "final.verification.result", "verify", result.passed ? "Aggregate verification passed" : "Aggregate verification failed", result.passed ? "The combined workspace passed all configured deterministic gates." : result.diagnostics.slice(0, 1200), result.passed ? "success" : "error", {
      commands: result.commands,
      acceptanceCriteria: manifest.tasks.flatMap((task) => task.acceptance_criteria),
    }));
    return result;
  } finally {
    await removeStage(stageRoot).catch(() => undefined);
  }
}

function suspensionActions(reason: NonNullable<TransactionResult["reason"]>): Array<"approve" | "retry" | "discard"> {
  return reason === "high-risk" ? ["approve", "retry", "discard"] : ["retry", "discard"];
}

async function suspendRun(manifest: ForgeRunManifest, task: ForgeTask | undefined, result: TransactionResult, emit: EventSink): Promise<ForgeRunManifest> {
  const reason = result.reason || "verification";
  if (task) task.status = "suspended";
  manifest.status = "suspended";
  manifest.currentTaskId = task?.id;
  manifest.suspension = {
    reason,
    message: result.diagnostics || "Forge paused for a human decision.",
    taskId: task?.id,
    stageRoot: result.stageRoot,
    changedPaths: result.changedPaths,
    diagnostics: result.diagnostics,
    allowedActions: suspensionActions(reason),
  };
  const suspension = manifest.suspension;
  const saved = await saveRunManifest(manifest);
  if (task) await rememberTaskFailure(saved.runId, task, result).catch(() => undefined);
  emit(event(saved.runId, "run.suspended", "human", "Forge v2 suspended", suspension.message, "error", {
    runId: saved.runId,
    taskId: task?.id,
    reason,
    changedPaths: result.changedPaths,
    allowedActions: suspension.allowedActions,
  }));
  return saved;
}

async function executeManifest(manifest: ForgeRunManifest, emit: EventSink, signal: AbortSignal, run: RunContext): Promise<ForgeRunManifest> {
  const baseRequest: AgentRunRequest = {
    prompt: manifest.objective,
    provider: manifest.provider,
    maxRepairCycles: manifest.maxRepairCycles,
    maxReplans: manifest.maxReplans,
    maxTasks: manifest.tasks.length || 6,
    architecture: "v2",
  };
  while (true) {
    const task = manifest.tasks.find((candidate) => candidate.status === "pending" || candidate.status === "running");
    if (!task) {
      const aggregate = await finalRunVerification(manifest, emit, signal);
      if (aggregate.passed) break;
      const changedPaths = [...new Set(manifest.tasks.flatMap((completed) => completed.changed_paths || []))];
      // Scaffolding often only becomes green once every piece exists, so the
      // remaining replan budget is spent on a repair task before asking a human.
      if (manifest.replansUsed < manifest.maxReplans) {
        manifest.replansUsed += 1;
        manifest.tasks.push({
          id: `final-repair-${manifest.replansUsed}`,
          title: "Resolve aggregate verification failure",
          objective: aggregate.diagnostics.slice(0, 4000),
          scope_hint: changedPaths.slice(0, 16),
          acceptance_criteria: ["Aggregate deterministic verification passes", "The original objective remains satisfied"],
          depends_on: manifest.tasks.filter((item) => item.status === "completed").map((item) => item.id),
          status: "pending",
          attempts: 0,
        });
        manifest = await saveRunManifest(manifest);
        emit(event(manifest.runId, "plan.replanned", "plan", "Repairing the combined result", "Aggregate verification failed, so one bounded repair task was queued before asking for a human decision.", "info", {
          replan: manifest.replansUsed,
          changedPaths,
        }));
        continue;
      }
      return suspendRun(manifest, undefined, { status: "suspended", reason: "final-verification", changedPaths, diagnostics: aggregate.diagnostics }, emit);
    }
    task.status = "running";
    task.attempts = (task.attempts || 0) + 1;
    manifest.status = "running";
    manifest.currentTaskId = task.id;
    manifest.suspension = undefined;
    manifest = await saveRunManifest(manifest);
    emit(event(manifest.runId, "task.started", "plan", `Task ${manifest.tasks.indexOf(task) + 1}/${manifest.tasks.length}: ${task.title}`, task.objective, "running", {
      taskId: task.id,
      scopeHint: task.scope_hint,
      acceptanceCriteria: task.acceptance_criteria,
    }));

    await appendTaskJournal(manifest.runId, `Task started: ${task.title}`, task.objective).catch(() => undefined);

    let result: TransactionResult;
    try {
      result = await runTaskTransaction(baseRequest, task, manifest.runId, emit, signal, manifest.maxRepairCycles, manifest.approvedRiskTaskIds.includes(task.id), run, manifest.guidance?.[task.id]);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      await removeStagesForRun(`${manifest.runId}-${task.id}`).catch(() => undefined);
      result = { status: "failed", changedPaths: [], diagnostics: error instanceof Error ? error.message : "Unknown transaction error", reason: "verification" };
    }

    if (result.status === "completed") {
      task.status = "completed";
      task.changed_paths = result.changedPaths;
      task.diagnostics = undefined;
      manifest.currentTaskId = undefined;
      manifest = await saveRunManifest(manifest);
      emit(event(manifest.runId, "task.completed", "plan", `${task.title} completed`, `${result.changedPaths.length} path${result.changedPaths.length === 1 ? "" : "s"} accepted.`, "success", { taskId: task.id, changedPaths: result.changedPaths }));
      continue;
    }

    if (result.status === "failed" && manifest.replansUsed < manifest.maxReplans) {
      if (result.stageRoot) await removeStage(result.stageRoot).catch(() => undefined);
      task.status = "failed";
      task.diagnostics = result.diagnostics;
      manifest.replansUsed += 1;
      const snapshot = await createSnapshot();
      const completed = manifest.tasks.filter((candidate) => candidate.status === "completed");
      const plan = await planTasks(
        baseRequest,
        snapshot,
        signal,
        Math.max(1, Math.min(baseRequest.maxTasks ?? 6, run.budget.maxTasks)),
        run,
        manifest.runId,
        `Completed tasks:\n${completed.map((item) => `- ${item.title}`).join("\n") || "None"}\n\nFailed task:\n${task.title}\n${result.diagnostics || "Unknown failure"}\n\nCreate only the remaining corrective tasks.`,
      );
      const prefix = `r${manifest.replansUsed}-`;
      const replanned = plan.tasks.map((item) => ({ ...item, id: `${prefix}${item.id}`, depends_on: item.depends_on.map((dependency) => `${prefix}${dependency}`) }));
      manifest.tasks = [...completed, ...replanned];
      manifest.currentTaskId = undefined;
      manifest = await saveRunManifest(manifest);
      emit(event(manifest.runId, "plan.replanned", "plan", "Remaining work replanned", `${replanned.length} corrective task${replanned.length === 1 ? "" : "s"} created from verification diagnostics.`, "info", {
        replan: manifest.replansUsed,
        tasks: replanned.map((item) => ({ id: item.id, title: item.title })),
      }));
      continue;
    }
    return suspendRun(manifest, task, result, emit);
  }

  manifest.status = "completed";
  manifest.currentTaskId = undefined;
  manifest.suspension = undefined;
  manifest = await saveRunManifest(manifest);
  const changedPaths = [...new Set(manifest.tasks.flatMap((task) => task.changed_paths || []))];
  const completedTasks = manifest.tasks.filter(t => t.status === "completed");
  
  let runSummary = `${completedTasks.length} task${completedTasks.length === 1 ? "" : "s"} completed; ${changedPaths.length} workspace path${changedPaths.length === 1 ? "" : "s"} changed.`;
  if (completedTasks.length > 0) {
    try {
      const summaryPrompt = `Summarize the work completed in this autonomous agent run. Describe the issue it fixed, the problem it solved, or provide a concise summary of the changes made.\nFormat the response as clean Markdown. Keep it brief and focused on the outcome.\n\nORIGINAL GOAL\n${manifest.objective}\n\nTASKS COMPLETED\n${completedTasks.map((t, idx) => `${idx + 1}. ${t.title}: ${t.objective}`).join("\n\n")}`;
      const summaryRaw = await chatWithLocalModel(
        manifest.provider,
        [
          { role: "system", content: "You are an expert software engineer providing a final summary of an autonomous coding task." },
          { role: "user", content: summaryPrompt }
        ],
        signal
      );
      if (summaryRaw.trim()) {
        runSummary = summaryRaw.trim();
      }
    } catch (e) {
      // Fallback to default message on LLM failure
      console.warn("Could not generate run summary", e);
    }
  }

  await appendTaskJournal(manifest.runId, "Run completed", runSummary).catch(() => undefined);
  await pruneStore().catch(() => undefined);
  emit(event(manifest.runId, "run.completed", "system", "Forge v2 run completed", runSummary, "success", { runId: manifest.runId, changedPaths }));
  return manifest;
}

let activeRunId: string | undefined;

export async function runAgentLoopV2(
  request: AgentRunRequest,
  emit: EventSink,
  signal: AbortSignal,
): Promise<void> {
  if (activeRunId) throw new Error(`Forge run ${activeRunId} is already active in this workspace.`);
  const runId = randomUUID();
  activeRunId = runId;
  const now = new Date().toISOString();
  let manifest: ForgeRunManifest = {
    version: 2,
    runId,
    objective: request.prompt,
    provider: request.provider,
    status: "planning",
    tasks: [],
    maxRepairCycles: Math.max(0, Math.min(request.maxRepairCycles ?? 1, 2)),
    maxReplans: Math.max(0, Math.min(request.maxReplans ?? 1, 2)),
    replansUsed: 0,
    approvedRiskTaskIds: [],
    createdAt: now,
    updatedAt: now,
  };
  try {
    manifest = await saveRunManifest(manifest);
    const run = await loadRunContext();
    emit(event(runId, "run.started", "system", "Forge v2 started", `Using ${request.provider.model} through ${request.provider.kind} on the ${run.config.profile} context profile (${run.config.contextTokens} tokens); transaction state is persisted.`, "running", {
      runId,
      architecture: "v2",
      profile: run.config.profile,
      contextTokens: run.config.contextTokens,
    }));
    emit(event(runId, "planner.started", "plan", "Planning ordered transactions", "The read-only orchestrator is decomposing the goal into bounded tasks.", "running"));
    const snapshot = await createSnapshot();

    const index = await refreshProjectIndex(snapshot);
    await ensureProjectCard(snapshot, index);
    await appendTaskJournal(runId, "Run started", request.prompt.slice(0, 600));
    emit(event(runId, "snapshot.created", "system", "Workspace context refreshed", `${index.fileCount} files across ${index.directories.length} directories summarized into .ai-forge.`, "success", {
      snapshotId: snapshot.id,
      fileCount: index.fileCount,
      directories: index.directories.length,
    }));

    const maxTasks = Math.max(1, Math.min(request.maxTasks ?? 6, run.budget.maxTasks));
    const plan = await planTasks(request, snapshot, signal, maxTasks, run, runId);
    manifest.tasks = plan.tasks;
    manifest.status = "running";
    manifest = await saveRunManifest(manifest);
    emit(event(runId, "plan.validated", "plan", "Forge v2 plan validated", `${plan.tasks.length} ordered task${plan.tasks.length === 1 ? "" : "s"} queued.`, "success", {
      runId,
      reasoningSummary: plan.reasoning_summary,
      tasks: plan.tasks.map((task) => ({ id: task.id, title: task.title, scopeHint: task.scope_hint, acceptanceCriteria: task.acceptance_criteria })),
    }));
    await executeManifest(manifest, emit, signal, run);
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    manifest.status = "failed";
    await removeStagesForRun(runId).catch(() => undefined);
    await saveRunManifest(manifest).catch(() => undefined);
    emit(event(runId, "run.failed", "system", cancelled ? "Forge v2 cancelled" : "Forge v2 stopped safely", cancelled ? "The active local-model request or verification command was cancelled." : error instanceof Error ? error.message : "Unknown agent error", "error", { runId }));
  } finally {
    activeRunId = undefined;
  }
}

export async function runAgentLoop(
  request: AgentRunRequest,
  emit: EventSink,
  signal: AbortSignal,
): Promise<void> {
  const runId = randomUUID();
  const maxRepairCycles = Math.max(0, Math.min(request.maxRepairCycles ?? 1, 2));
  let repairDiagnostics: string | undefined;
  const run = await loadRunContext();
  emit(event(runId, "run.started", "system", "Agent loop started", `Using ${request.provider.model} through ${request.provider.kind} on the ${run.config.profile} context profile.`, "running"));

  try {
    for (let cycle = 0; cycle <= maxRepairCycles; cycle += 1) {
      if (signal.aborted) throw new DOMException("Agent run cancelled", "AbortError");
      const snapshot = await createSnapshot();
      emit(event(runId, "snapshot.created", "system", "Workspace snapshot captured", `${snapshot.files.length} files · ${snapshot.id}`, "success", { snapshotId: snapshot.id, fileCount: snapshot.files.length }));

      const { brief } = await gatherBrief(request, snapshot, repairDiagnostics, signal, runId, emit, run);
      if (brief.blockers.length) {
        throw new Error(`Gather stopped safely: ${brief.blockers.map((blocker) => blocker.message).join("; ")}`);
      }
      if (brief.risk.level === "high") {
        throw new Error(`High-risk plan requires human approval: ${brief.risk.reasons.join("; ")}`);
      }
      emit(event(runId, "brief.validated", "gather", "Execution brief validated", `${brief.changes.length} declared change${brief.changes.length === 1 ? "" : "s"} · ${brief.risk.level} risk`, "success", {
        changes: brief.changes.map((change) => ({ path: change.path, operation: change.operation })),
        risk: brief.risk,
      }));

      const hydrated = await hydrateTargets(brief);
      emit(event(runId, "hydration.complete", "apply", "Fresh targets hydrated", `${hydrated.length} declared target${hydrated.length === 1 ? "" : "s"} passed the pre-Apply CAS gate.`, "success"));
      emit(event(runId, "apply.started", "apply", "Applying bounded changes", "A fresh model context can edit only the declared targets.", "running"));
      const applyOutcome = await applyBrief(request, brief, hydrated, signal, snapshot, run);
      if (applyOutcome.kind !== "mutations") throw new Error("Legacy Forge runs do not support Apply context or scope requests.");
      const mutations = applyOutcome.mutations;

      const stageRoot = await cloneWorkspaceToStage(runId);
      try {
        const staged = await stageMutations(stageRoot, mutations);
        emit(event(runId, "mutation.staged", "apply", "Candidate isolated in staging", `${staged.length} file mutation${staged.length === 1 ? "" : "s"}; live files are untouched.`, "success", {
          files: staged.map((item) => ({ path: item.path, operation: item.operation })),
        }));
        const verification = await verifyStage(stageRoot, staged, signal, runId, emit);
        emit(event(
          runId,
          "verification.result",
          "verify",
          verification.passed ? "Verification passed" : "Verification found issues",
          verification.passed ? "All configured checks passed in the isolated workspace." : verification.diagnostics.slice(0, 1000),
          verification.passed ? "success" : "error",
          { commands: verification.commands },
        ));

        if (!verification.passed) {
          if (cycle < maxRepairCycles) {
            repairDiagnostics = verification.diagnostics;
            emit(event(runId, "repair.started", "gather", "Starting bounded repair cycle", `Returning structured diagnostics to Gather (${cycle + 1}/${maxRepairCycles}).`, "running"));
            continue;
          }
          throw new Error(`Verification failed after ${cycle + 1} attempt${cycle === 0 ? "" : "s"}: ${verification.diagnostics.slice(0, 2000)}`);
        }

        const transactionRoot = await promote(brief, mutations, runId, "legacy");
        await appendAudit(runId, request, brief, mutations);
        await commitPromotion(transactionRoot);
        emit(event(runId, "promotion.complete", "promote", "Verified change promoted", "Final CAS passed; the live workspace now contains the accepted mutation set.", "success", {
          files: mutations.mutations.map((mutation) => mutation.path),
        }));
        emit(event(runId, "run.completed", "system", "Task completed", `Changed ${mutations.mutations.length} file${mutations.mutations.length === 1 ? "" : "s"} safely.`, "success"));
        return;
      } finally {
        await removeStage(stageRoot).catch(() => undefined);
      }
    }
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    emit(event(
      runId,
      "run.failed",
      "system",
      cancelled ? "Agent run cancelled" : "Agent stopped safely",
      cancelled ? "The active local-model request was cancelled." : error instanceof Error ? error.message : "Unknown agent error",
      "error",
    ));
  }
}

export async function resumeAgentLoop(
  decision: AgentDecisionRequest,
  emit: EventSink,
  signal: AbortSignal,
): Promise<void> {
  if (activeRunId) throw new Error(`Forge run ${activeRunId} is already active in this workspace.`);
  let manifest = await readRunManifest(decision.runId);
  if (manifest.status !== "suspended" || !manifest.suspension) throw new Error("Only a suspended Forge v2 run can be resumed or discarded.");
  if (!manifest.suspension.allowedActions.includes(decision.decision)) throw new Error(`Decision ${decision.decision} is not valid for this suspension.`);
  activeRunId = manifest.runId;
  try {
    if (decision.decision === "discard") {
      if (manifest.suspension.stageRoot) await removeStage(manifest.suspension.stageRoot).catch(() => undefined);
      const task = manifest.tasks.find((item) => item.id === manifest.currentTaskId);
      if (task) task.status = "abandoned";
      manifest.status = "discarded";
      manifest.suspension = undefined;
      manifest = await saveRunManifest(manifest);
      emit(event(manifest.runId, "run.discarded", "human", "Suspended run discarded", "Retained staging data was removed; completed transactions remain in the workspace.", "info", { runId: manifest.runId }));
      return;
    }

    if (manifest.suspension.stageRoot) await removeStage(manifest.suspension.stageRoot).catch(() => undefined);
    const task = manifest.tasks.find((item) => item.id === manifest.currentTaskId);
    if (decision.decision === "approve") {
      if (!task || manifest.suspension.reason !== "high-risk") throw new Error("Approval is available only for a high-risk task.");
      manifest.approvedRiskTaskIds = [...new Set([...manifest.approvedRiskTaskIds, task.id])];
    }
    if (decision.decision === "retry") {
      const guidance = decision.guidance?.trim() || manifest.suspension.diagnostics || "Retry from a fresh snapshot and address the prior diagnostics.";
      if (task) {
        manifest.guidance = { ...(manifest.guidance || {}), [task.id]: guidance.slice(0, 8000) };
      } else {
        const id = `final-repair-${manifest.tasks.length + 1}`;
        manifest.tasks.push({
          id,
          title: "Resolve aggregate verification failure",
          objective: guidance.slice(0, 4000),
          scope_hint: [...new Set(manifest.suspension.changedPaths || [])].slice(0, 16),
          acceptance_criteria: ["Aggregate deterministic verification passes", "The original Forge v2 objective remains satisfied"],
          depends_on: manifest.tasks.filter((item) => item.status === "completed").map((item) => item.id),
          status: "pending",
          attempts: 0,
        });
      }
    }
    if (task) task.status = "pending";
    manifest.status = "running";
    manifest.suspension = undefined;
    manifest.currentTaskId = undefined;
    manifest = await saveRunManifest(manifest);
    emit(event(manifest.runId, "run.started", "human", "Forge v2 resumed", "The suspended task will restart from a fresh snapshot before any promotion.", "running", { runId: manifest.runId, decision: decision.decision }));
    await executeManifest(manifest, emit, signal, await loadRunContext());
  } catch (error) {
    const cancelled = error instanceof DOMException && error.name === "AbortError";
    emit(event(manifest.runId, "run.failed", "system", cancelled ? "Forge v2 resume cancelled" : "Forge v2 resume stopped safely", cancelled ? "The resumed request was cancelled." : error instanceof Error ? error.message : "Unknown resume error", "error", { runId: manifest.runId }));
  } finally {
    activeRunId = undefined;
  }
}

export const __testables = {
  isPreExistingFailure,
  validateRetrievalPlan,
  validateTaskPlan,
  validateBrief,
  validateMutations,
  validateApplyOutcome,
  classifyVerificationFailure,
};

