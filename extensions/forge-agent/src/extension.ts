import { randomBytes } from "node:crypto";
import path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";

type ProviderKind = "ollama" | "lmstudio" | "llamacpp";

interface ProviderConfig {
  kind: ProviderKind;
  endpoint: string;
  model: string;
  temperature: number;
}

interface RuntimeStatus {
  kind: ProviderKind;
  label: string;
  endpoint: string;
  reachable: boolean;
  models: string[];
  latencyMs: number;
  error?: string;
}

interface AgentEvent {
  id: string;
  runId: string;
  kind: string;
  phase: string;
  title: string;
  message: string;
  status: "running" | "success" | "error" | "info";
  timestamp: string;
  data?: Record<string, unknown>;
}

interface AgentRouteDecision {
  intent: "CHAT" | "CREATE" | "FIX" | "RESEARCH" | "LEARN" | "CLARIFY";
  target: "chat" | "review" | "agent" | "clarify";
  confidence: number;
  rationale: string;
  tier: "heuristic" | "model" | "human";
  question?: string;
}

interface WebviewMessage {
  type?: unknown;
  text?: unknown;
  url?: unknown;
  runId?: unknown;
  decision?: unknown;
  guidance?: unknown;
  prompt?: unknown;
  provider?: unknown;
  maxRepairCycles?: unknown;
  mode?: unknown;
  history?: unknown;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

const DEFAULT_ENDPOINTS: Record<ProviderKind, string> = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234",
  llamacpp: "http://127.0.0.1:8080",
};

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.find(({ uri }) => uri.scheme === "file");
  if (!folder) throw new Error("Open a local folder before starting Forge.");
  return folder.uri.fsPath;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isLoopbackEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProviderConfig>;
  return (
    ["ollama", "lmstudio", "llamacpp"].includes(String(candidate.kind)) &&
    typeof candidate.endpoint === "string" &&
    isLoopbackEndpoint(candidate.endpoint) &&
    typeof candidate.model === "string" &&
    candidate.model.trim().length > 0 &&
    typeof candidate.temperature === "number" &&
    candidate.temperature >= 0 &&
    candidate.temperature <= 2
  );
}

function conversationHistory(value: unknown): ConversationMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((message): message is ConversationMessage => {
      if (!message || typeof message !== "object") return false;
      const candidate = message as Partial<ConversationMessage>;
      return ["user", "assistant"].includes(String(candidate.role)) && typeof candidate.content === "string";
    })
    .slice(-12)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 20_000) }));
}

class ForgeSidecar implements vscode.Disposable {
  private worker: Worker | undefined;
  private pending: Promise<string> | undefined;
  private apiUrl: string | undefined;
  private readonly token = randomBytes(32).toString("hex");

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly onStatus: (state: "starting" | "ready" | "stopped" | "error", detail?: string) => void,
  ) {}

  async start(): Promise<string> {
    if (this.apiUrl && this.worker) return this.apiUrl;
    if (this.pending) return this.pending;

    this.pending = new Promise<string>((resolve, reject) => {
      const root = workspaceRoot();
      const script = this.context.asAbsolutePath(path.join("server", "forge-worker.mjs"));
      this.onStatus("starting", root);
      this.output.appendLine(`[sidecar] Starting for ${root}`);

      const worker = new Worker(script, {
        env: {
          ...process.env,
          FORGE_API_TOKEN: this.token,
          FORGE_CODE_OSS: "1",
          PORT: "0",
          WORKSPACE_ROOT: root,
        },
        stdout: true,
        stderr: true,
      });
      this.worker = worker;

      let settled = false;
      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.onStatus("error", error.message);
        reject(error);
      };

      const timeout = setTimeout(() => {
        void worker.terminate();
        finishError(new Error("Forge sidecar did not become ready within 20 seconds."));
      }, 20_000);

      worker.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const record = message as { type?: unknown; url?: unknown; message?: unknown };
        if (record.type === "ready" && typeof record.url === "string" && !settled) {
          settled = true;
          clearTimeout(timeout);
          this.apiUrl = record.url;
          this.output.appendLine(`[sidecar] Listening on ${record.url}`);
          this.onStatus("ready", record.url);
          resolve(record.url);
        } else if (record.type === "error" && typeof record.message === "string") {
          finishError(new Error(record.message));
        }
      });
      worker.stdout?.setEncoding("utf8");
      worker.stdout?.on("data", (chunk: string) => this.output.append(`[sidecar] ${chunk}`));
      worker.stderr?.setEncoding("utf8");
      worker.stderr?.on("data", (chunk: string) => this.output.append(`[sidecar:error] ${chunk}`));
      worker.once("error", (error) => finishError(error));
      worker.once("exit", (code) => {
        const wasCurrent = this.worker === worker;
        if (wasCurrent) {
          this.worker = undefined;
          this.apiUrl = undefined;
        }
        const detail = `Exited with code ${code}.`;
        this.output.appendLine(`[sidecar] ${detail}`);
        if (!settled) finishError(new Error(`Forge sidecar ${detail.toLowerCase()}`));
        else if (wasCurrent) this.onStatus(code === 0 ? "stopped" : "error", detail);
      });
    }).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async restart(): Promise<string> {
    this.stop();
    return this.start();
  }

  async request(route: string, init: RequestInit = {}): Promise<Response> {
    const baseUrl = await this.start();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    return fetch(`${baseUrl}${route}`, { ...init, headers });
  }

  stop(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.apiUrl = undefined;
    if (worker) void worker.terminate();
    this.onStatus("stopped");
  }

  dispose(): void {
    this.stop();
  }
}

class ForgeViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private controller: AbortController | undefined;
  private running = false;
  private sidecarState: "starting" | "ready" | "stopped" | "error" = "stopped";
  private sidecarDetail = "";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly sidecar: ForgeSidecar,
    private readonly statusBar: vscode.StatusBarItem,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = webviewHtml();
    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message).catch((error) => this.fail(error));
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.sendSidecarStatus();
    this.updateWorkspaceState();
  }

  updateSidecarStatus(state: "starting" | "ready" | "stopped" | "error", detail = ""): void {
    this.sidecarState = state;
    this.sidecarDetail = detail;
    const icon = state === "ready" ? "$(sparkle)" : state === "error" ? "$(error)" : "$(sync~spin)";
    this.statusBar.text = `${icon} Forge: ${state}`;
    this.statusBar.tooltip = detail || "Forge local coding agent";
    this.statusBar.show();
    this.sendSidecarStatus();
  }

  private sendSidecarStatus(): void {
    void this.view?.webview.postMessage({
      type: "sidecar",
      state: this.sidecarState,
      detail: this.sidecarDetail,
    });
  }

  updateWorkspaceState(): void {
    void this.view?.webview.postMessage({
      type: "workspace",
      trusted: vscode.workspace.isTrusted,
      hasFolder: Boolean(vscode.workspace.workspaceFolders?.some(({ uri }) => uri.scheme === "file")),
    });
  }

  private configuredProvider(): ProviderConfig {
    const config = vscode.workspace.getConfiguration();
    const kind = config.get<ProviderKind>("forge.provider", "ollama");
    const endpointValues = config.inspect<string>("forge.endpoint");
    const explicitEndpoint =
      endpointValues?.workspaceFolderValue ??
      endpointValues?.workspaceValue ??
      endpointValues?.globalValue;
    return {
      kind,
      endpoint: explicitEndpoint || DEFAULT_ENDPOINTS[kind],
      model: config.get<string>("forge.model", ""),
      temperature: config.get<number>("forge.temperature", 0.1),
    };
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "ready" || message.type === "refresh") {
      this.updateWorkspaceState();
      if (!vscode.workspace.workspaceFolders?.some(({ uri }) => uri.scheme === "file")) {
        void this.view?.webview.postMessage({
          type: "runtimes",
          runtimes: [],
          configured: this.configuredProvider(),
        });
        return;
      }
      await this.refreshRuntimes();
      return;
    }
    if (message.type === "openFolder") {
      await vscode.commands.executeCommand("workbench.action.files.openFolder");
      return;
    }
    if (message.type === "trust") {
      await vscode.commands.executeCommand("workbench.trust.manage");
      return;
    }
    if (message.type === "restart") {
      await this.sidecar.restart();
      await this.refreshRuntimes();
      return;
    }
    if (message.type === "settings") {
      await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:forge.forge-agent");
      return;
    }
    if (message.type === "copy" && typeof message.text === "string") {
      await vscode.env.clipboard.writeText(message.text.slice(0, 500_000));
      return;
    }
    if (message.type === "openLink" && typeof message.url === "string") {
      const url = new URL(message.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Forge only opens HTTP or HTTPS links.");
      await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
      return;
    }
    if (message.type === "cancel") {
      this.controller?.abort();
      return;
    }
    if (message.type === "decision") {
      const runId = typeof message.runId === "string" ? message.runId : "";
      const decision = ["approve", "retry", "discard"].includes(String(message.decision)) ? String(message.decision) as "approve" | "retry" | "discard" : undefined;
      if (!runId || !decision) throw new Error("A suspended Forge v2 run and valid decision are required.");
      let guidance = typeof message.guidance === "string" ? message.guidance.trim() : "";
      if (decision === "retry" && !guidance) {
        guidance = (await vscode.window.showInputBox({
          title: "Retry Forge v2 task",
          prompt: "Give Forge guidance for a fresh snapshot and transaction attempt.",
          value: "Address the reported diagnostics without widening the requested scope.",
          ignoreFocusOut: true,
        }))?.trim() || "";
        if (!guidance) return;
      }
      await this.resumeAgent(runId, decision, guidance);
      return;
    }
    if (message.type === "run") {
      const prompt = typeof message.prompt === "string" ? message.prompt.trim() : "";
      if (!prompt) throw new Error("Enter a message before sending.");
      if (!isProviderConfig(message.provider)) {
        throw new Error("Select a reachable local runtime and model first.");
      }
      let target: AgentRouteDecision["target"] = message.mode === "chat" ? "chat" : "agent";
      if (message.mode === "default") {
        const decision = await this.routePrompt(prompt, message.provider);
        target = decision.target;
        if (target === "clarify") {
          void this.view?.webview.postMessage({
            type: "chatResponse",
            message: `### Clarification needed\n\n${decision.question || "Should Forge modify files, diagnose a failure, review the workspace, or only explain?"}`,
          });
          return;
        }
      }
      if (target === "chat") {
        await this.runChat(prompt, message.provider, conversationHistory(message.history));
        return;
      }
      if (!vscode.workspace.isTrusted) {
        await vscode.commands.executeCommand("workbench.trust.manage");
        throw new Error("Trust this workspace before Forge can inspect, validate, or modify repository files.");
      }
      if (target === "review") {
        await this.runReview(prompt, message.provider);
        return;
      }
      if (prompt.length < 4) throw new Error("Describe a coding task before starting the agent.");
      const requestedCycles = typeof message.maxRepairCycles === "number" ? message.maxRepairCycles : undefined;
      const configuredCycles = vscode.workspace.getConfiguration().get<number>("forge.maxRepairCycles", 1);
      await this.runAgent(prompt, message.provider, Math.max(0, Math.min(3, requestedCycles ?? configuredCycles)));
    }
  }

  private async routePrompt(prompt: string, provider: ProviderConfig): Promise<AgentRouteDecision> {
    if (this.running) throw new Error("A Forge request is already running.");
    this.running = true;
    this.controller = new AbortController();
    this.statusBar.text = "$(sync~spin) Forge: routing";
    void this.view?.webview.postMessage({ type: "runState", running: true });
    this.output.appendLine(`[auto] Routing request with ${provider.kind}/${provider.model}`);
    try {
      const response = await this.sidecar.request("/api/agent/route", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, provider }),
        signal: this.controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as { decision?: AgentRouteDecision; error?: string };
      if (!response.ok || !payload.decision) throw new Error(payload.error || `Auto Agent routing failed (${response.status}).`);
      this.output.appendLine(`[auto] ${payload.decision.tier} route -> ${payload.decision.intent}`);
      void this.view?.webview.postMessage({ type: "agentRoute", decision: payload.decision, prompt });
      return payload.decision;
    } finally {
      this.running = false;
      this.controller = undefined;
      this.statusBar.text = this.sidecarState === "ready" ? "$(sparkle) Forge: ready" : `$(circle-outline) Forge: ${this.sidecarState}`;
      void this.view?.webview.postMessage({ type: "runState", running: false });
    }
  }

  async refreshRuntimes(): Promise<void> {
    void this.view?.webview.postMessage({ type: "loading", value: true });
    try {
      const response = await this.sidecar.request("/api/runtimes");
      const payload = (await response.json()) as { runtimes?: RuntimeStatus[]; error?: string };
      if (!response.ok) throw new Error(payload.error || `Runtime discovery failed (${response.status}).`);
      const configured = this.configuredProvider();
      const runtimes = payload.runtimes ?? [];

      if (configured.endpoint !== DEFAULT_ENDPOINTS[configured.kind]) {
        const startedAt = Date.now();
        try {
          const probeResponse = await this.sidecar.request("/api/models", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(configured),
          });
          const probe = (await probeResponse.json()) as { models?: string[]; error?: string };
          if (!probeResponse.ok) throw new Error(probe.error || `Endpoint probe failed (${probeResponse.status}).`);
          const existing = runtimes.find((runtime) => runtime.kind === configured.kind);
          const replacement: RuntimeStatus = {
            kind: configured.kind,
            label: existing?.label ?? configured.kind,
            endpoint: configured.endpoint,
            reachable: true,
            models: probe.models ?? [],
            latencyMs: Date.now() - startedAt,
          };
          const index = runtimes.findIndex((runtime) => runtime.kind === configured.kind);
          if (index >= 0) runtimes[index] = replacement;
          else runtimes.push(replacement);
        } catch (error) {
          const existing = runtimes.find((runtime) => runtime.kind === configured.kind);
          const replacement: RuntimeStatus = {
            kind: configured.kind,
            label: existing?.label ?? configured.kind,
            endpoint: configured.endpoint,
            reachable: false,
            models: [],
            latencyMs: Date.now() - startedAt,
            error: errorMessage(error),
          };
          const index = runtimes.findIndex((runtime) => runtime.kind === configured.kind);
          if (index >= 0) runtimes[index] = replacement;
          else runtimes.push(replacement);
        }
      }
      void this.view?.webview.postMessage({
        type: "runtimes",
        runtimes,
        configured,
      });
    } finally {
      void this.view?.webview.postMessage({ type: "loading", value: false });
    }
  }

  private async runChat(prompt: string, provider: ProviderConfig, history: ConversationMessage[]): Promise<void> {
    if (this.running) throw new Error("A Forge request is already running.");
    this.running = true;
    this.controller = new AbortController();
    this.statusBar.text = "$(sync~spin) Forge: thinking";
    void this.view?.webview.postMessage({ type: "runState", running: true });
    this.output.appendLine(`[chat] Message submitted with ${provider.kind}/${provider.model}`);

    try {
      const response = await this.sidecar.request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, provider, history }),
        signal: this.controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || `Chat request failed (${response.status}).`);
      if (!payload.message?.trim()) throw new Error("The local model returned an empty chat response.");
      this.output.appendLine(`[chat] Response received (${payload.message.length} characters)`);
      void this.view?.webview.postMessage({ type: "chatResponse", message: payload.message });
    } catch (error) {
      if (this.controller.signal.aborted) {
        this.output.appendLine("[chat] Request cancelled by user.");
        void this.view?.webview.postMessage({ type: "cancelled" });
      } else {
        throw error;
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      this.statusBar.text = this.sidecarState === "ready" ? "$(sparkle) Forge: ready" : `$(circle-outline) Forge: ${this.sidecarState}`;
      void this.view?.webview.postMessage({ type: "runState", running: false });
    }
  }

  private async runReview(prompt: string, provider: ProviderConfig): Promise<void> {
    if (this.running) throw new Error("A Forge request is already running.");
    this.running = true;
    this.controller = new AbortController();
    this.statusBar.text = "$(sync~spin) Forge: reviewing";
    void this.view?.webview.postMessage({ type: "runState", running: true });
    void this.view?.webview.postMessage({ type: "reviewStarted" });
    this.output.appendLine(`[review] Read-only repository review submitted with ${provider.kind}/${provider.model}`);

    try {
      const response = await this.sidecar.request("/api/agent/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, provider }),
        signal: this.controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        snapshotId?: string;
        fileCount?: number;
        evidenceCount?: number;
      };
      if (!response.ok) throw new Error(payload.error || `Repository review failed (${response.status}).`);
      if (!payload.message?.trim()) throw new Error("The local model returned an empty repository review.");
      this.output.appendLine(`[review] Completed against ${payload.snapshotId || "workspace snapshot"}`);
      void this.view?.webview.postMessage({ type: "reviewResponse", ...payload });
    } catch (error) {
      if (this.controller.signal.aborted) {
        this.output.appendLine("[review] Request cancelled by user.");
        void this.view?.webview.postMessage({ type: "cancelled" });
      } else {
        throw error;
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      this.statusBar.text = this.sidecarState === "ready" ? "$(sparkle) Forge: ready" : `$(circle-outline) Forge: ${this.sidecarState}`;
      void this.view?.webview.postMessage({ type: "runState", running: false });
    }
  }

  private async runAgent(prompt: string, provider: ProviderConfig, maxRepairCycles: number): Promise<void> {
    if (this.running) throw new Error("A Forge task is already running.");
    this.running = true;
    this.controller = new AbortController();
    this.statusBar.text = "$(sync~spin) Forge: working";
    void this.view?.webview.postMessage({ type: "runState", running: true });
    this.output.appendLine(`[agent] Task submitted with ${provider.kind}/${provider.model}`);

    try {
      const response = await this.sidecar.request("/api/agent/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, provider, maxRepairCycles, maxReplans: 1, maxTasks: 6, architecture: "v2" }),
        signal: this.controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `Agent run failed (${response.status}).`);
      }
      if (!response.body) throw new Error("The Forge event stream was unavailable.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) this.forwardAgentEvent(line);
        if (done) break;
      }
      if (buffer.trim()) this.forwardAgentEvent(buffer);
    } catch (error) {
      if (this.controller.signal.aborted) {
        this.output.appendLine("[agent] Run cancelled by user.");
        void this.view?.webview.postMessage({ type: "cancelled" });
      } else {
        throw error;
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      this.statusBar.text = this.sidecarState === "ready" ? "$(sparkle) Forge: ready" : `$(circle-outline) Forge: ${this.sidecarState}`;
      void this.view?.webview.postMessage({ type: "runState", running: false });
    }
  }

  private async resumeAgent(runId: string, decision: "approve" | "retry" | "discard", guidance = ""): Promise<void> {
    if (this.running) throw new Error("A Forge request is already running.");
    this.running = true;
    this.controller = new AbortController();
    this.statusBar.text = "$(sync~spin) Forge: resuming v2";
    void this.view?.webview.postMessage({ type: "runState", running: true });
    this.output.appendLine(`[agent:v2] ${decision} requested for ${runId}`);
    try {
      const response = await this.sidecar.request("/api/agent/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, decision, guidance }),
        signal: this.controller.signal,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `Forge v2 decision failed (${response.status}).`);
      }
      if (!response.body) throw new Error("The Forge v2 resume event stream was unavailable.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) this.forwardAgentEvent(line);
        if (done) break;
      }
      if (buffer.trim()) this.forwardAgentEvent(buffer);
    } catch (error) {
      if (this.controller.signal.aborted) {
        this.output.appendLine("[agent:v2] Resume cancelled by user.");
        void this.view?.webview.postMessage({ type: "cancelled" });
      } else {
        throw error;
      }
    } finally {
      this.running = false;
      this.controller = undefined;
      this.statusBar.text = this.sidecarState === "ready" ? "$(sparkle) Forge: ready" : `$(circle-outline) Forge: ${this.sidecarState}`;
      void this.view?.webview.postMessage({ type: "runState", running: false });
    }
  }

  private forwardAgentEvent(line: string): void {
    if (!line.trim()) return;
    const event = JSON.parse(line) as AgentEvent;
    this.output.appendLine(`[${event.phase}] ${event.title}: ${event.message}`);
    void this.view?.webview.postMessage({ type: "agentEvent", event });
    if (event.kind === "promotion.complete") {
      vscode.window.setStatusBarMessage("$(check) Forge promoted verified workspace changes", 6000);
    }
  }

  private fail(error: unknown): void {
    const message = errorMessage(error);
    this.output.appendLine(`[error] ${message}`);
    void this.view?.webview.postMessage({ type: "error", message });
    void vscode.window.showErrorMessage(`Forge: ${message}`);
  }

  dispose(): void {
    this.controller?.abort();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Forge Local Agent", { log: true });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
  statusBar.command = "forge.showOutput";

  let provider: ForgeViewProvider;
  const sidecar = new ForgeSidecar(context, output, (state, detail) => provider?.updateSidecarStatus(state, detail));
  provider = new ForgeViewProvider(context, output, sidecar, statusBar);

  context.subscriptions.push(
    output,
    statusBar,
    sidecar,
    provider,
    vscode.window.registerWebviewViewProvider("forge.agentView", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("forge.restartSidecar", async () => {
      try {
        await sidecar.restart();
        await provider.refreshRuntimes();
      } catch (error) {
        output.appendLine(`[error] ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`Forge: ${errorMessage(error)}`);
      }
    }),
    vscode.commands.registerCommand("forge.openAgent", () =>
      vscode.commands.executeCommand("workbench.view.extension.forge"),
    ),
    vscode.commands.registerCommand("forge.manageTrust", () =>
      vscode.commands.executeCommand("workbench.trust.manage"),
    ),
    vscode.commands.registerCommand("forge.showOutput", () => output.show(true)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      sidecar.stop();
      provider.updateWorkspaceState();
      if (vscode.workspace.workspaceFolders?.some(({ uri }) => uri.scheme === "file")) {
        void provider.refreshRuntimes().catch((error) => {
          output.appendLine(`[error] ${errorMessage(error)}`);
        });
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => provider.updateWorkspaceState()),
  );

  provider.updateSidecarStatus("stopped", "Open the Forge view to start the local sidecar.");
  void vscode.commands.executeCommand("workbench.view.extension.forge");
}

export function deactivate(): void {
  // Disposables registered in the extension context own shutdown.
}

function nonce(): string {
  return randomBytes(18).toString("base64");
}

function webviewHtml(): string {
  const scriptNonce = nonce();
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${scriptNonce}'; script-src 'nonce-${scriptNonce}';">
  <style nonce="${scriptNonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { display: flex; flex-direction: column; height: 100vh; margin: 0; padding: 10px; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: 13px/1.45 var(--vscode-font-family); }
    button, select, input, textarea { font: inherit; }
    .brand { display: flex; flex: none; align-items: center; gap: 9px; margin-bottom: 10px; }
    .mark { display: grid; place-items: center; width: 28px; height: 28px; color: #e6d2ff; border: 1px solid color-mix(in srgb, #a663ff 55%, transparent); border-radius: 8px; background: color-mix(in srgb, #7d35df 24%, transparent); font-weight: 700; }
    .brand strong { display: block; font-size: 13px; }
    .brand small { display: block; color: var(--vscode-descriptionForeground); }
    .status { margin-left: auto; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 15%, transparent); }
    .status.ready { background: #43c98b; }
    .status.error { background: #f06c75; }
    .card { flex: none; padding: 10px; margin-bottom: 9px; border: 1px solid var(--vscode-panel-border); border-radius: 7px; background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent); }
    .label { display: block; margin: 0 0 5px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    select, input, textarea { width: 100%; color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); outline: none; background: var(--vscode-input-background); }
    select, input { height: 29px; padding: 0 7px; }
    textarea { min-height: 88px; max-height: 220px; padding: 8px; resize: vertical; }
    select:focus, input:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
    .field + .field { margin-top: 9px; }
    .endpoint { overflow: hidden; color: var(--vscode-descriptionForeground); font: 11px var(--vscode-editor-font-family); text-overflow: ellipsis; white-space: nowrap; }
    .row { display: flex; gap: 7px; align-items: center; }
    button { min-height: 30px; padding: 4px 10px; color: var(--vscode-button-foreground); border: 0; border-radius: 3px; background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.icon { width: 31px; padding: 0; }
    button:disabled { cursor: default; opacity: .48; }
    #run { flex: 1; }
    #cancel { display: none; }
    .timeline { position: relative; flex: 1 1 auto; min-height: 100px; margin: 0 -3px 9px 0; padding-right: 5px; overflow-y: auto; }
    .event { position: relative; margin: 0 0 8px 7px; padding: 8px 9px 8px 12px; border-left: 2px solid var(--vscode-panel-border); border-radius: 0 4px 4px 0; background: color-mix(in srgb, var(--vscode-editor-background) 66%, transparent); }
    .event::before { content: ''; position: absolute; left: -5px; top: 13px; width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .event.user { border-left-color: #b777ff; background: color-mix(in srgb, #7d35df 12%, var(--vscode-editor-background)); }
    .event.user::before { background: #b777ff; }
    .event.assistant { border-left-color: #8b72a8; }
    .event.assistant::before { background: #b777ff; }
    .event.success { border-left-color: #43c98b; }
    .event.success::before { background: #43c98b; }
    .event.error { border-left-color: #f06c75; }
    .event.error::before { background: #f06c75; }
    .event.running { border-left-color: #b777ff; }
    .event.running::before { background: #b777ff; }
    .event.response { padding: 0; }
    .event-head { display: flex; gap: 7px; align-items: baseline; }
    details.event > summary.event-head { position: relative; min-height: 34px; padding: 8px 31px 8px 12px; list-style: none; cursor: pointer; user-select: none; }
    details.event > summary.event-head::-webkit-details-marker { display: none; }
    details.event > summary.event-head::after { content: '>'; position: absolute; top: 7px; right: 11px; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 18px; transform: rotate(0deg); transition: transform 120ms ease; }
    details.event[open] > summary.event-head::after { transform: rotate(90deg); }
    details.event > summary.event-head:hover { background: var(--vscode-list-hoverBackground); }
    .event-body { padding: 9px 12px 11px; border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 65%, transparent); }
    .event-title { font-weight: 600; }
    .event-phase { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase; }
    .event-message { margin-top: 2px; color: var(--vscode-descriptionForeground); white-space: pre-wrap; }
    .markdown { color: var(--vscode-foreground); overflow-wrap: anywhere; white-space: normal; }
    .markdown > :first-child { margin-top: 0; }
    .markdown > :last-child { margin-bottom: 0; }
    .markdown h1, .markdown h2, .markdown h3, .markdown h4, .markdown h5, .markdown h6 { margin: 15px 0 7px; color: var(--vscode-foreground); line-height: 1.3; }
    .markdown h1 { font-size: 1.35em; }
    .markdown h2 { padding-bottom: 4px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 1.2em; }
    .markdown h3 { font-size: 1.08em; }
    .markdown h4, .markdown h5, .markdown h6 { font-size: 1em; }
    .markdown p { margin: 0 0 9px; }
    .markdown ul, .markdown ol { margin: 0 0 10px; padding-left: 22px; }
    .markdown li { margin: 3px 0; }
    .markdown blockquote { margin: 8px 0; padding: 3px 10px; color: var(--vscode-descriptionForeground); border-left: 3px solid #8b5cf6; background: color-mix(in srgb, #8b5cf6 6%, transparent); }
    .markdown hr { height: 1px; margin: 13px 0; border: 0; background: var(--vscode-panel-border); }
    .markdown strong { color: var(--vscode-foreground); font-weight: 650; }
    .markdown a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .markdown a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .markdown :not(pre) > code { padding: 1px 4px; color: var(--vscode-textPreformat-foreground); border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent); border-radius: 4px; background: var(--vscode-textCodeBlock-background); font: 12px/1.45 var(--vscode-editor-font-family); }
    .code-block { margin: 9px 0 11px; overflow: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: transparent; box-shadow: none; }
    .code-head { display: flex; min-height: 28px; padding: 3px 5px 3px 10px; align-items: center; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); font: 10px var(--vscode-font-family); text-transform: uppercase; }
    .code-head span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .code-copy { width: auto; min-height: 21px; margin-left: auto; padding: 0 6px; color: var(--vscode-descriptionForeground); background: transparent; font-size: 10px; text-transform: none; }
    .code-copy:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .code-block pre { margin: 0; padding: 10px; overflow: auto; background: transparent !important; box-shadow: none !important; tab-size: 2; }
    .code-block code { display: block; padding: 0; color: var(--vscode-editor-foreground); border: 0; border-radius: 0; background: transparent !important; box-shadow: none !important; font: 12px/1.55 var(--vscode-editor-font-family); text-shadow: none; white-space: pre; }
    .decision-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--vscode-panel-border); }
    .decision-actions button { min-height: 25px; padding: 2px 8px; font-size: 11px; }
    .decision-actions button.danger { color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); background: transparent; }
    .empty { display: grid; min-height: 100%; place-items: center; padding: 18px 4px; color: var(--vscode-descriptionForeground); text-align: center; }
    .error-box { display: none; flex: none; margin-bottom: 9px; padding: 8px; color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); background: var(--vscode-inputValidation-errorBackground); }
    .notice { display: none; flex: none; gap: 8px; align-items: center; margin-bottom: 9px; padding: 8px; border: 1px solid var(--vscode-inputValidation-warningBorder); border-radius: 5px; background: var(--vscode-inputValidation-warningBackground); }
    .notice span { flex: 1; }
    .notice button { flex: none; }
    .fine { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .composer { position: relative; margin: 0; padding: 8px 8px 6px; border-color: color-mix(in srgb, #b777ff 30%, var(--vscode-panel-border)); border-radius: 6px; background: color-mix(in srgb, #342b3e 28%, var(--vscode-editor-background)); }
    .composer:focus-within { border-color: color-mix(in srgb, #b777ff 70%, var(--vscode-focusBorder)); }
    #prompt { min-height: 48px; max-height: 180px; padding: 2px 38px 8px 2px; border: 0; background: transparent; resize: none; }
    #prompt:focus { border: 0; }
    .composer-toolbar { display: flex; gap: 5px; align-items: center; min-width: 0; }
    .toolbar-spacer { flex: 1; }
    .toolbar-button { width: 24px; min-height: 24px; padding: 0; color: var(--vscode-descriptionForeground); background: transparent; }
    .toolbar-button:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    .toolbar-select { width: auto; height: 24px; min-width: 0; padding: 0 16px 0 3px; color: var(--vscode-foreground); border: 0; background: transparent; font-size: 11px; }
    #runtime { max-width: 72px; }
    #model { max-width: 132px; }
    #mode { max-width: 82px; }
    #run { position: absolute; top: 8px; right: 8px; width: 28px; min-height: 28px; padding: 0; border-radius: 8px; font-size: 17px; line-height: 28px; }
    #cancel { width: auto; min-height: 24px; padding: 0 5px; font-size: 11px; }
    .status-button { display: grid; place-items: center; width: 18px; min-height: 24px; padding: 0; background: transparent; }
    .status-button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .status-button .status { margin: 0; }
    .status-button.loading .status { background: #b777ff; animation: pulse 900ms ease-in-out infinite alternate; }
    .toggle-label { display: flex; gap: 5px; align-items: center; font-size: 11px; white-space: nowrap; cursor: pointer; }
    .toggle-label input { position: absolute; width: 1px; height: 1px; opacity: 0; }
    .toggle-track { position: relative; width: 27px; height: 15px; border-radius: 999px; background: var(--vscode-input-background); box-shadow: inset 0 0 0 1px var(--vscode-panel-border); }
    .toggle-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--vscode-descriptionForeground); transition: transform 120ms ease, background 120ms ease; }
    .toggle-label input:checked + .toggle-track { background: #a855f7; }
    .toggle-label input:checked + .toggle-track::after { background: white; transform: translateX(12px); }
    .endpoint { display: none; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
    @keyframes pulse { from { opacity: .4; } to { opacity: 1; } }
    @media (max-width: 360px) {
      .composer-toolbar { flex-wrap: wrap; }
      .toolbar-spacer { display: none; }
      #model { max-width: 118px; }
    }
  </style>
</head>
<body>
  <div id="timeline" class="timeline"><div class="empty"></div></div>
  <div id="workspaceNotice" class="notice"><span id="workspaceNoticeText"></span><button id="workspaceAction" class="secondary"></button></div>
  <div id="errorBox" class="error-box"></div>
  <section class="card composer">
    <textarea id="prompt" aria-label="Coding task" placeholder="Ask a question or describe a task..."></textarea>
    <button id="run" title="Run agent (Ctrl+Enter)">&#8593;</button>
    <div class="composer-toolbar">
      <button id="workspaceContext" class="toolbar-button" title="Add workspace context">#</button>
      <button id="fileContext" class="toolbar-button" title="Mention a file">&#128206;</button>
      <button id="refresh" class="status-button" title="Detect local runtimes"><span id="statusDot" class="status"></span><span id="sidecarText" class="sr-only">Sidecar stopped</span></button>
      <select id="runtime" class="toolbar-select" aria-label="Local runtime"></select>
      <select id="model" class="toolbar-select" aria-label="Local model"><option value="">Detecting...</option></select>
      <span class="toolbar-spacer"></span>
      <select id="mode" class="toolbar-select" aria-label="Agent mode"><option value="default">Auto Agent</option><option value="chat">Chat</option><option value="agent">Agent v2</option></select>
      <label class="toggle-label" title="Allow bounded automatic repair cycles"><span>Autopilot</span><input id="autopilot" type="checkbox" checked><span class="toggle-track"></span></label>
      <button id="cancel" class="secondary">Stop</button>
      <button id="collapseResponses" class="toolbar-button" title="Collapse all responses" aria-label="Collapse all responses">&#8648;</button>
      <button id="settings" class="toolbar-button" title="Forge settings">...</button>
    </div>
    <div id="endpoint" class="endpoint"></div>
  </section>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const saved = vscode.getState() || {};
    const runtimeSelect = document.getElementById('runtime');
    const modelSelect = document.getElementById('model');
    const endpoint = document.getElementById('endpoint');
    const prompt = document.getElementById('prompt');
    const runButton = document.getElementById('run');
    const cancelButton = document.getElementById('cancel');
    const refreshButton = document.getElementById('refresh');
    const timeline = document.getElementById('timeline');
    const errorBox = document.getElementById('errorBox');
    const workspaceNotice = document.getElementById('workspaceNotice');
    const workspaceNoticeText = document.getElementById('workspaceNoticeText');
    const workspaceAction = document.getElementById('workspaceAction');
    const autopilot = document.getElementById('autopilot');
    const modeSelect = document.getElementById('mode');
    const collapseResponsesButton = document.getElementById('collapseResponses');
    let runtimes = [];
    let configured;
    let running = false;
    let workspaceState = { trusted: false, hasFolder: false };
    const chatMessages = [];
    prompt.value = saved.prompt || '';
    autopilot.checked = saved.autopilot !== false;
    modeSelect.value = ['default', 'chat', 'agent'].includes(saved.mode) ? saved.mode : 'default';

    function currentRuntime() { return runtimes.find(item => item.kind === runtimeSelect.value); }
    function saveState() { vscode.setState({ prompt: prompt.value, runtime: runtimeSelect.value, model: modelSelect.value, autopilot: autopilot.checked, mode: modeSelect.value }); }
    function resizePrompt() {
      prompt.style.height = 'auto';
      prompt.style.height = Math.min(prompt.scrollHeight, 180) + 'px';
    }
    function showError(message) { errorBox.textContent = message; errorBox.style.display = message ? 'block' : 'none'; }
    function updateRunAvailability() {
      const runtime = currentRuntime();
      const trustBlocked = modeSelect.value === 'agent' && !workspaceState.trusted;
      runButton.disabled = running || !workspaceState.hasFolder || trustBlocked || !runtime?.reachable || !modelSelect.value;
    }
    function renderWorkspaceState() {
      if (!workspaceState.hasFolder) {
        workspaceNotice.style.display = 'flex';
        workspaceNoticeText.textContent = 'Open a local folder to start a Forge agent task.';
        workspaceAction.textContent = 'Open Folder';
      } else if (!workspaceState.trusted) {
        workspaceNotice.style.display = 'flex';
        workspaceNoticeText.textContent = 'Chat is available. Repository agent tasks require workspace trust.';
        workspaceAction.textContent = 'Manage Trust';
      } else {
        workspaceNotice.style.display = 'none';
      }
      updateRunAvailability();
    }
    function setRunning(value) {
      running = value;
      refreshButton.disabled = value;
      runtimeSelect.disabled = value;
      modelSelect.disabled = value;
      cancelButton.style.display = value ? 'block' : 'none';
      runButton.textContent = value ? '...' : String.fromCharCode(8593);
      runButton.title = value ? 'Agent is working' : 'Run agent (Ctrl+Enter)';
      updateRunAvailability();
    }
    function renderModels(preferred) {
      const runtime = currentRuntime();
      modelSelect.replaceChildren();
      const models = runtime?.models || [];
      if (!models.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = runtime?.reachable ? 'No models loaded' : 'Runtime unavailable';
        modelSelect.append(option);
      } else {
        for (const name of models) {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name;
          modelSelect.append(option);
        }
        const desired = preferred || saved.model || configured?.model;
        if (desired && models.includes(desired)) modelSelect.value = desired;
      }
      endpoint.textContent = runtime ? runtime.endpoint + (runtime.reachable ? ' - ' + runtime.latencyMs + ' ms' : ' - not reachable') : '';
      updateRunAvailability();
      saveState();
    }
    function renderRuntimes(preferredKind) {
      runtimeSelect.replaceChildren();
      if (!runtimes.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = workspaceState.hasFolder ? 'No local runtimes detected' : 'Open a folder first';
        runtimeSelect.append(option);
      }
      for (const runtime of runtimes) {
        const option = document.createElement('option');
        option.value = runtime.kind;
        option.textContent = runtime.label;
        runtimeSelect.append(option);
      }
      const desired = saved.runtime || preferredKind;
      if (desired && runtimes.some(item => item.kind === desired)) runtimeSelect.value = desired;
      if (!currentRuntime()?.reachable) {
        const firstReachable = runtimes.find(item => item.reachable);
        if (firstReachable) runtimeSelect.value = firstReachable.kind;
      }
      renderModels();
    }
    function appendInline(container, value) {
      const text = String(value || '');
      const inlineMark = String.fromCharCode(96);
      let position = 0;
      const appendText = value => { if (value) container.append(document.createTextNode(value)); };
      while (position < text.length) {
        if (text.startsWith('**', position) || text.startsWith('__', position)) {
          const marker = text.slice(position, position + 2);
          const end = text.indexOf(marker, position + 2);
          if (end > position + 2) {
            const strong = document.createElement('strong');
            strong.textContent = text.slice(position + 2, end);
            container.append(strong);
            position = end + 2;
            continue;
          }
        }
        if (text[position] === inlineMark) {
          const end = text.indexOf(inlineMark, position + 1);
          if (end > position + 1) {
            const code = document.createElement('code');
            code.textContent = text.slice(position + 1, end);
            container.append(code);
            position = end + 1;
            continue;
          }
        }
        if (text[position] === '[') {
          const labelEnd = text.indexOf('](', position + 1);
          const urlEnd = labelEnd >= 0 ? text.indexOf(')', labelEnd + 2) : -1;
          if (labelEnd > position + 1 && urlEnd > labelEnd + 2) {
            const url = text.slice(labelEnd + 2, urlEnd).trim();
            if (/^https?:\/\//i.test(url)) {
              const link = document.createElement('a');
              link.href = url;
              link.textContent = text.slice(position + 1, labelEnd);
              link.title = url;
              link.addEventListener('click', event => {
                event.preventDefault();
                vscode.postMessage({ type: 'openLink', url });
              });
              container.append(link);
              position = urlEnd + 1;
              continue;
            }
          }
        }
        if ((text[position] === '*' || text[position] === '_') && text[position + 1] !== text[position]) {
          const marker = text[position];
          const end = text.indexOf(marker, position + 1);
          if (end > position + 1) {
            const emphasis = document.createElement('em');
            emphasis.textContent = text.slice(position + 1, end);
            container.append(emphasis);
            position = end + 1;
            continue;
          }
        }
        const candidates = [text.indexOf('**', position + 1), text.indexOf('__', position + 1), text.indexOf(inlineMark, position + 1), text.indexOf('[', position + 1), text.indexOf('*', position + 1), text.indexOf('_', position + 1)].filter(index => index >= 0);
        const next = candidates.length ? Math.min(...candidates) : text.length;
        appendText(text.slice(position, next));
        position = next;
      }
    }
    function isHorizontalRule(value) {
      const compact = value.replace(/\s/g, '');
      return compact.length >= 3 && ['-', '*', '_'].includes(compact[0]) && compact.split('').every(character => character === compact[0]);
    }
    function listMatch(value) { return value.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/); }
    function headingMatch(value) { return value.match(/^\s{0,3}(#{1,6})\s+(.+)$/); }
    function isBlockStart(value, fence) {
      const trimmed = value.trimStart();
      return trimmed.startsWith(fence) || Boolean(headingMatch(value)) || Boolean(listMatch(value)) || trimmed.startsWith('>') || isHorizontalRule(trimmed);
    }
    function appendCodeBlock(container, language, value) {
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';
      const head = document.createElement('div');
      head.className = 'code-head';
      const label = document.createElement('span');
      label.textContent = language || 'code';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'code-copy';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => {
        vscode.postMessage({ type: 'copy', text: value });
        copy.textContent = 'Copied';
        window.setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
      });
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = value;
      pre.append(code);
      head.append(label, copy);
      wrapper.append(head, pre);
      container.append(wrapper);
    }
    function renderMarkdown(container, value) {
      const fence = String.fromCharCode(96, 96, 96);
      const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
      let index = 0;
      while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();
        if (!trimmed) { index += 1; continue; }
        if (line.trimStart().startsWith(fence)) {
          const language = line.trimStart().slice(fence.length).trim().split(/\s+/)[0].slice(0, 40);
          const codeLines = [];
          index += 1;
          while (index < lines.length && !lines[index].trimStart().startsWith(fence)) {
            codeLines.push(lines[index]);
            index += 1;
          }
          if (index < lines.length) index += 1;
          appendCodeBlock(container, language, codeLines.join('\n'));
          continue;
        }
        const heading = headingMatch(line);
        if (heading) {
          const node = document.createElement('h' + heading[1].length);
          appendInline(node, heading[2]);
          container.append(node);
          index += 1;
          continue;
        }
        if (isHorizontalRule(trimmed)) {
          container.append(document.createElement('hr'));
          index += 1;
          continue;
        }
        if (line.trimStart().startsWith('>')) {
          const quoted = [];
          while (index < lines.length && lines[index].trimStart().startsWith('>')) {
            quoted.push(lines[index].trimStart().slice(1).replace(/^\s/, ''));
            index += 1;
          }
          const quote = document.createElement('blockquote');
          renderMarkdown(quote, quoted.join('\n'));
          container.append(quote);
          continue;
        }
        const firstListItem = listMatch(line);
        if (firstListItem) {
          const ordered = /^\d/.test(firstListItem[1]);
          const list = document.createElement(ordered ? 'ol' : 'ul');
          while (index < lines.length) {
            const itemMatch = listMatch(lines[index]);
            if (!itemMatch || /^\d/.test(itemMatch[1]) !== ordered) break;
            const item = document.createElement('li');
            appendInline(item, itemMatch[2]);
            list.append(item);
            index += 1;
          }
          container.append(list);
          continue;
        }
        const paragraphLines = [trimmed];
        index += 1;
        while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index], fence)) {
          paragraphLines.push(lines[index].trim());
          index += 1;
        }
        const paragraph = document.createElement('p');
        appendInline(paragraph, paragraphLines.join(' '));
        container.append(paragraph);
      }
    }
    function updateCollapseButton() {
      const openResponses = timeline.querySelectorAll('details.response[open]').length;
      collapseResponsesButton.title = openResponses ? 'Collapse all responses' : 'Expand all responses';
      collapseResponsesButton.setAttribute('aria-label', collapseResponsesButton.title);
      collapseResponsesButton.textContent = String.fromCharCode(openResponses ? 8648 : 8650);
    }
    function appendEvent(event) {
      timeline.querySelector('.empty')?.remove();
      const isResponse = event.status !== 'user';
      if (event.status === 'assistant') {
        timeline.querySelectorAll('details.response.assistant[open]').forEach(response => { response.open = false; });
      }
      const item = document.createElement(isResponse ? 'details' : 'div');
      item.className = 'event ' + event.status + (isResponse ? ' response' : '');
      if (isResponse) item.open = event.status === 'assistant' || event.status === 'running' || event.status === 'error';
      const head = document.createElement(isResponse ? 'summary' : 'div');
      head.className = 'event-head';
      const title = document.createElement('span');
      title.className = 'event-title';
      title.textContent = event.title;
      const phase = document.createElement('span');
      phase.className = 'event-phase';
      phase.textContent = event.phase;
      const message = document.createElement('div');
      message.className = 'event-message' + (isResponse ? ' markdown' : '');
      if (isResponse) renderMarkdown(message, event.message);
      else message.textContent = event.message;
      head.append(title, phase);
      if (isResponse) {
        const body = document.createElement('div');
        body.className = 'event-body';
        body.append(message);
        if (event.kind === 'run.suspended' && event.data && typeof event.data.runId === 'string' && Array.isArray(event.data.allowedActions)) {
          const actions = document.createElement('div');
          actions.className = 'decision-actions';
          const labels = { approve: 'Approve risk', retry: 'Retry with guidance', discard: 'Discard run' };
          for (const decision of event.data.allowedActions) {
            if (!Object.hasOwn(labels, decision)) continue;
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = labels[decision];
            if (decision === 'discard') button.className = 'danger';
            button.addEventListener('click', () => {
              actions.querySelectorAll('button').forEach(item => { item.disabled = true; });
              vscode.postMessage({ type: 'decision', runId: event.data.runId, decision });
            });
            actions.append(button);
          }
          body.append(actions);
        }
        item.append(head, body);
        item.addEventListener('toggle', updateCollapseButton);
      } else {
        item.append(head, message);
      }
      timeline.append(item);
      updateCollapseButton();
      timeline.scrollTop = timeline.scrollHeight;
    }
    function insertContextToken(token) {
      const separator = prompt.value && !prompt.value.endsWith(' ') ? ' ' : '';
      prompt.value += separator + token + ' ';
      prompt.focus();
      resizePrompt();
      saveState();
    }

    runtimeSelect.addEventListener('change', () => renderModels());
    modelSelect.addEventListener('change', saveState);
    autopilot.addEventListener('change', saveState);
    modeSelect.addEventListener('change', () => { saveState(); updateRunAvailability(); });
    prompt.addEventListener('input', () => { resizePrompt(); saveState(); });
    prompt.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.ctrlKey) {
        event.preventDefault();
        runButton.click();
      }
    });
    document.getElementById('workspaceContext').addEventListener('click', () => insertContextToken('#workspace'));
    document.getElementById('fileContext').addEventListener('click', () => insertContextToken('@file'));
    refreshButton.addEventListener('click', () => { showError(''); vscode.postMessage({ type: 'refresh' }); });
    document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'settings' }));
    collapseResponsesButton.addEventListener('click', () => {
      const responses = [...timeline.querySelectorAll('details.response')];
      const shouldOpen = !responses.some(response => response.open);
      responses.forEach(response => { response.open = shouldOpen; });
      updateCollapseButton();
    });
    workspaceAction.addEventListener('click', () => vscode.postMessage({ type: workspaceState.hasFolder ? 'trust' : 'openFolder' }));
    cancelButton.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    runButton.addEventListener('click', () => {
      showError('');
      if (!workspaceState.hasFolder) return vscode.postMessage({ type: 'openFolder' });
      if (!workspaceState.trusted && modeSelect.value === 'agent') return vscode.postMessage({ type: 'trust' });
      const runtime = currentRuntime();
      if (!runtime || !modelSelect.value) return showError('Select a reachable runtime and model.');
      const isConversation = modeSelect.value === 'chat';
      const history = chatMessages.slice(-12);
      appendEvent({ status: 'user', title: 'You', phase: 'task', message: prompt.value });
      if (isConversation) chatMessages.push({ role: 'user', content: prompt.value });
      vscode.postMessage({
        type: 'run',
        prompt: prompt.value,
        provider: { kind: runtime.kind, endpoint: runtime.endpoint, model: modelSelect.value, temperature: configured?.temperature ?? 0.1 },
        maxRepairCycles: autopilot.checked ? undefined : 0,
        mode: modeSelect.value,
        history
      });
      prompt.value = '';
      resizePrompt();
      saveState();
    });

    window.addEventListener('message', ({ data }) => {
      if (data.type === 'sidecar') {
        document.getElementById('sidecarText').textContent = 'Sidecar ' + data.state;
        const dot = document.getElementById('statusDot');
        dot.className = 'status ' + data.state;
        dot.title = data.detail || '';
      } else if (data.type === 'runtimes') {
        runtimes = data.runtimes || [];
        configured = data.configured;
        renderRuntimes(configured?.kind);
      } else if (data.type === 'workspace') {
        workspaceState = { trusted: Boolean(data.trusted), hasFolder: Boolean(data.hasFolder) };
        renderWorkspaceState();
      } else if (data.type === 'loading') {
        refreshButton.classList.toggle('loading', Boolean(data.value));
        refreshButton.title = data.value ? 'Detecting local runtimes...' : 'Detect local runtimes';
      } else if (data.type === 'runState') {
        setRunning(data.running);
      } else if (data.type === 'agentEvent') {
        appendEvent(data.event);
      } else if (data.type === 'agentRoute') {
        const decision = data.decision || {};
        appendEvent({ status: decision.intent === 'CLARIFY' ? 'info' : 'success', title: 'Auto Agent → ' + (decision.intent || 'CLARIFY'), phase: 'system', message: decision.rationale || 'Intent route selected.' });
        if ((decision.target === 'chat' || decision.target === 'clarify') && data.prompt) {
          chatMessages.push({ role: 'user', content: data.prompt });
        }
      } else if (data.type === 'chatResponse') {
        chatMessages.push({ role: 'assistant', content: data.message });
        appendEvent({ status: 'assistant', title: 'Forge', phase: 'chat', message: data.message });
      } else if (data.type === 'reviewStarted') {
        appendEvent({ status: 'running', title: 'Repository review started', phase: 'review', message: 'Capturing a source-only snapshot and gathering focused evidence.' });
      } else if (data.type === 'reviewResponse') {
        appendEvent({ status: 'assistant', title: 'Forge Review', phase: 'review', message: data.message });
        appendEvent({ status: 'success', title: 'Read-only review completed', phase: 'system', message: (data.fileCount || 0) + ' source files considered; ' + (data.evidenceCount || 0) + ' focused evidence regions supplied to the model.' });
      } else if (data.type === 'cancelled') {
        appendEvent({ status: 'info', title: 'Run cancelled', phase: 'system', message: 'The active local-model request was stopped.' });
      } else if (data.type === 'error') {
        showError(data.message);
        setRunning(false);
      }
    });
    resizePrompt();
    renderWorkspaceState();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
