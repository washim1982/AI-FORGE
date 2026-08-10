export type ProviderKind = "ollama" | "lmstudio" | "llamacpp";

export interface ProviderConfig {
  kind: ProviderKind;
  endpoint: string;
  model: string;
  temperature: number;
}

export interface RuntimeStatus {
  kind: ProviderKind;
  label: string;
  endpoint: string;
  reachable: boolean;
  models: string[];
  latencyMs: number;
  error?: string;
}

export interface WorkspaceSearchResult {
  path: string;
  line: number;
  preview: string;
}

export interface WorkspaceGitChange {
  path: string;
  status: string;
}

export interface WorkspaceStatus {
  isRepository: boolean;
  branch: string;
  changes: WorkspaceGitChange[];
  error?: string;
}

export interface ProjectScripts {
  checks: string[];
}

export interface ProjectCheckResult {
  name: string;
  command: string;
  passed: boolean;
  output: string;
}

export type ContextProfileName = "tiny" | "small" | "balanced" | "large";

export interface ContextBudget {
  contextTokens: number;
  plannerPrompt: number;
  retrievalPrompt: number;
  gatherEvidence: number;
  applyTarget: number;
  supplementalEvidence: number;
  diagnostics: number;
  contextPack: number;
  wholeFileRewriteLimit: number;
  evidenceRegions: number;
  maxTasks: number;
  maxChangesPerBrief: number;
}

export interface ContextStoreConfig {
  version: 1;
  profile: ContextProfileName;
  contextTokens: number;
  perChangeApply: boolean;
  editBlocks: boolean;
  updatedAt: string;
}

export interface ContextStoreSummary {
  root: string;
  workspace: string;
  config: ContextStoreConfig;
  budget: ContextBudget;
  projectCardChars: number;
  indexedSnapshotId?: string;
  indexedAt?: string;
  directoryCards: number;
  fileDigests: number;
  notes: number;
  journals: number;
}

export type ChangeOperation = "create" | "modify" | "delete";

export interface ExecutionBrief {
  version: 1;
  task_id: string;
  snapshot_id: string;
  objective: string;
  evidence: Array<{
    id: string;
    source: "workspace" | "index" | "mcp" | "artifact";
    path_or_uri: string;
    reason: string;
    sha?: string;
    start_line?: number;
    end_line?: number;
    trust: "trusted-workspace" | "derived" | "external-untrusted";
  }>;
  changes: Array<{
    id: string;
    path: string;
    operation: ChangeOperation;
    intent: string;
    preimage_sha?: string;
    evidence_ids: string[];
    depends_on: string[];
  }>;
  invariants: string[];
  validation: {
    required_checks: string[];
    suggested_commands: string[];
  };
  blockers: Array<{
    code: string;
    message: string;
    needs?: string[];
  }>;
  risk: {
    level: "low" | "medium" | "high";
    reasons: string[];
  };
}

export interface MutationSet {
  mutations: Array<{
    change_id: string;
    path: string;
    operation: ChangeOperation;
    content?: string;
  }>;
}

export interface ForgeTask {
  id: string;
  title: string;
  objective: string;
  scope_hint: string[];
  acceptance_criteria: string[];
  depends_on: string[];
  status?: "pending" | "running" | "completed" | "suspended" | "failed" | "abandoned";
  attempts?: number;
  changed_paths?: string[];
  diagnostics?: string;
}

export type ForgeRunStatus = "planning" | "running" | "suspended" | "completed" | "failed" | "discarded";

export interface ForgeSuspension {
  reason: "blocker" | "high-risk" | "verification" | "final-verification";
  message: string;
  taskId?: string;
  stageRoot?: string;
  changedPaths?: string[];
  diagnostics?: string;
  allowedActions: Array<"approve" | "retry" | "discard">;
}

export interface ForgeRunManifest {
  version: 2;
  runId: string;
  objective: string;
  provider: ProviderConfig;
  status: ForgeRunStatus;
  tasks: ForgeTask[];
  currentTaskId?: string;
  maxRepairCycles: number;
  maxReplans: number;
  replansUsed: number;
  approvedRiskTaskIds: string[];
  guidance?: Record<string, string>;
  suspension?: ForgeSuspension;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDecisionRequest {
  runId: string;
  decision: "approve" | "retry" | "discard";
  guidance?: string;
}

export type AgentEventKind =
  | "run.started"
  | "planner.started"
  | "plan.validated"
  | "plan.replanned"
  | "task.started"
  | "task.completed"
  | "task.suspended"
  | "snapshot.created"
  | "gather.started"
  | "retrieval.complete"
  | "brief.validated"
  | "hydration.complete"
  | "apply.started"
  | "context.requested"
  | "scope.amendment"
  | "mutation.staged"
  | "verification.command"
  | "verification.result"
  | "repair.started"
  | "repair.fast"
  | "repair.deep"
  | "final.verification.started"
  | "final.verification.result"
  | "promotion.complete"
  | "run.suspended"
  | "run.discarded"
  | "run.completed"
  | "run.failed";

export interface AgentEvent {
  id: string;
  runId: string;
  kind: AgentEventKind;
  phase: "system" | "plan" | "gather" | "apply" | "verify" | "promote" | "human";
  title: string;
  message: string;
  status: "running" | "success" | "error" | "info";
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface AgentRunRequest {
  prompt: string;
  provider: ProviderConfig;
  maxRepairCycles?: number;
  maxReplans?: number;
  maxTasks?: number;
  architecture?: "v1" | "v2";
}

export interface ChatRequest {
  prompt: string;
  provider: ProviderConfig;
  history?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

export interface WorkspaceFile {
  path: string;
  content: string;
  sha: string;
  language: string;
}
