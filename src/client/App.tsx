import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type BeforeMount } from "@monaco-editor/react";
import {
  Blocks,
  Bot,
  Bug,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Files,
  GitBranch,
  LayoutPanelLeft,
  Maximize2,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Square,
  Terminal,
  TerminalSquare,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import type { editor } from "monaco-editor";
import { AgentPanel, type ForgeChatMessage } from "./AgentPanel";
import { EDITOR_THEME, useSystemTheme } from "./theme";
import { createWorkspaceEntry, deleteWorkspaceEntry, fetchFile, fetchModels, fetchRuntimes, fetchTree, fetchWorkspaceStatus, renameWorkspaceEntry, saveFile, sendChat, streamAgentDecision, streamAgentRun } from "./api";
import { PanelResizer } from "./PanelResizer";
import { TerminalView } from "./TerminalView";
import { WorkbenchPanel, type WorkbenchView } from "./WorkbenchPanel";
import type {
  AgentEvent,
  ProviderConfig,
  ProviderKind,
  RuntimeStatus,
  TreeNode,
  WorkspaceStatus,
  WorkspaceFile,
} from "../shared/types";

// The mark is ink on transparency, so it needs the variant that contrasts with
// whichever chrome is showing: light ink on the dark theme, dark ink on light.
const FORGE_MARK = {
  dark: new URL("./assets/forge-mark-light.png", import.meta.url).href,
  light: new URL("./assets/forge-mark-dark.png", import.meta.url).href,
};

const DEFAULTS: Record<ProviderKind, ProviderConfig> = {
  ollama: {
    kind: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "",
    temperature: 0.1,
  },
  lmstudio: {
    kind: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "",
    temperature: 0.1,
  },
  llamacpp: {
    kind: "llamacpp",
    endpoint: "http://127.0.0.1:8080",
    model: "",
    temperature: 0.1,
  },
};

// Column limits. The editor keeps EDITOR_MIN so a wide side panel can never
// squeeze it out; the caps stop a panel eating the window on a large display.
const RAIL_WIDTH = 54;
const EDITOR_MIN = 320;
const EXPLORER = { min: 170, cap: 560, preset: 250 };
// The floor matches .agent-panel's CSS min-width; a smaller inline width would
// simply be ignored and the handle would appear stuck.
const AGENT = { min: 320, cap: 760, preset: 390 };

function loadStoredWidth(key: string, fallback: number, min: number, cap: number): number {
  try {
    const stored = Number(localStorage.getItem(key));
    if (!Number.isFinite(stored) || stored <= 0) return fallback;
    return Math.round(Math.min(cap, Math.max(min, stored)));
  } catch {
    return fallback;
  }
}

function loadStoredConfig(): ProviderConfig {
  try {
    const stored = localStorage.getItem("forge.provider");
    return stored ? { ...DEFAULTS.ollama, ...JSON.parse(stored) } : DEFAULTS.ollama;
  } catch {
    return DEFAULTS.ollama;
  }
}

function flattenFiles(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => node.type === "file" ? [node] : flattenFiles(node.children || []));
}

function basename(filePath: string): string {
  return filePath.split("/").at(-1) || filePath;
}

function chooseDetectedProvider(current: ProviderConfig, runtimes: RuntimeStatus[]): ProviderConfig {
  const currentRuntime = runtimes.find((runtime) => runtime.kind === current.kind && runtime.reachable && runtime.models.length);
  const selectedRuntime = currentRuntime || runtimes.find((runtime) => runtime.reachable && runtime.models.length);
  if (!selectedRuntime) return { ...current, model: "" };
  return {
    ...current,
    kind: selectedRuntime.kind,
    endpoint: selectedRuntime.endpoint,
    model: selectedRuntime.models.includes(current.model) ? current.model : selectedRuntime.models[0],
  };
}

function EditorTabs({
  tabs,
  activePath,
  drafts,
  onActivate,
  onClose,
  onSplit,
  onActions,
}: {
  tabs: WorkspaceFile[];
  activePath?: string;
  drafts: Record<string, string>;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onSplit: () => void;
  onActions: () => void;
}) {
  return (
    <div className="editor-tabs">
      {tabs.map((tab) => {
        const dirty = drafts[tab.path] !== undefined && drafts[tab.path] !== tab.content;
        return (
          <button
            key={tab.path}
            className={`editor-tab ${activePath === tab.path ? "active" : ""}`}
            onClick={() => onActivate(tab.path)}
            title={tab.path}
          >
            <Code2 />
            <span>{basename(tab.path)}</span>
            {dirty ? <i className="dirty-dot" /> : <X onClick={(event) => { event.stopPropagation(); onClose(tab.path); }} />}
          </button>
        );
      })}
      <div className="tabs-spacer" />
      <button className="tabs-action" title="Split editor" onClick={onSplit}><LayoutPanelLeft /></button>
      <button className="tabs-action" title="Editor actions" onClick={onActions}><span>•••</span></button>
    </div>
  );
}

function SettingsModal({
  config,
  runtimes,
  onClose,
  onSave,
}: {
  config: ProviderConfig;
  runtimes: RuntimeStatus[];
  onClose: () => void;
  onSave: (config: ProviderConfig) => void;
}) {
  const [draft, setDraft] = useState(config);
  const initialRuntime = runtimes.find((runtime) => runtime.kind === config.kind);
  const [models, setModels] = useState<string[]>(initialRuntime?.models || []);
  const [connection, setConnection] = useState<"idle" | "loading" | "success" | "error">(
    initialRuntime?.reachable ? "success" : initialRuntime ? "error" : "idle",
  );
  const [message, setMessage] = useState(
    initialRuntime?.reachable
      ? `${initialRuntime.models.length} local model${initialRuntime.models.length === 1 ? "" : "s"} detected automatically.`
      : initialRuntime?.error || "Scanning for local model servers…",
  );

  const setKind = (kind: ProviderKind) => {
    const runtime = runtimes.find((item) => item.kind === kind);
    const next = {
      ...DEFAULTS[kind],
      endpoint: runtime?.endpoint || DEFAULTS[kind].endpoint,
      model: runtime?.models[0] || "",
      temperature: draft.temperature,
    };
    setDraft(next);
    setModels(runtime?.models || []);
    setConnection(runtime?.reachable ? "success" : runtime ? "error" : "idle");
    setMessage(runtime?.reachable
      ? `${runtime.models.length} local model${runtime.models.length === 1 ? "" : "s"} detected automatically.`
      : runtime?.error || "Click retry to scan this endpoint.");
  };

  const discover = async () => {
    setConnection("loading");
    setMessage("Connecting to the local inference server…");
    try {
      const result = await fetchModels(draft);
      setModels(result);
      setConnection("success");
      setMessage(result.length ? `${result.length} local model${result.length === 1 ? "" : "s"} available.` : "Connected, but no models were reported.");
      if (result.length && !result.includes(draft.model)) setDraft((current) => ({ ...current, model: result[0] }));
    } catch (error) {
      setConnection("error");
      setMessage(error instanceof Error ? error.message : "Could not connect.");
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span className="settings-icon"><Settings /></span><div><h2>Local model runtime</h2><p>Inference stays on your machine.</p></div></div>
          <button onClick={onClose}><X /></button>
        </header>
        <div className="runtime-tabs">
          {(Object.keys(DEFAULTS) as ProviderKind[]).map((kind) => {
            const runtime = runtimes.find((item) => item.kind === kind);
            return (
              <button key={kind} className={draft.kind === kind ? "active" : ""} onClick={() => setKind(kind)}>
                <i className={runtime?.reachable && runtime.models.length ? "online" : "offline"} />
                {kind === "ollama" ? "Ollama" : kind === "lmstudio" ? "LM Studio" : "llama.cpp"}
                {runtime?.models.length ? <small>{runtime.models.length}</small> : null}
              </button>
            );
          })}
        </div>
        <div className="settings-form">
          <label>
            <span>Server endpoint</span>
            <input value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} />
            <small>Only localhost and 127.0.0.1 endpoints are accepted by the API.</small>
          </label>
          <label>
            <span>Model</span>
            {models.length ? (
              <select value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })}>
                {models.map((model) => <option key={model}>{model}</option>)}
              </select>
            ) : (
              <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="No model detected" />
            )}
          </label>
          <label>
            <span>Temperature <strong>{draft.temperature.toFixed(1)}</strong></span>
            <input type="range" min="0" max="1" step="0.1" value={draft.temperature} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })} />
          </label>
          <div className={`connection-result ${connection}`}>
            <span>{connection === "success" ? <Check /> : connection === "error" ? <X /> : <Zap />}</span>
            <p>{message}</p>
            <button onClick={discover} disabled={connection === "loading"}>{connection === "loading" ? "Scanning…" : "Retry discovery"}</button>
          </div>
        </div>
        <footer>
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onSave(draft)}>Save runtime</button>
        </footer>
      </div>
    </div>
  );
}

export default function App() {
  const theme = useSystemTheme();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [workspacePath, setWorkspacePath] = useState("");
  const [tabs, setTabs] = useState<WorkspaceFile[]>([]);
  const [activePath, setActivePath] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>("explorer");
  const [agentOpen, setAgentOpen] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState(() => loadStoredWidth("forge.layout.explorer", EXPLORER.preset, EXPLORER.min, EXPLORER.cap));
  const [agentWidth, setAgentWidth] = useState(() => loadStoredWidth("forge.layout.agent", AGENT.preset, AGENT.min, AGENT.cap));
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === "undefined" ? 1600 : window.innerWidth));
  const [editorMaximized, setEditorMaximized] = useState(false);
  const [splitEditor, setSplitEditor] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [config, setConfig] = useState<ProviderConfig>(loadStoredConfig);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [task, setTask] = useState("");
  // The event timeline is a system log, not a chat transcript — it never
  // echoes the request that produced it. This holds the submitted objective
  // so an Agent v2 run can show what was actually asked, the way chat mode
  // shows the user's message bubble.
  const [runObjective, setRunObjective] = useState("");
  // Retry guidance is collected in-app rather than through window.prompt,
  // which throws in Electron ("prompt() is not supported.") and is blocked in
  // the Code-OSS webview — both shells this UI actually ships in. null keeps
  // the dialog closed.
  const [retryGuidance, setRetryGuidance] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<ForgeChatMessage[]>([]);
  const [agentMode, setAgentMode] = useState<"chat" | "agent">("chat");
  const [agentError, setAgentError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [discoveringRuntimes, setDiscoveringRuntimes] = useState(true);
  const [workspaceStatus, setWorkspaceStatus] = useState<WorkspaceStatus>({ isRepository: false, branch: "", changes: [] });
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const controllerRef = useRef<AbortController>();
  const bootstrappedRef = useRef(false);
  const fileHistoryRef = useRef<string[]>([]);
  const fileHistoryIndexRef = useRef(-1);
  const desktop = Boolean(window.forgeDesktop);

  const activeFile = tabs.find((tab) => tab.path === activePath);
  const activeDraft = activePath ? drafts[activePath] ?? activeFile?.content ?? "" : "";
  const dirty = Boolean(activeFile && activeDraft !== activeFile.content);
  const rootName = workspacePath.split(/[\\/]/).filter(Boolean).at(-1)?.toUpperCase() || "WORKSPACE";
  const activeRuntime = runtimes.find((runtime) => runtime.kind === config.kind);

  // A panel may only grow into space the other columns are not using, so the
  // editor always keeps EDITOR_MIN no matter how narrow the window gets.
  const explorerMax = Math.max(
    EXPLORER.min,
    Math.min(EXPLORER.cap, viewportWidth - RAIL_WIDTH - EDITOR_MIN - (agentOpen ? agentWidth : 0)),
  );
  const agentMax = Math.max(
    AGENT.min,
    Math.min(AGENT.cap, viewportWidth - RAIL_WIDTH - EDITOR_MIN - (explorerOpen ? explorerWidth : 0)),
  );

  // State holds the width the user asked for; the fit to the current window is
  // applied only at render. Clamping the stored value instead would make a
  // temporary narrow window permanently shrink the layout.
  const appliedExplorerWidth = Math.min(explorerWidth, explorerMax);
  const appliedAgentWidth = Math.min(agentWidth, agentMax);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("forge.layout.explorer", String(explorerWidth));
      localStorage.setItem("forge.layout.agent", String(agentWidth));
    } catch {
      // A locked-down storage policy only costs the remembered layout.
    }
  }, [explorerWidth, agentWidth]);

  const refreshRuntimes = useCallback(async () => {
    setDiscoveringRuntimes(true);
    try {
      const discovered = await fetchRuntimes();
      setRuntimes(discovered);
      setConfig((current) => {
        const next = chooseDetectedProvider(current, discovered);
        localStorage.setItem("forge.provider", JSON.stringify(next));
        return next;
      });
      if (!discovered.some((runtime) => runtime.reachable && runtime.models.length)) {
        setAgentError("No ready local models were detected. Start Ollama, the LM Studio local server, or llama.cpp, then retry discovery in Settings.");
      } else {
        setAgentError(undefined);
      }
      return discovered;
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Local runtime discovery failed.");
      return [];
    } finally {
      setDiscoveringRuntimes(false);
    }
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      const result = await fetchTree();
      setTree(result.nodes);
      setWorkspacePath(result.root);
      return result.nodes;
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Could not read the workspace.");
      return [];
    }
  }, []);

  const openFile = useCallback(async (filePath: string, force = false, recordHistory = true) => {
    const existing = tabs.find((tab) => tab.path === filePath);
    if (existing && !force) {
      setActivePath(filePath);
      if (recordHistory && fileHistoryRef.current[fileHistoryIndexRef.current] !== filePath) {
        fileHistoryRef.current = [...fileHistoryRef.current.slice(0, fileHistoryIndexRef.current + 1), filePath].slice(-50);
        fileHistoryIndexRef.current = fileHistoryRef.current.length - 1;
      }
      return;
    }
    setLoadingFile(true);
    try {
      const file = await fetchFile(filePath);
      setTabs((current) => current.some((tab) => tab.path === file.path)
        ? current.map((tab) => tab.path === file.path ? file : tab)
        : [...current, file]);
      setDrafts((current) => ({ ...current, [file.path]: file.content }));
      setActivePath(file.path);
      if (recordHistory && fileHistoryRef.current[fileHistoryIndexRef.current] !== file.path) {
        fileHistoryRef.current = [...fileHistoryRef.current.slice(0, fileHistoryIndexRef.current + 1), file.path].slice(-50);
        fileHistoryIndexRef.current = fileHistoryRef.current.length - 1;
      }
      setAgentError(undefined);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Could not open the file.");
    } finally {
      setLoadingFile(false);
    }
  }, [tabs]);

  const createWorkspaceItem = useCallback(async (name: string, kind: "file" | "directory") => {
    const created = await createWorkspaceEntry(name, kind);
    await refreshTree();
    // Opening the new file mirrors what every editor does after "New File",
    // and gives immediate confirmation the path landed where it was meant to.
    if (kind === "file") await openFile(created.path);
  }, [refreshTree, openFile]);

  /** Drops open tabs for paths that no longer exist under their old name. */
  const forgetPaths = useCallback((prefix: string) => {
    const affected = (tab: WorkspaceFile) => tab.path === prefix || tab.path.startsWith(`${prefix}/`);
    setTabs((current) => {
      const remaining = current.filter((tab) => !affected(tab));
      setActivePath((active) => (active && (active === prefix || active.startsWith(`${prefix}/`))
        ? remaining.at(-1)?.path
        : active));
      return remaining;
    });
    setDrafts((current) => Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== prefix && !key.startsWith(`${prefix}/`)),
    ));
  }, []);

  const renameWorkspaceItem = useCallback(async (fromPath: string, toPath: string) => {
    const renamed = await renameWorkspaceEntry(fromPath, toPath);
    const wasOpen = tabs.some((tab) => tab.path === fromPath);
    forgetPaths(fromPath);
    await refreshTree();
    if (wasOpen) await openFile(renamed.path);
  }, [refreshTree, openFile, forgetPaths, tabs]);

  const deleteWorkspaceItem = useCallback(async (targetPath: string) => {
    await deleteWorkspaceEntry(targetPath);
    forgetPaths(targetPath);
    await refreshTree();
  }, [refreshTree, forgetPaths]);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void (async () => {
      const [nodes] = await Promise.all([refreshTree(), refreshRuntimes(), fetchWorkspaceStatus().then(setWorkspaceStatus).catch(() => undefined)]);
      const files = flattenFiles(nodes);
      const initial = files.find((file) => file.path === "src/client/App.tsx") || files.find((file) => file.path.endsWith(".md")) || files[0];
      if (initial) await openFile(initial.path);
    })();
    // Initial workspace bootstrap only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigateFileHistory = (delta: -1 | 1) => {
    const nextIndex = fileHistoryIndexRef.current + delta;
    const filePath = fileHistoryRef.current[nextIndex];
    if (!filePath) return;
    fileHistoryIndexRef.current = nextIndex;
    void openFile(filePath, false, false);
  };

  const closeTab = (filePath: string) => {
    const index = tabs.findIndex((tab) => tab.path === filePath);
    const remaining = tabs.filter((tab) => tab.path !== filePath);
    setTabs(remaining);
    setDrafts((current) => {
      const next = { ...current };
      delete next[filePath];
      return next;
    });
    if (activePath === filePath) setActivePath(remaining[Math.max(0, index - 1)]?.path);
  };

  const saveActive = useCallback(async () => {
    if (!activeFile || !dirty) return;
    setSaveState("saving");
    try {
      const saved = await saveFile(activeFile, activeDraft);
      setTabs((current) => current.map((tab) => tab.path === saved.path ? saved : tab));
      setDrafts((current) => ({ ...current, [saved.path]: saved.content }));
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1300);
    } catch (error) {
      setSaveState("error");
      setAgentError(error instanceof Error ? error.message : "Save failed.");
    }
  }, [activeDraft, activeFile, dirty]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveActive();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === "Escape") setCommandOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveActive]);

  const switchProvider = (kind: ProviderKind) => {
    const runtime = runtimes.find((item) => item.kind === kind);
    const next = {
      ...DEFAULTS[kind],
      endpoint: runtime?.endpoint || DEFAULTS[kind].endpoint,
      model: runtime?.models[0] || "",
      temperature: config.temperature,
    };
    setConfig(next);
    localStorage.setItem("forge.provider", JSON.stringify(next));
  };

  const switchModel = (model: string) => {
    const next = { ...config, model };
    setConfig(next);
    localStorage.setItem("forge.provider", JSON.stringify(next));
  };

  const openWorkspace = async () => {
    if (!window.forgeDesktop || dirty) {
      if (dirty) setAgentError("Save or close the modified editor tab before switching workspaces.");
      return;
    }
    const selected = await window.forgeDesktop.selectWorkspace();
    if (!selected) return;
    setTabs([]);
    setDrafts({});
    setActivePath(undefined);
    fileHistoryRef.current = [];
    fileHistoryIndexRef.current = -1;
    const nodes = await refreshTree();
    void fetchWorkspaceStatus().then(setWorkspaceStatus);
    const files = flattenFiles(nodes);
    const initial = files.find((file) => file.path.toLowerCase() === "readme.md") || files[0];
    if (initial) await openFile(initial.path);
  };

  const startRun = async () => {
    if (!task.trim() || running) return;
    if (!config.model) {
      setAgentError("Select a detected local model before starting the agent.");
      setSettingsOpen(true);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setAgentError(undefined);
    const prompt = task.trim();
    if (agentMode === "chat") {
      const userMessage: ForgeChatMessage = { id: crypto.randomUUID(), role: "user", content: prompt, timestamp: new Date().toISOString() };
      setChatMessages((current) => [...current, userMessage]);
      setTask("");
      try {
        const answer = await sendChat(prompt, config, chatMessages.map(({ role, content }) => ({ role, content })), controller.signal);
        setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: answer, timestamp: new Date().toISOString() }]);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          const message = error instanceof Error ? error.message : "The local model response failed.";
          setAgentError(message);
          setChatMessages((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: `### Local model error\n\n${message}\n\nOpen **Settings**, refresh discovery, and confirm the selected model is loaded.`, timestamp: new Date().toISOString() }]);
        }
      } finally {
        setRunning(false);
        controllerRef.current = undefined;
      }
      return;
    }
    setEvents([]);
    setRunObjective(prompt);
    setTask("");
    try {
      await streamAgentRun({ prompt, provider: config, maxRepairCycles: 1, maxReplans: 1, maxTasks: 6, architecture: "v2" }, (agentEvent) => {
        setEvents((current) => [...current, agentEvent]);
        if (agentEvent.kind === "promotion.complete") {
          void refreshTree();
          if (activePath && !dirty) setTimeout(() => void openFile(activePath, true), 200);
        }
      }, controller.signal);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setAgentError(error instanceof Error ? error.message : "Agent stream failed.");
      }
    } finally {
      setRunning(false);
      controllerRef.current = undefined;
    }
  };

  const decideSuspendedRun = async (decision: "approve" | "retry" | "discard", guidance?: string) => {
    if (running) return;
    const suspended = events.at(-1);
    const runId = suspended?.kind === "run.suspended" && typeof suspended.data?.runId === "string" ? suspended.data.runId : "";
    if (!runId) {
      setAgentError("The suspended Forge v2 run identifier is unavailable.");
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setAgentError(undefined);
    try {
      await streamAgentDecision({ runId, decision, guidance }, (agentEvent) => {
        setEvents((current) => [...current, agentEvent]);
        if (agentEvent.kind === "promotion.complete") {
          void refreshTree();
          if (activePath && !dirty) setTimeout(() => void openFile(activePath, true), 200);
        }
      }, controller.signal);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setAgentError(error instanceof Error ? error.message : "Could not apply the Forge v2 decision.");
      }
    } finally {
      setRunning(false);
      controllerRef.current = undefined;
    }
  };

  const beforeMount: BeforeMount = (monaco) => {
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
    for (const [mode, definition] of Object.entries(EDITOR_THEME)) {
      monaco.editor.defineTheme(`forge-${mode}`, {
        base: definition.base,
        inherit: true,
        rules: definition.rules,
        colors: {
          ...definition.colors,
          "scrollbarSlider.background": mode === "dark" ? "#5f596944" : "#8b859944",
          "scrollbarSlider.hoverBackground": mode === "dark" ? "#77708066" : "#6f6a7d66",
        },
      });
    }
  };

  const breadcrumb = useMemo(() => activePath?.split("/") || [], [activePath]);
  const activateWorkbench = (view: WorkbenchView) => {
    setWorkbenchView(view);
    setExplorerOpen(true);
    setEditorMaximized(false);
  };
  const commandFiles = useMemo(() => {
    const query = commandQuery.trim().toLowerCase().replace(/^>/, "").trim();
    if (!query) return flattenFiles(tree).slice(0, 10);
    return flattenFiles(tree).filter((file) => file.path.toLowerCase().includes(query)).slice(0, 15);
  }, [commandQuery, tree]);
  const executeCommand = (command: "settings" | "refresh" | "agent" | "checks") => {
    setCommandOpen(false);
    setCommandQuery("");
    if (command === "settings") { setSettingsOpen(true); void refreshRuntimes(); }
    if (command === "refresh") { void refreshTree(); void refreshRuntimes(); void fetchWorkspaceStatus().then(setWorkspaceStatus); }
    if (command === "agent") setAgentOpen(true);
    if (command === "checks") activateWorkbench("run");
  };

  return (
    <main className={`page-shell ${desktop ? "desktop" : ""}`}>
      <section className={`ide-window ${editorMaximized ? "editor-maximized" : ""}`}>
        <header className="titlebar">
          <div className="titlebar-app-name" style={{ paddingLeft: "12px", fontWeight: 750, fontSize: "12px", letterSpacing: "1px", color: "var(--c-n-89)" }}>FORGE IDE</div>
          <div className="nav-controls" />
          <button className="command-center" onClick={() => setCommandOpen(true)}><Search /><span>Search files, symbols, or commands</span><kbd>Ctrl K</kbd></button>
          <div className="titlebar-actions">
            <div className="layout-controls">
              <button title="Toggle explorer" onClick={() => setExplorerOpen((value) => !value)}>{explorerOpen ? <PanelLeftClose /> : <PanelLeftOpen />}</button>
              <button title="Toggle agent" onClick={() => setAgentOpen((value) => !value)}>{agentOpen ? <PanelRightClose /> : <PanelRightOpen />}</button>
              <button title="Settings" onClick={() => { setSettingsOpen(true); void refreshRuntimes(); }}><Settings /></button>
            </div>
            {desktop && <div className="desktop-window-controls">
              <button aria-label="Minimize window" onClick={() => window.forgeDesktop?.windowAction("minimize")}><Minus /></button>
              <button aria-label="Maximize window" onClick={() => window.forgeDesktop?.windowAction("maximize")}><Square /></button>
              <button className="close" aria-label="Close window" onClick={() => window.forgeDesktop?.windowAction("close")}><X /></button>
            </div>}
          </div>
        </header>

        <div className="workbench">
          <div className="sidebar-container">
            <div className="sidebar-body" style={{ display: "flex", flex: 1, minHeight: 0 }}>
              <nav className="activity-rail">
                <button className="brand-mark" title="Forge agent" onClick={() => setAgentOpen(true)}><img src={FORGE_MARK[theme]} alt="" /></button>
                <div className="activity-primary">
                  <button className={explorerOpen && workbenchView === "explorer" ? "active" : ""} title="Explorer" onClick={() => activateWorkbench("explorer")}><Files /></button>
                  <button className={explorerOpen && workbenchView === "search" ? "active" : ""} title="Search" onClick={() => activateWorkbench("search")}><Search /></button>
                  <button className={explorerOpen && workbenchView === "source" ? "active" : ""} title="Source control" onClick={() => activateWorkbench("source")}><GitBranch />{workspaceStatus.changes.length > 0 && <i>{workspaceStatus.changes.length}</i>}</button>
                  <button className={explorerOpen && workbenchView === "run" ? "active" : ""} title="Run and checks" onClick={() => activateWorkbench("run")}><Bug /></button>
                  <button className={explorerOpen && workbenchView === "extensions" ? "active" : ""} title="Extensions" onClick={() => activateWorkbench("extensions")}><Blocks /></button>
                  <button className={agentOpen ? "active" : ""} title="Local agent" onClick={() => setAgentOpen((value) => !value)}><img className="forge-rail-icon" src={FORGE_MARK[theme]} alt="" /></button>
                </div>
                <div className="activity-bottom">
                  <button className={explorerOpen && workbenchView === "security" ? "active" : ""} title="Security policy" onClick={() => activateWorkbench("security")}><ShieldCheck /></button>
                  <button title="Settings" onClick={() => { setSettingsOpen(true); void refreshRuntimes(); }}><Settings /></button>
                </div>
              </nav>

              {explorerOpen && !editorMaximized && (
                <WorkbenchPanel view={workbenchView} nodes={tree} activePath={activePath} rootName={rootName} width={appliedExplorerWidth} onOpen={(path) => void openFile(path)} onRefreshTree={() => void refreshTree()} onOpenWorkspace={desktop ? () => void openWorkspace() : undefined} onOpenSettings={() => { setSettingsOpen(true); void refreshRuntimes(); }} onStatus={setWorkspaceStatus} onCreateEntry={createWorkspaceItem} onRenameEntry={renameWorkspaceItem} onDeleteEntry={deleteWorkspaceItem} />
              )}
            </div>
          </div>

          {explorerOpen && !editorMaximized && (
            <PanelResizer
              className="explorer-resizer"
              label="Resize explorer"
              edge="leading"
              width={appliedExplorerWidth}
              min={EXPLORER.min}
              max={explorerMax}
              onResize={setExplorerWidth}
              onReset={() => setExplorerWidth(EXPLORER.preset)}
            />
          )}

          <section className="editor-pane" style={terminalOpen ? { gridTemplateRows: "43px 34px minmax(0, 1fr) 300px" } : {}}>
            <EditorTabs tabs={tabs} activePath={activePath} drafts={drafts} onActivate={(path) => void openFile(path)} onClose={closeTab} onSplit={() => setSplitEditor((value) => !value)} onActions={() => setCommandOpen(true)} />
            <div className="editor-breadcrumbs">
              {breadcrumb.map((part, index) => (
                <span key={`${part}-${index}`}><Code2 />{part}{index < breadcrumb.length - 1 && <ChevronRight />}</span>
              ))}
              <div className="breadcrumb-actions">
                <button className={dirty ? "save active" : "save"} onClick={() => void saveActive()} disabled={!dirty} title="Save file"><Save /></button>
                <button title="Run checks" onClick={() => activateWorkbench("run")}><Play /></button>
                <button className={terminalOpen ? "active" : ""} title="Toggle terminal" onClick={() => setTerminalOpen((value) => !value)}><TerminalSquare /></button>
                <button className={editorMaximized ? "active" : ""} title={editorMaximized ? "Restore editor" : "Maximize editor"} onClick={() => setEditorMaximized((value) => !value)}><Maximize2 /></button>
              </div>
            </div>
            <div className={`editor-surface ${splitEditor ? "split" : ""}`}>
              {activeFile ? (
                <><Editor
                  height="100%"
                  path={activeFile.path}
                  language={activeFile.language}
                  value={activeDraft}
                  beforeMount={beforeMount}
                  theme={`forge-${theme}`}
                  onChange={(value) => setDrafts((current) => ({ ...current, [activeFile.path]: value ?? "" }))}
                  options={{
                    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
                    fontSize: 13.5,
                    lineHeight: 23,
                    minimap: { enabled: true, maxColumn: 80, scale: 0.75 },
                    padding: { top: 18, bottom: 24 },
                    smoothScrolling: true,
                    cursorSmoothCaretAnimation: "on",
                    wordWrap: "off",
                    renderLineHighlight: "all",
                    roundedSelection: true,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    bracketPairColorization: { enabled: true },
                    guides: { bracketPairs: true, indentation: true },
                  }}
                />
                {splitEditor && <Editor
                  height="100%"
                  path={activeFile.path}
                  language={activeFile.language}
                  value={activeDraft}
                  beforeMount={beforeMount}
                  theme={`forge-${theme}`}
                  onChange={(value) => setDrafts((current) => ({ ...current, [activeFile.path]: value ?? "" }))}
                  options={{
                    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
                    fontSize: 13.5,
                    lineHeight: 23,
                    minimap: { enabled: false },
                    padding: { top: 18, bottom: 24 },
                    smoothScrolling: true,
                    wordWrap: "off",
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                  }}
                />}</>
              ) : (
                <div className="editor-empty">
                  {loadingFile ? <WandSparkles className="float-icon" /> : <Code2 />}
                  <h2>{loadingFile ? "Opening file…" : "Your workspace, under control"}</h2>
                  <p>Select a file from Explorer or ask the local agent to start a task.</p>
                </div>
              )}
            </div>

            {terminalOpen && (
              <div className="bottom-panel" style={{ borderTop: "1px solid var(--c-n-15)", display: "flex", flexDirection: "column", background: "var(--c-n-08)", minHeight: 0 }}>
                <div style={{ height: "34px", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", borderBottom: "1px solid var(--c-n-12)" }}>
                  <span style={{ fontSize: "11px", fontWeight: 650, color: "var(--c-n-54)", textTransform: "uppercase", letterSpacing: "1px" }}>Terminal</span>
                  <button onClick={() => setTerminalOpen(false)} style={{ color: "var(--c-n-44)", background: "none", border: "none", cursor: "pointer", display: "grid", placeItems: "center" }}><X size={14} /></button>
                </div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <TerminalView />
                </div>
              </div>
            )}
          </section>

          {agentOpen && !editorMaximized && (
            <PanelResizer
              className="agent-resizer"
              label="Resize agent panel"
              edge="trailing"
              width={appliedAgentWidth}
              min={AGENT.min}
              max={agentMax}
              onResize={setAgentWidth}
              onReset={() => setAgentWidth(AGENT.preset)}
            />
          )}

          {agentOpen && !editorMaximized && (
            <AgentPanel
              width={appliedAgentWidth}
              events={events}
              objective={runObjective}
              messages={chatMessages}
              mode={agentMode}
              running={running}
              config={config}
              task={task}
              error={agentError}
              runtime={activeRuntime}
              onTaskChange={setTask}
              onRun={() => void startRun()}
              onCancel={() => controllerRef.current?.abort()}
              onOpenSettings={() => { setSettingsOpen(true); void refreshRuntimes(); }}
              onProviderChange={switchProvider}
              onModelChange={switchModel}
              onModeChange={setAgentMode}
              onRefreshModels={() => void refreshRuntimes()}
              onNewSession={() => { if (!running) { setEvents([]); setChatMessages([]); setAgentError(undefined); setTask(""); setRunObjective(""); } }}
              onDecision={(decision) => {
                if (decision === "retry") {
                  setRetryGuidance("Address the reported diagnostics without widening the requested scope.");
                  return;
                }
                void decideSuspendedRun(decision);
              }}
            />
          )}
        </div>

        <footer className="statusbar">
          <div><span className="branch"><GitBranch /> {workspaceStatus.isRepository ? workspaceStatus.branch || "detached" : "no repository"}{workspaceStatus.changes.length ? "*" : ""}</span><span><Check /> {workspaceStatus.changes.length}</span><span><X /> {agentError ? 1 : 0}</span></div>
          <div>
            <span>{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : dirty ? "Modified" : "Synced"}</span>
            <span>{discoveringRuntimes ? "Detecting runtimes…" : activeRuntime?.reachable ? `${activeRuntime.label} · ${config.model || "no model"}` : "Runtime offline"}</span>
            <span>UTF-8</span><span>LF</span><span>{activeFile?.language || "Plain Text"}</span><span><Terminal /> {desktop ? "Desktop" : "Local"}</span>
          </div>
        </footer>
      </section>

      {commandOpen && (
        <div className="command-backdrop" onMouseDown={() => setCommandOpen(false)}>
          <section className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
            <label><Search /><input autoFocus value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="Search files or type a command" /></label>
            <div className="command-results">
              <div className="command-group-title">Commands</div>
              <button onClick={() => executeCommand("settings")}><Settings /><span>Forge: Open Local Model Settings</span><kbd>Settings</kbd></button>
              <button onClick={() => executeCommand("refresh")}><Zap /><span>Forge: Refresh Workspace and Models</span><kbd>Refresh</kbd></button>
              <button onClick={() => executeCommand("agent")}><Bot /><span>Forge: Open Agent Chat</span><kbd>Agent</kbd></button>
              <button onClick={() => executeCommand("checks")}><Play /><span>Forge: Run Project Checks</span><kbd>Checks</kbd></button>
              <div className="command-group-title">Files</div>
              {commandFiles.map((file) => <button key={file.path} onClick={() => { setCommandOpen(false); setCommandQuery(""); void openFile(file.path); }}><Files /><span>{file.path}</span></button>)}
              {!commandFiles.length && <div className="command-empty">No matching files.</div>}
            </div>
          </section>
        </div>
      )}

      {retryGuidance !== null && (
        <div className="modal-backdrop" onMouseDown={() => setRetryGuidance(null)}>
          <div className="settings-modal guidance-modal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><span className="settings-icon"><RotateCcw /></span><div><h2>Retry the suspended task</h2><p>Forge restarts from a fresh snapshot.</p></div></div>
              <button onClick={() => setRetryGuidance(null)}><X /></button>
            </header>
            <div className="settings-form">
              <label>
                <span>Guidance for the retry</span>
                <textarea
                  autoFocus
                  rows={4}
                  value={retryGuidance}
                  onChange={(event) => setRetryGuidance(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      const guidance = retryGuidance.trim();
                      setRetryGuidance(null);
                      void decideSuspendedRun("retry", guidance || undefined);
                    }
                  }}
                  placeholder="Tell Forge what to do differently…"
                />
                <small>Sent to a fresh Gather cycle. Ctrl ↵ to retry.</small>
              </label>
            </div>
            <footer>
              <button className="secondary" onClick={() => setRetryGuidance(null)}>Cancel</button>
              <button
                className="primary"
                onClick={() => {
                  const guidance = retryGuidance.trim();
                  setRetryGuidance(null);
                  void decideSuspendedRun("retry", guidance || undefined);
                }}
              >
                Retry task
              </button>
            </footer>
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsModal
          config={config}
          runtimes={runtimes}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            setConfig(next);
            localStorage.setItem("forge.provider", JSON.stringify(next));
            setSettingsOpen(false);
          }}
        />
      )}
    </main>
  );
}
