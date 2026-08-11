import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Braces,
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import type { TreeNode } from "../shared/types";

interface ExplorerProps {
  nodes: TreeNode[];
  activePath?: string;
  rootName: string;
  onOpen: (path: string) => void;
  onRefresh: () => void;
  onOpenWorkspace?: () => void;
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

function TreeItem({ node, depth, activePath, onOpen }: {
  node: TreeNode;
  depth: number;
  activePath?: string;
  onOpen: (path: string) => void;
}) {
  const shouldStartOpen = depth < 1 || node.name === "src" || node.name === "client";
  const [open, setOpen] = useState(shouldStartOpen);
  if (node.type === "directory") {
    return (
      <div>
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
        {open && node.children?.map((child) => (
          <TreeItem key={child.path} node={child} depth={depth + 1} activePath={activePath} onOpen={onOpen} />
        ))}
      </div>
    );
  }

  return (
    <button
      className={`tree-row file ${activePath === node.path ? "active" : ""}`}
      style={{ paddingLeft: 25 + depth * 12 }}
      onClick={() => onOpen(node.path)}
      title={node.path}
    >
      <FileTypeIcon name={node.name} />
      <span>{node.name}</span>
    </button>
  );
}

export function Explorer({ nodes, activePath, rootName, onOpen, onRefresh, onOpenWorkspace, width }: ExplorerProps) {
  return (
    <aside className="explorer-panel" style={width ? { width, flex: `0 0 ${width}px` } : undefined}>
      <div className="section-eyebrow">Explorer</div>
      <div className="explorer-heading">
        <span>{rootName || "WORKSPACE"}</span>
        <div className="heading-actions">
          {onOpenWorkspace && <button aria-label="Open workspace" title="Open folder" onClick={onOpenWorkspace}><FolderOpen /></button>}
          <button aria-label="Refresh files" title="Refresh workspace files" onClick={onRefresh}><RefreshCw /></button>
        </div>
      </div>
      <div className="tree-scroll">
        {nodes.map((node) => (
          <TreeItem key={node.path} node={node} depth={0} activePath={activePath} onOpen={onOpen} />
        ))}
      </div>
    </aside>
  );
}
