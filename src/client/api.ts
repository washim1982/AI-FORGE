import type {
  AgentEvent,
  AgentDecisionRequest,
  AgentReviewResult,
  AgentRouteDecision,
  AgentRunRequest,
  ForgeRunManifest,
  ProjectCheckResult,
  ProjectScripts,
  ProviderConfig,
  RuntimeStatus,
  TreeNode,
  WorkspaceSearchResult,
  WorkspaceStatus,
  WorkspaceFile,
} from "../shared/types";

async function jsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  let payload: (T & { error?: string }) | undefined;
  try {
    payload = body ? (JSON.parse(body) as T & { error?: string }) : undefined;
  } catch {
    // A non-JSON body means the request never reached a route handler — an
    // HTML error page, a dev-proxy failure, or an API server older than the
    // client. Reporting the parse error would hide all of that.
    if (response.status === 404) {
      throw new Error(
        `This build of the Forge API does not have ${new URL(response.url, location.origin).pathname}. `
        + "Restart the app so the server rebuilds — in forge:desktop:dev the API is built once at launch and does not hot-reload.",
      );
    }
    throw new Error(`Request failed with ${response.status} and a non-JSON response.`);
  }
  if (!response.ok) throw new Error(payload?.error || `Request failed with ${response.status}`);
  return payload as T;
}

export async function fetchTree(): Promise<{ nodes: TreeNode[]; root: string }> {
  return jsonResponse(await fetch("/api/tree"));
}

export async function fetchFile(path: string): Promise<WorkspaceFile> {
  return jsonResponse(await fetch(`/api/file?path=${encodeURIComponent(path)}`));
}

export async function saveFile(file: WorkspaceFile, content: string): Promise<WorkspaceFile> {
  return jsonResponse(await fetch("/api/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: file.path, content, expectedSha: file.sha }),
  }));
}

export async function createWorkspaceEntry(path: string, kind: "file" | "directory"): Promise<{ path: string; kind: "file" | "directory" }> {
  return jsonResponse(await fetch("/api/workspace/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, kind }),
  }));
}

export async function renameWorkspaceEntry(from: string, to: string): Promise<{ path: string }> {
  return jsonResponse(await fetch("/api/workspace/rename", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, to }),
  }));
}

export async function deleteWorkspaceEntry(path: string): Promise<{ path: string }> {
  return jsonResponse(await fetch("/api/workspace/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  }));
}

export async function fetchModels(config: ProviderConfig): Promise<string[]> {
  const payload = await jsonResponse<{ models: string[] }>(await fetch("/api/models", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  }));
  return payload.models;
}

export async function fetchRuntimes(): Promise<RuntimeStatus[]> {
  const payload = await jsonResponse<{ runtimes: RuntimeStatus[] }>(await fetch("/api/runtimes"));
  return payload.runtimes;
}

export async function sendChat(
  prompt: string,
  provider: ProviderConfig,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  signal: AbortSignal,
): Promise<string> {
  const payload = await jsonResponse<{ message: string }>(await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, provider, history }),
    signal,
  }));
  return payload.message;
}

export async function routeAgentPrompt(
  prompt: string,
  provider: ProviderConfig,
  signal: AbortSignal,
): Promise<AgentRouteDecision> {
  const payload = await jsonResponse<{ decision: AgentRouteDecision }>(await fetch("/api/agent/route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, provider }),
    signal,
  }));
  return payload.decision;
}

export async function reviewWorkspace(
  prompt: string,
  provider: ProviderConfig,
  signal: AbortSignal,
): Promise<AgentReviewResult> {
  return jsonResponse<AgentReviewResult>(await fetch("/api/agent/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, provider }),
    signal,
  }));
}

export async function searchWorkspace(query: string, signal?: AbortSignal): Promise<WorkspaceSearchResult[]> {
  const payload = await jsonResponse<{ results: WorkspaceSearchResult[] }>(await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal }));
  return payload.results;
}

export async function fetchWorkspaceStatus(): Promise<WorkspaceStatus> {
  return jsonResponse(await fetch("/api/workspace/status"));
}

export async function fetchProjectScripts(): Promise<ProjectScripts> {
  return jsonResponse(await fetch("/api/project/scripts"));
}

export async function runProjectCheck(name: string, signal?: AbortSignal): Promise<ProjectCheckResult> {
  return jsonResponse(await fetch("/api/project/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
    signal,
  }));
}

export async function streamAgentRun(
  request: AgentRunRequest,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamAgentEvents("/api/agent/run", request, onEvent, signal);
}

export async function streamAgentDecision(
  request: AgentDecisionRequest,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  return streamAgentEvents("/api/agent/resume", request, onEvent, signal);
}

export async function fetchAgentRuns(): Promise<ForgeRunManifest[]> {
  const payload = await jsonResponse<{ runs: ForgeRunManifest[] }>(await fetch("/api/agent/runs"));
  return payload.runs;
}

async function streamAgentEvents(
  route: string,
  request: AgentRunRequest | AgentDecisionRequest,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(payload.error || "Could not start or resume the Forge run.");
  }
  if (!response.body) throw new Error("The agent stream was unavailable.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) onEvent(JSON.parse(line) as AgentEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as AgentEvent);
}
