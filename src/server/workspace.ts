import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TreeNode, WorkspaceFile } from "../shared/types.js";

const IGNORED_SEGMENTS = new Set([
  ".git",
  ".forge",
  ".ai-forge",
  ".cache",
  ".next",
  "discussion",
  "node_modules",
  "vendor",
  "release",
  "dist",
  "dist-server",
  "build",
  "out",
  "coverage",
  "temp",
  "tmp",
]);

const TEXT_EXTENSIONS = new Set([
  "",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".php",
  ".prisma",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".css": "css",
  ".go": "go",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascript",
  ".md": "markdown",
  ".mjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".scss": "scss",
  ".sh": "shell",
  ".sql": "sql",
  ".svg": "xml",
  ".toml": "ini",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "html",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
};

export interface SnapshotEntry {
  path: string;
  sha: string;
  size: number;
}

export interface WorkspaceSnapshot {
  id: string;
  createdAt: string;
  files: SnapshotEntry[];
}

export interface RetrievedEvidence {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  sha: string;
  score: number;
  content: string;
}

let configuredWorkspaceRoot = process.env.WORKSPACE_ROOT
  ? path.resolve(process.env.WORKSPACE_ROOT)
  : path.resolve(process.cwd());

export function workspaceRoot(): string {
  return configuredWorkspaceRoot;
}

export async function setWorkspaceRoot(nextRoot: string): Promise<string> {
  const resolved = path.resolve(nextRoot);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("The selected workspace is not a directory.");
  configuredWorkspaceRoot = resolved;
  return configuredWorkspaceRoot;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function assertSafeRelativePath(value: string): string {
  const normalized = normalizeRelativePath(value).trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Path must be workspace-relative: ${value}`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || IGNORED_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error(`Path is outside the writable agent scope: ${value}`);
  }

  const root = workspaceRoot();
  const absolute = path.resolve(root, ...segments);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the workspace: ${value}`);
  }
  return normalized;
}

export function absoluteWorkspacePath(relativePath: string): string {
  const safe = assertSafeRelativePath(relativePath);
  return path.resolve(workspaceRoot(), ...safe.split("/"));
}

function isIgnoredName(name: string): boolean {
  return IGNORED_SEGMENTS.has(name.toLowerCase());
}

function isRecoverableReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && ["EACCES", "EBUSY", "ENOENT", "EPERM"].includes(code);
}

async function readDirectoryOrSkip(absoluteDir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (isRecoverableReadError(error)) return [];
    throw error;
  }
}

function isTextPath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(extension) || path.basename(filePath).startsWith(".");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function buildWorkspaceTree(maxNodes = 1200): Promise<TreeNode[]> {
  let visited = 0;

  async function walk(absoluteDir: string, relativeDir = ""): Promise<TreeNode[]> {
    if (visited >= maxNodes) return [];
    const entries = await readDirectoryOrSkip(absoluteDir);
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (visited >= maxNodes || isIgnoredName(entry.name)) continue;
      const relativePath = normalizeRelativePath(path.join(relativeDir, entry.name));
      const absolutePath = path.join(absoluteDir, entry.name);
      visited += 1;

      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          path: relativePath,
          type: "directory",
          children: await walk(absolutePath, relativePath),
        });
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, path: relativePath, type: "file" });
      }
    }
    return nodes;
  }

  return walk(workspaceRoot());
}

export async function readWorkspaceFile(relativePath: string): Promise<WorkspaceFile> {
  const safe = assertSafeRelativePath(relativePath);
  const absolute = absoluteWorkspacePath(safe);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error("The requested path is not a file.");
  if (stat.size > 2_000_000) throw new Error("File exceeds the 2 MB editor limit.");
  const content = await fs.readFile(absolute, "utf8");
  return {
    path: safe,
    content,
    sha: sha256(content),
    language: LANGUAGE_BY_EXTENSION[path.extname(safe).toLowerCase()] || "plaintext",
  };
}

export async function saveWorkspaceFile(
  relativePath: string,
  content: string,
  expectedSha?: string,
): Promise<WorkspaceFile> {
  const safe = assertSafeRelativePath(relativePath);
  const absolute = absoluteWorkspacePath(safe);
  if (await pathExists(absolute)) {
    const current = await fs.readFile(absolute);
    if (expectedSha && sha256(current) !== expectedSha) {
      throw new Error("The file changed on disk. Reload it before saving.");
    }
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.forge-${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, absolute);
  return readWorkspaceFile(safe);
}

async function collectFiles(absoluteDir: string, relativeDir = "", output: string[] = []): Promise<string[]> {
  const entries = await readDirectoryOrSkip(absoluteDir);
  for (const entry of entries) {
    if (isIgnoredName(entry.name)) continue;
    const absolute = path.join(absoluteDir, entry.name);
    const relative = normalizeRelativePath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) await collectFiles(absolute, relative, output);
    else if (entry.isFile() && isTextPath(relative)) output.push(relative);
  }
  return output;
}

export async function createSnapshot(): Promise<WorkspaceSnapshot> {
  const paths = await collectFiles(workspaceRoot());
  const files: SnapshotEntry[] = [];
  for (const relativePath of paths.sort()) {
    try {
      const absolute = absoluteWorkspacePath(relativePath);
      const stat = await fs.stat(absolute);
      if (stat.size > 2_000_000) continue;
      const content = await fs.readFile(absolute);
      files.push({ path: relativePath, sha: sha256(content), size: stat.size });
    } catch (error) {
      if (!isRecoverableReadError(error)) throw error;
    }
  }
  const digest = sha256(files.map((file) => `${file.path}:${file.sha}`).join("\n")).slice(0, 16);
  return {
    id: `snap_${digest}`,
    createdAt: new Date().toISOString(),
    files,
  };
}

export function repositoryMap(snapshot: WorkspaceSnapshot, maxEntries = 500): string {
  return snapshot.files
    .slice(0, maxEntries)
    .map((file) => `${file.path}  (${file.size}b, sha:${file.sha.slice(0, 12)})`)
    .join("\n");
}

const STOP_WORDS = new Set([
  "about", "after", "again", "agent", "also", "and", "are", "build", "can", "change",
  "code", "create", "file", "for", "from", "have", "implement", "into", "local", "make",
  "need", "please", "should", "that", "the", "this", "use", "using", "want", "with",
]);

function queryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z_][a-z0-9_.-]{2,}/g) || [])]
    .filter((token) => !STOP_WORDS.has(token))
    .slice(0, 24);
}

export async function retrieveEvidence(
  queries: string[],
  fileHints: string[],
  limit = 18,
  existingSnapshot?: WorkspaceSnapshot,
): Promise<RetrievedEvidence[]> {
  const snapshot = existingSnapshot ?? await createSnapshot();
  const hintSet = new Set(fileHints.map(normalizeRelativePath));
  const tokens = queryTokens(queries.join(" "));
  const candidates: RetrievedEvidence[] = [];

  for (const file of snapshot.files) {
    if (file.size > 600_000) continue;
    let content: string;
    try {
      content = await fs.readFile(absoluteWorkspacePath(file.path), "utf8");
    } catch (error) {
      if (isRecoverableReadError(error)) continue;
      throw error;
    }
    if (content.includes("\u0000")) continue;
    const lines = content.split(/\r?\n/);
    const lowerPath = file.path.toLowerCase();

    for (let index = 0; index < lines.length; index += 1) {
      const lowerLine = lines[index].toLowerCase();
      let score = hintSet.has(file.path) ? 6 : 0;
      for (const token of tokens) {
        if (lowerPath.includes(token)) score += 5;
        if (lowerLine.includes(token)) score += 3;
      }
      if (score === 0) continue;

      const start = Math.max(0, index - 5);
      const end = Math.min(lines.length, index + 12);
      const excerpt = lines.slice(start, end).join("\n");
      candidates.push({
        id: `ev_${sha256(`${file.path}:${start}:${excerpt}`).slice(0, 12)}`,
        path: file.path,
        startLine: start + 1,
        endLine: end,
        sha: file.sha,
        score,
        content: excerpt,
      });
      index = end - 1;
    }

    if (hintSet.has(file.path) && !candidates.some((candidate) => candidate.path === file.path)) {
      const end = Math.min(lines.length, 120);
      candidates.push({
        id: `ev_${sha256(`${file.path}:0:${content.slice(0, 500)}`).slice(0, 12)}`,
        path: file.path,
        startLine: 1,
        endLine: end,
        sha: file.sha,
        score: 5,
        content: lines.slice(0, end).join("\n"),
      });
    }
  }

  const selected: RetrievedEvidence[] = [];
  const perFile = new Map<string, number>();
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    const count = perFile.get(candidate.path) || 0;
    if (count >= 2) continue;
    selected.push(candidate);
    perFile.set(candidate.path, count + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}

export async function cloneWorkspaceToStage(runId: string): Promise<string> {
  const stageRoot = path.join(os.tmpdir(), `forge-agent-${runId}-${randomUUID().slice(0, 8)}`);
  const sourceRoot = workspaceRoot();
  await fs.mkdir(stageRoot, { recursive: true });
  await fs.cp(sourceRoot, stageRoot, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (source) => {
      const relative = path.relative(sourceRoot, source);
      if (!relative) return true;
      return !relative.split(path.sep).some((segment) => isIgnoredName(segment));
    },
  });

  const sourceModules = path.join(sourceRoot, "node_modules");
  const stageModules = path.join(stageRoot, "node_modules");
  if (await pathExists(sourceModules)) {
    try {
      await fs.symlink(sourceModules, stageModules, "junction");
    } catch {
      // Verification can still run for repositories whose checks do not require node_modules.
    }
  }
  return stageRoot;
}

export async function removeStage(stageRoot: string): Promise<void> {
  const resolved = path.resolve(stageRoot);
  const tempRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolved).startsWith("forge-agent-")) {
    throw new Error("Refusing to remove an unrecognized staging path.");
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

export async function removeStagesForRun(runId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{4,160}$/.test(runId)) throw new Error("Invalid staging cleanup identifier.");
  const tempRoot = path.resolve(os.tmpdir());
  const prefix = `forge-agent-${runId}-`;
  const entries = await readDirectoryOrSkip(tempRoot);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    await removeStage(path.join(tempRoot, entry.name));
  }
}

export async function fileExistsInWorkspace(relativePath: string): Promise<boolean> {
  return pathExists(absoluteWorkspacePath(relativePath));
}

export async function readRawWorkspaceFile(relativePath: string): Promise<Buffer> {
  return fs.readFile(absoluteWorkspacePath(relativePath));
}
