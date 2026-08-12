import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  Blocks,
  CheckCircle2,
  GitBranch,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  TerminalSquare,
  XCircle,
} from "lucide-react";
import type { ProjectCheckResult, TreeNode, WorkspaceSearchResult, WorkspaceStatus } from "../shared/types";
import { fetchProjectScripts, fetchWorkspaceStatus, runProjectCheck, searchWorkspace } from "./api";
import { Explorer } from "./Explorer";

export type WorkbenchView = "explorer" | "search" | "source" | "run" | "extensions" | "security";

interface WorkbenchPanelProps {
  view: WorkbenchView;
  nodes: TreeNode[];
  activePath?: string;
  rootName: string;
  onOpen: (path: string) => void;
  onRefreshTree: () => void;
  onOpenWorkspace?: () => void;
  onOpenSettings: () => void;
  onStatus: (status: WorkspaceStatus) => void;
  onCreateEntry?: (name: string, kind: "file" | "directory") => Promise<void>;
  onRenameEntry?: (fromPath: string, toPath: string) => Promise<void>;
  onDeleteEntry?: (path: string) => Promise<void>;
  /** Column width chosen by the user; omitted falls back to the CSS default. */
  width?: number;
}

/**
 * Width is threaded through context so every view's shell honours the column
 * the user dragged, without each view having to pass it along.
 */
const PanelWidthContext = createContext<number | undefined>(undefined);

function PanelShell({ title, icon, actions, children }: {
  title: string;
  icon: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const width = useContext(PanelWidthContext);
  return (
    <aside className="workbench-panel" style={width ? { width, flex: `0 0 ${width}px` } : undefined}>
      <div className="section-eyebrow">{title}</div>
      <div className="workbench-panel-heading"><span>{icon}{title}</span>{actions}</div>
      <div className="workbench-panel-body">{children}</div>
    </aside>
  );
}

function SearchView({ onOpen }: { onOpen: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setError("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      void searchWorkspace(query, controller.signal)
        .then(setResults)
        .catch((reason) => {
          if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "Search failed.");
        })
        .finally(() => setLoading(false));
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return (
    <PanelShell title="Search" icon={<Search />}>
      <label className="panel-search">
        <Search />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workspace" />
      </label>
      <div className="panel-caption">{loading ? "Searching…" : query.trim().length < 2 ? "Enter at least two characters." : `${results.length} result${results.length === 1 ? "" : "s"}`}</div>
      {error && <div className="panel-error"><XCircle />{error}</div>}
      <div className="search-results">
        {results.map((result, index) => (
          <button key={`${result.path}:${result.line}:${index}`} onClick={() => onOpen(result.path)} title={`${result.path}:${result.line}`}>
            <strong>{result.path}</strong>
            <span>Line {result.line}</span>
            <small>{result.preview || "Matched file path"}</small>
          </button>
        ))}
      </div>
    </PanelShell>
  );
}

function SourceView({ onOpen, onStatus }: { onOpen: (path: string) => void; onStatus: (status: WorkspaceStatus) => void }) {
  const [status, setStatus] = useState<WorkspaceStatus>();
  const [loading, setLoading] = useState(true);
  const refresh = () => {
    setLoading(true);
    void fetchWorkspaceStatus()
      .then((next) => { setStatus(next); onStatus(next); })
      .catch((error) => setStatus({ isRepository: false, branch: "", changes: [], error: error instanceof Error ? error.message : "Git status failed." }))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);
  return (
    <PanelShell title="Source Control" icon={<GitBranch />} actions={<button className="panel-icon-button" onClick={refresh} title="Refresh source control"><RefreshCw /></button>}>
      {loading ? <div className="panel-empty">Reading Git status…</div> : !status?.isRepository ? (
        <div className="panel-empty"><GitBranch /><strong>No Git repository</strong><span>{status?.error || "Open a Git workspace to view changes."}</span></div>
      ) : (
        <>
          <div className="source-summary"><GitBranch /><span>{status.branch}</span><b>{status.changes.length}</b></div>
          <div className="source-list">
            {status.changes.length === 0 ? <div className="panel-empty"><CheckCircle2 /><strong>Working tree clean</strong></div> : status.changes.map((change, index) => {
              const targetPath = change.path.includes(" -> ") ? change.path.split(" -> ").at(-1) || change.path : change.path;
              return <button key={`${change.path}:${index}`} onClick={() => onOpen(targetPath)}><i>{change.status}</i><span>{change.path}</span></button>;
            })}
          </div>
        </>
      )}
    </PanelShell>
  );
}

function RunView() {
  const [checks, setChecks] = useState<string[]>([]);
  const [running, setRunning] = useState("");
  const [result, setResult] = useState<ProjectCheckResult>();
  const [error, setError] = useState("");
  const controllerRef = useRef<AbortController>();
  useEffect(() => {
    void fetchProjectScripts().then((value) => setChecks(value.checks)).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not read package scripts."));
    return () => controllerRef.current?.abort();
  }, []);
  const run = async (name: string) => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(name);
    setError("");
    setResult(undefined);
    try {
      setResult(await runProjectCheck(name, controller.signal));
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(reason instanceof Error ? reason.message : "Check failed to start.");
    } finally {
      setRunning("");
      controllerRef.current = undefined;
    }
  };
  return (
    <PanelShell title="Run & Checks" icon={<Play />}>
      <p className="panel-description">Run fixed, repository-defined validation scripts. Arbitrary model commands are never executed here.</p>
      <div className="check-list">
        {checks.map((name) => <button key={name} disabled={Boolean(running)} onClick={() => void run(name)}><TerminalSquare /><span>npm run {name}</span>{running === name ? <i>Running…</i> : <Play />}</button>)}
      </div>
      {!checks.length && !error && <div className="panel-empty">No typecheck, lint, test, or build scripts were found.</div>}
      {error && <div className="panel-error"><XCircle />{error}</div>}
      {result && <div className={`check-output ${result.passed ? "passed" : "failed"}`}><strong>{result.passed ? "Passed" : "Failed"}: {result.command}</strong><pre>{result.output || "Command completed without output."}</pre></div>}
    </PanelShell>
  );
}

function ExtensionsView({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <PanelShell title="Extensions" icon={<Blocks />}>
      <div className="feature-card"><Blocks /><strong>Forge Agent v0.5.0</strong><span>Built into both Forge shells.</span><em>Enabled</em></div>
      <p className="panel-description">The focused Electron/Monaco shell does not emulate the VS Code extension host. Use the Code-OSS edition to install VSIX or Open VSX extensions without changing the Forge v2 loop.</p>
      <button className="panel-primary" onClick={onOpenSettings}>Open Forge settings</button>
    </PanelShell>
  );
}

function SecurityView() {
  return (
    <PanelShell title="Security" icon={<ShieldCheck />}>
      <div className="feature-card safe"><ShieldCheck /><strong>Transactional workspace protection</strong><span>Enabled for Agent v2</span><em>Protected</em></div>
      <ul className="policy-list">
        <li>Loopback-only model endpoints</li>
        <li>Fresh snapshot and bounded Gather per task</li>
        <li>Declared write sets and isolated staging</li>
        <li>Evidence and target CAS before promotion</li>
        <li>Promotion journal with rollback recovery</li>
        <li><code>discussion</code>, vendor, generated, and release paths excluded</li>
      </ul>
    </PanelShell>
  );
}

export function WorkbenchPanel(props: WorkbenchPanelProps) {
  return (
    <PanelWidthContext.Provider value={props.width}>
      {props.view === "explorer"
        ? <Explorer nodes={props.nodes} activePath={props.activePath} rootName={props.rootName} onOpen={props.onOpen} onRefresh={props.onRefreshTree} onOpenWorkspace={props.onOpenWorkspace} onCreate={props.onCreateEntry} onRename={props.onRenameEntry} onDelete={props.onDeleteEntry} width={props.width} />
        : props.view === "search" ? <SearchView onOpen={props.onOpen} />
        : props.view === "source" ? <SourceView onOpen={props.onOpen} onStatus={props.onStatus} />
        : props.view === "run" ? <RunView />
        : props.view === "extensions" ? <ExtensionsView onOpenSettings={props.onOpenSettings} />
        : <SecurityView />}
    </PanelWidthContext.Provider>
  );
}
