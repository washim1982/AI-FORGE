import { useMemo, useState } from "react";
import {
  ArrowUp,
  Bot,
  Braces,
  Check,
  ChevronDown,
  CircleDot,
  Clock3,
  FileCheck2,
  GitCompareArrows,
  ListTree,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  RotateCcw,
  SearchCode,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  X,
  XCircle,
} from "lucide-react";
import MarkdownIt from "markdown-it";
import type { AgentEvent, ForgeRunManifest, ProviderConfig, ProviderKind, RuntimeStatus } from "../shared/types";
import { fetchAgentRuns } from "./api";

export interface ForgeChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultLinkOpen = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, environment, self) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen ? defaultLinkOpen(tokens, index, options, environment, self) : self.renderToken(tokens, index, options);
};

interface AgentPanelProps {
  events: AgentEvent[];
  /** The prompt that started the current Agent v2 run, shown above its timeline. */
  objective: string;
  messages: ForgeChatMessage[];
  mode: "chat" | "agent";
  running: boolean;
  config: ProviderConfig;
  task: string;
  error?: string;
  runtime?: RuntimeStatus;
  onTaskChange: (value: string) => void;
  onRun: () => void;
  onCancel: () => void;
  onOpenSettings: () => void;
  onProviderChange: (kind: ProviderKind) => void;
  onModelChange: (model: string) => void;
  onModeChange: (mode: "chat" | "agent") => void;
  onRefreshModels: () => void;
  onNewSession: () => void;
  onDecision: (decision: "approve" | "retry" | "discard") => void;
  /** Column width chosen by the user; omitted falls back to the CSS default. */
  width?: number;
}

// `active` is true only for the single event actually in flight right now.
// Every event keeps whatever status it was emitted with — that's an
// immutable log, not something to rewrite — but a "running" row that has
// since been superseded, or that the stream ended without resolving, should
// not keep spinning: it reads as the whole panel being stuck even after the
// run finished.
function phaseIcon(event: AgentEvent, active: boolean) {
  if (event.status === "error") return <XCircle />;
  if (event.status === "running") return <LoaderCircle className={active ? "spinning" : ""} />;
  if (event.kind === "snapshot.created") return <GitCompareArrows />;
  if (event.phase === "plan") return <ListTree />;
  if (event.phase === "human") return <Clock3 />;
  if (event.phase === "gather") return <SearchCode />;
  if (event.phase === "apply") return <Braces />;
  if (event.phase === "verify") return <TerminalSquare />;
  if (event.phase === "promote") return <ShieldCheck />;
  return <Check />;
}

function TimelineEvent({ event, last, active }: { event: AgentEvent; last: boolean; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hasData = Boolean(event.data && Object.keys(event.data).length);
  return (
    <div className={`timeline-event ${event.status}`}>
      <div className="timeline-rail">
        <span className="timeline-icon">{phaseIcon(event, active)}</span>
        {!last && <span className="timeline-line" />}
      </div>
      <div className="event-body">
        <button className="event-summary" onClick={() => hasData && setExpanded((value) => !value)}>
          <span className="event-title">{event.title}</span>
          <span className="event-time">{new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <div className="event-message" dangerouslySetInnerHTML={{ __html: markdown.render(event.message) }} />
          {hasData && <ChevronDown className={expanded ? "expanded" : ""} />}
        </button>
        {expanded && <pre className="event-data">{JSON.stringify(event.data, null, 2)}</pre>}
      </div>
    </div>
  );
}

function ObjectiveCard({ objective }: { objective: string }) {
  const [expanded, setExpanded] = useState(false);
  const multiline = objective.includes("\n");
  return (
    <article className="chat-message user objective-card">
      <button className={`objective-summary${multiline ? " expandable" : ""}`} onClick={() => multiline && setExpanded((value) => !value)}>
        <header>
          <strong>You</strong>
          {multiline && <ChevronDown className={expanded ? "expanded" : ""} />}
        </header>
        <p className={multiline && !expanded ? "collapsed" : undefined}>{objective}</p>
      </button>
    </article>
  );
}

function EmptySession({ mode }: { mode: "chat" | "agent" }) {
  return (
    <div className="empty-session">
      <div className="empty-orbit"><Sparkles /><span /></div>
      <h3>{mode === "chat" ? "Chat with your local model" : "Build with your local model"}</h3>
      <p>{mode === "chat" ? "Ask questions and receive clean Markdown without starting an autonomous coding transaction." : "Forge v2 plans bounded tasks, repairs failures in isolation, and promotes only passing transactions."}</p>
      {mode === "agent" ? <>
        <div className="architecture-mini">
          <span><SearchCode /> Gather</span><i /><span><FileCheck2 /> Brief</span><i /><span><Braces /> Apply</span>
        </div>
        <div className="safety-note"><ShieldCheck /> Persisted plans · staged writes · evidence and target CAS</div>
      </> : <div className="safety-note"><MessageSquare /> Conversational Markdown · no workspace writes</div>}
    </div>
  );
}

function ChatTimeline({ messages }: { messages: ForgeChatMessage[] }) {
  return <div className="chat-timeline">{messages.map((message, index) => message.role === "user" ? (
    <article className="chat-message user" key={message.id}>
      <header><strong>You</strong><time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></header>
      <p>{message.content}</p>
    </article>
  ) : (
    <ChatResponse key={message.id} message={message} expanded={index === messages.length - 1} />
  ))}</div>;
}

function ChatResponse({ message, expanded }: { message: ForgeChatMessage; expanded: boolean }) {
  const [open, setOpen] = useState(expanded);
  return <details className="chat-message assistant" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span><Bot />Forge</span><time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><ChevronDown /></summary>
    <div className="chat-markdown" dangerouslySetInnerHTML={{ __html: markdown.render(message.content) }} />
  </details>;
}

export function AgentPanel({
  events,
  objective,
  messages,
  mode,
  running,
  config,
  task,
  error,
  runtime,
  onTaskChange,
  onRun,
  onCancel,
  onOpenSettings,
  onProviderChange,
  onModelChange,
  onModeChange,
  onRefreshModels,
  onNewSession,
  onDecision,
  width,
}: AgentPanelProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [runHistory, setRunHistory] = useState<ForgeRunManifest[]>([]);
  const [historyError, setHistoryError] = useState("");
  const lastEventId = events.at(-1)?.id;
  const suspension = events.at(-1)?.kind === "run.suspended" ? events.at(-1) : undefined;
  const allowedActions = Array.isArray(suspension?.data?.allowedActions)
    ? suspension.data.allowedActions.filter((item): item is "approve" | "retry" | "discard" => ["approve", "retry", "discard"].includes(String(item)))
    : [];
  const statusLabel = useMemo(() => {
    if (running) return mode === "chat" ? "Generating locally" : "Autopilot running";
    if (mode === "chat") return "Chat ready";
    if (events.at(-1)?.kind === "run.suspended") return "Human decision required";
    if (events.at(-1)?.kind === "run.completed") return "Task complete";
    if (events.at(-1)?.kind === "run.failed") return "Stopped safely";
    return "Ready";
  }, [events, mode, running]);
  const toggleHistory = async () => {
    const opening = !historyOpen;
    setHistoryOpen(opening);
    if (!opening) return;
    setHistoryError("");
    try {
      setRunHistory(await fetchAgentRuns());
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not load Forge run history.");
    }
  };

  return (
    <aside className="agent-panel" style={width ? { width, flex: `0 0 ${width}px` } : undefined}>
      <header className="agent-header">
        <div className="session-tab"><CircleDot /><span>Agent</span><X /></div>
        <div className="agent-actions">
          <button title="New session" onClick={onNewSession}><Plus /></button>
          <button title="Run history" className={historyOpen ? "active" : ""} onClick={() => void toggleHistory()}><ListTree /></button>
          <button title="Settings" onClick={onOpenSettings}><Settings2 /></button>
        </div>
      </header>
      <div className="agent-statusbar">
        <span className={`status-pulse ${running ? "live" : ""}`} />
        <span>{statusLabel}</span>
        <span className="context-badge">{mode === "chat" ? "Chat" : "Forge v2"}</span>
      </div>
      <div className="agent-scroll">
        {historyOpen ? <div className="run-history">
          <header><strong>Forge v2 runs</strong><button onClick={() => void toggleHistory()}><X /></button></header>
          {historyError && <div className="inline-error"><XCircle />{historyError}</div>}
          {!historyError && !runHistory.length && <div className="panel-empty">No persisted agent runs yet.</div>}
          {runHistory.map((run) => <article key={run.runId}><div><strong>{run.objective}</strong><span className={`run-status ${run.status}`}>{run.status}</span></div><small>{run.tasks.filter((task) => task.status === "completed").length}/{run.tasks.length} tasks · {new Date(run.updatedAt).toLocaleString()}</small></article>)}
        </div> : mode === "chat" ? (messages.length ? <ChatTimeline messages={messages} /> : <EmptySession mode={mode} />) : events.length === 0 ? <EmptySession mode={mode} /> : <>
          {objective && <ObjectiveCard objective={objective} />}
          {events.map((item) => (
            <TimelineEvent key={item.id} event={item} last={item.id === lastEventId} active={running && item.id === lastEventId} />
          ))}
        </>}
        {error && <div className="inline-error"><XCircle />{error}</div>}
      </div>
      {running && (
        <div className="working-strip">
          <span><LoaderCircle className="spinning" /> Working in isolation…</span>
          <button onClick={onCancel}>Cancel</button>
        </div>
      )}
      {suspension && !running && (
        <div className="suspension-actions">
          <span><Clock3 /> Suspended safely</span>
          <div>
            {allowedActions.includes("approve") && <button onClick={() => onDecision("approve")}><ShieldCheck />Approve</button>}
            {allowedActions.includes("retry") && <button onClick={() => onDecision("retry")}><RotateCcw />Retry</button>}
            {allowedActions.includes("discard") && <button className="danger" onClick={() => onDecision("discard")}><XCircle />Discard</button>}
          </div>
        </div>
      )}
      <div className="composer-wrap">
        <div className="composer">
          <textarea
            value={task}
            onChange={(event) => onTaskChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onRun();
            }}
            placeholder="Ask Forge to build, fix, or refactor…"
            rows={3}
          />
          <div className="composer-toolbar">
            <div className="provider-switch">
              <button className="runtime-refresh" onClick={onRefreshModels} title="Refresh local models"><span className={`runtime-dot ${runtime?.reachable && runtime.models.length ? "online" : "offline"}`} /><RefreshCw /></button>
              <Bot />
              <select value={config.kind} onChange={(event) => onProviderChange(event.target.value as ProviderKind)}>
                <option value="ollama">Ollama</option>
                <option value="lmstudio">LM Studio</option>
                <option value="llamacpp">llama.cpp</option>
              </select>
              <select className="model-select" aria-label="Local model" value={config.model} onChange={(event) => onModelChange(event.target.value)} disabled={!runtime?.models.length}>
                {!runtime?.models.length && <option value="">{runtime?.reachable ? "No models" : "Runtime offline"}</option>}
                {runtime?.models.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            </div>
            <select className="agent-mode-select" aria-label="Forge mode" value={mode} onChange={(event) => onModeChange(event.target.value as "chat" | "agent")} disabled={running}>
              <option value="chat">Chat</option>
              <option value="agent">Agent v2</option>
            </select>
            <button
              className={`send-button ${task.trim() ? "enabled" : ""}`}
              disabled={(!task.trim() || !config.model) && !running}
              onClick={running ? onCancel : onRun}
              aria-label={running ? "Stop agent" : "Run agent"}
            >
              {running ? <Square /> : <ArrowUp />}
            </button>
          </div>
        </div>
        <div className="composer-caption">Ctrl ↵ to send · {mode === "chat" ? "conversation only" : "transactional agent"} · local inference</div>
      </div>
    </aside>
  );
}
