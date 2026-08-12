import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Braces,
  File,
  FileCode2,
  FileJson,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { TreeNode } from "../shared/types";

export type WorkspaceEntryKind = "file" | "directory";

interface ExplorerProps {
  nodes: TreeNode[];
  activePath?: string;
  rootName: string;
  onOpen: (path: string) => void;
  onRefresh: () => void;
  onOpenWorkspace?: () => void;
  /** Creates the entry and resolves once the tree has been refreshed. */
  onCreate?: (name: string, kind: WorkspaceEntryKind) => Promise<void>;
  /** Renames the entry and resolves once the tree has been refreshed. */
  onRename?: (fromPath: string, toPath: string) => Promise<void>;
  /** Deletes the entry and resolves once the tree has been refreshed. */
  onDelete?: (path: string) => Promise<void>;
  /** Column width chosen by the user; omitted falls back to the CSS default. */
  width?: number;
}

function FileTypeIcon({ name }: { name: string }) {
  const extension = name.split(".").pop()?.toLowerCase();
  if (["ts", "tsx", "js", "jsx"].includes(extension || "")) return <FileCode2 className="tree-icon code" />;
  if (extension === "json") return <FileJson className="tree-icon json" />;
  if (["md", "txt"].includes(extension || "")) return <FileText className="tree-icon docs" />;
  if (["css", "scss", "html"].includes(extension || "")) return <Braces className="tree-icon style" />;
  return <File className="tree-icon" />;
}

/**
 * Name field shared by create and rename.
 *
 * It deliberately does not cancel on blur. Losing focus is not an intent to
 * discard — clicking the editor or another panel would silently throw away a
 * typed name — so committing and cancelling are always explicit.
 */
function NameEditor({ initial, icon, placeholder, indent, busy, error, onSubmit, onCancel }: {
  initial: string;
  icon: React.ReactNode;
  placeholder?: string;
  indent?: number;
  busy: boolean;
  error: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="tree-name-editor">
      <div className="tree-name-field" style={indent ? { marginLeft: indent } : undefined}>
        {icon}
        <input
          autoFocus
          value={value}
          disabled={busy}
          spellCheck={false}
          placeholder={placeholder}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); onSubmit(value); }
            if (event.key === "Escape") { event.preventDefault(); onCancel(); }
          }}
        />
        <button className="name-action confirm" title="Confirm" disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={() => onSubmit(value)}><Check /></button>
        <button className="name-action" title="Cancel" disabled={busy} onMouseDown={(event) => event.preventDefault()} onClick={onCancel}><X /></button>
      </div>
      {error && <p className="tree-name-error">{error}</p>}
    </div>
  );
}

function TreeItem({ node, depth, activePath, onOpen, renaming, onStartRename, onRename, onDelete, busy, error, onCancelRename }: {
  node: TreeNode;
  depth: number;
  activePath?: string;
  onOpen: (path: string) => void;
  renaming?: string;
  onStartRename?: (path: string) => void;
  onRename?: (fromPath: string, name: string) => void;
  onDelete?: (node: TreeNode) => void;
  busy: boolean;
  error: string;
  onCancelRename: () => void;
}) {
  const shouldStartOpen = depth < 1 || node.name === "src" || node.name === "client";
  const [open, setOpen] = useState(shouldStartOpen);
  const isDirectory = node.type === "directory";
  const editable = Boolean(onStartRename || onDelete);

  if (renaming === node.path) {
    return (
      <NameEditor
        initial={node.name}
        icon={isDirectory ? <Folder className="tree-icon folder" /> : <FileTypeIcon name={node.name} />}
        indent={depth * 12}
        busy={busy}
        error={error}
        onSubmit={(value) => onRename?.(node.path, value)}
        onCancel={onCancelRename}
      />
    );
  }

  const actions = editable && (
    <span className="tree-row-actions">
      {onStartRename && <button title={`Rename ${node.name}`} aria-label={`Rename ${node.name}`} onClick={(event) => { event.stopPropagation(); onStartRename(node.path); }}><Pencil /></button>}
      {onDelete && <button className="danger" title={`Delete ${node.name}`} aria-label={`Delete ${node.name}`} onClick={(event) => { event.stopPropagation(); onDelete(node); }}><Trash2 /></button>}
    </span>
  );

  if (isDirectory) {
    return (
      <div>
        <div className="tree-row-wrap">
          <button
            className="tree-row directory"
            style={{ paddingLeft: 9 + depth * 12 }}
            onClick={() => setOpen((value) => !value)}
            title={node.path}
          >
            {open ? <ChevronDown className="tree-chevron" /> : <ChevronRight className="tree-chevron" />}
            {open ? <FolderOpen className="tree-icon folder" /> : <Folder className="tree-icon folder" />}
            <span>{node.name}</span>
          </button>
          {actions}
        </div>
        {open && node.children?.map((child) => (
          <TreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            onOpen={onOpen}
            renaming={renaming}
            onStartRename={onStartRename}
            onRename={onRename}
            onDelete={onDelete}
            busy={busy}
            error={error}
            onCancelRename={onCancelRename}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="tree-row-wrap">
      <button
        className={`tree-row file ${activePath === node.path ? "active" : ""}`}
        style={{ paddingLeft: 25 + depth * 12 }}
        onClick={() => onOpen(node.path)}
        title={node.path}
      >
        <FileTypeIcon name={node.name} />
        <span>{node.name}</span>
      </button>
      {actions}
    </div>
  );
}

export function Explorer({ nodes, activePath, rootName, onOpen, onRefresh, onOpenWorkspace, onCreate, onRename, onDelete, width }: ExplorerProps) {
  // Names are collected inline rather than through window.prompt, which throws
  // in Electron and is blocked in the Code-OSS webview.
  const [creating, setCreating] = useState<WorkspaceEntryKind | null>(null);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<TreeNode | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCreating(null);
    setRenaming(undefined);
    setPendingDelete(null);
    setError("");
  };

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = (value: string) => {
    const name = value.trim();
    if (!creating || !onCreate) return;
    if (!name) { reset(); return; }
    void run(() => onCreate(name, creating));
  };

  const submitRename = (fromPath: string, value: string) => {
    const name = value.trim();
    if (!onRename) return;
    if (!name) { reset(); return; }
    // Renaming keeps the entry in its own folder unless a path is typed.
    const parent = fromPath.split("/").slice(0, -1).join("/");
    const target = name.includes("/") ? name : parent ? `${parent}/${name}` : name;
    if (target === fromPath) { reset(); return; }
    void run(() => onRename(fromPath, target));
  };

  return (
    <aside className="explorer-panel" style={width ? { width, flex: `0 0 ${width}px` } : undefined}>
      <div className="section-eyebrow">Explorer</div>
      <div className="explorer-heading">
        <span>{rootName || "WORKSPACE"}</span>
        <div className="heading-actions">
          {onCreate && <button aria-label="New file" title="New file" onClick={() => { reset(); setCreating("file"); }}><FilePlus /></button>}
          {onCreate && <button aria-label="New folder" title="New folder" onClick={() => { reset(); setCreating("directory"); }}><FolderPlus /></button>}
          {onOpenWorkspace && <button aria-label="Open workspace" title="Open folder" onClick={onOpenWorkspace}><FolderOpen /></button>}
          <button aria-label="Refresh files" title="Refresh workspace files" onClick={onRefresh}><RefreshCw /></button>
        </div>
      </div>
      <div className="tree-scroll">
        {creating && (
          <NameEditor
            initial=""
            icon={creating === "file" ? <File className="tree-icon" /> : <Folder className="tree-icon folder" />}
            placeholder={creating === "file" ? "name.ts, or path/to/name.ts" : "folder, or path/to/folder"}
            busy={busy}
            error={error}
            onSubmit={submitCreate}
            onCancel={reset}
          />
        )}
        {nodes.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            activePath={activePath}
            onOpen={onOpen}
            renaming={renaming}
            onStartRename={onRename ? (path) => { reset(); setRenaming(path); } : undefined}
            onRename={submitRename}
            onDelete={onDelete ? (target) => { reset(); setPendingDelete(target); } : undefined}
            busy={busy}
            error={error}
            onCancelRename={reset}
          />
        ))}
        {/* Deleting cannot be undone, so it is always confirmed by name. */}
        {pendingDelete && (
          <div className="tree-confirm">
            <p>
              Delete <strong>{pendingDelete.name}</strong>
              {pendingDelete.type === "directory" ? " and everything inside it?" : "?"}
            </p>
            <div>
              <button disabled={busy} onClick={reset}>Cancel</button>
              <button className="danger" disabled={busy} onClick={() => onDelete && void run(() => onDelete(pendingDelete.path))}>
                {busy ? "Deleting…" : "Delete"}
              </button>
            </div>
            {error && <p className="tree-name-error">{error}</p>}
          </div>
        )}
        {error && !creating && !renaming && !pendingDelete && <p className="tree-name-error">{error}</p>}
      </div>
    </aside>
  );
}
