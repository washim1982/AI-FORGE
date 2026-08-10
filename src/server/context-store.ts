import { randomUUID } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import type {
  ContextBudget,
  ContextStoreConfig,
  ContextStoreSummary,
} from "../shared/types.js";
import {
  budgetsFor,
  clampContextTokens,
  CONTEXT_PROFILE_TOKENS,
  DEFAULT_CONTEXT_PROFILE,
  isContextProfileName,
  profileForTokens,
  truncateForBudget,
} from "./model-profile.js";
import {
  absoluteWorkspacePath,
  normalizeRelativePath,
  sha256,
  workspaceRoot,
  type SnapshotEntry,
  type WorkspaceSnapshot,
} from "./workspace.js";

/**
 * Forge keeps its durable understanding of a workspace as many deliberately
 * small files under `<workspace>/.ai-forge`. Each file is cheap to read and
 * cheap to include in a prompt, so a small local model can be handed exactly
 * the few thousand characters it needs instead of a repository-scale dump.
 *
 * Everything here is derived data. The workspace snapshot stays authoritative,
 * and every record carries the source hash that produced it so staleness is
 * always detectable.
 */
export const CONTEXT_DIR = ".ai-forge";

const MAX_CARD_CHARS = 2400;
const MAX_NOTE_CHARS = 1200;
const MAX_JOURNAL_ENTRY_CHARS = 900;
const MAX_JOURNAL_ENTRIES = 40;
const MAX_DIRECTORY_CARDS = 80;
const MAX_FILES_PER_CARD = 40;
const MAX_FILE_DIGESTS = 1500;
const MAX_NOTES = 120;
const MAX_JOURNALS = 40;

export interface FileDigest {
  path: string;
  sha: string;
  size: number;
  lines: number;
  language: string;
  symbols: string[];
  imports: string[];
  updatedAt: string;
}

export interface DirectorySummary {
  dir: string;
  files: number;
  bytes: number;
  languages: string[];
  top: string[];
}

export interface ProjectIndex {
  version: 1;
  snapshotId: string;
  generatedAt: string;
  fileCount: number;
  directories: DirectorySummary[];
}

export type StoreNoteKind = "decision" | "failure" | "convention";

export interface StoreNote {
  id: string;
  kind: StoreNoteKind;
  title: string;
  paths: string[];
  body: string;
  createdAt: string;
}

interface NoteIndex {
  version: 1;
  notes: Array<{ id: string; kind: StoreNoteKind; title: string; paths: string[]; file: string; createdAt: string }>;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".html": "html",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".md": "markdown",
  ".mjs": "javascript",
  ".php": "php",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scss": "scss",
  ".sh": "shell",
  ".sql": "sql",
  ".svelte": "svelte",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "vue",
  ".yaml": "yaml",
  ".yml": "yaml",
};

const SYMBOL_PATTERNS: RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*class\s+([A-Za-z_$][\w$]*)/,
  /^\s*def\s+([A-Za-z_][\w]*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/,
  /^\s*(?:pub\s+)?(?:struct|trait|impl)\s+([A-Za-z_][\w]*)/,
];

const IMPORT_PATTERNS: RegExp[] = [
  /^\s*import\s+(?:[^"']*from\s+)?["']([^"']+)["']/,
  /require\(\s*["']([^"']+)["']\s*\)/,
  /^\s*from\s+([\w.]+)\s+import\s+/,
  /^\s*use\s+([\w:]+)/,
];

const MANIFEST_FILES = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "Gemfile",
  "CMakeLists.txt",
];

const STOP_WORDS = new Set([
  "about", "add", "after", "again", "agent", "also", "and", "are", "build", "can",
  "change", "code", "create", "file", "files", "fix", "for", "from", "have", "implement",
  "into", "local", "make", "need", "new", "please", "should", "support", "that", "the",
  "then", "this", "update", "use", "using", "want", "when", "with", "workspace",
]);

export function contextStoreRoot(): string {
  return path.join(workspaceRoot(), CONTEXT_DIR);
}

function storePath(...segments: string[]): string {
  return path.join(contextStoreRoot(), ...segments);
}

function slugify(value: string, fallback = "item"): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function pathSlug(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  return `${slugify(normalized, "file")}-${sha256(normalized).slice(0, 8)}`;
}

async function writeSmallFile(absolute: string, content: string, maxChars: number): Promise<void> {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const bounded = truncateForBudget(content, maxChars, path.basename(absolute));
  const temporary = `${absolute}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temporary, bounded, "utf8");
  await fs.rename(temporary, absolute);
}

async function readTextOrUndefined(absolute: string): Promise<string | undefined> {
  try {
    return await fs.readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJsonOrUndefined<T>(absolute: string): Promise<T | undefined> {
  const raw = await readTextOrUndefined(absolute);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function listDirectory(absolute: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function defaultStoreConfig(): ContextStoreConfig {
  return {
    version: 1,
    profile: DEFAULT_CONTEXT_PROFILE,
    contextTokens: CONTEXT_PROFILE_TOKENS[DEFAULT_CONTEXT_PROFILE],
    perChangeApply: true,
    editBlocks: true,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function readStoreConfig(): Promise<ContextStoreConfig> {
  const stored = await readJsonOrUndefined<Partial<ContextStoreConfig>>(storePath("config.json"));
  const defaults = defaultStoreConfig();
  if (!stored) return defaults;
  const profile = isContextProfileName(stored.profile) ? stored.profile : undefined;
  const contextTokens = clampContextTokens(
    typeof stored.contextTokens === "number" ? stored.contextTokens : profile ? CONTEXT_PROFILE_TOKENS[profile] : defaults.contextTokens,
  );
  return {
    version: 1,
    profile: profile ?? profileForTokens(contextTokens),
    contextTokens,
    perChangeApply: stored.perChangeApply !== false,
    editBlocks: stored.editBlocks !== false,
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : defaults.updatedAt,
  };
}

export async function saveStoreConfig(patch: Partial<ContextStoreConfig>): Promise<ContextStoreConfig> {
  const current = await readStoreConfig();
  const profile = isContextProfileName(patch.profile) ? patch.profile : current.profile;
  const contextTokens = clampContextTokens(
    typeof patch.contextTokens === "number"
      ? patch.contextTokens
      : isContextProfileName(patch.profile)
        ? CONTEXT_PROFILE_TOKENS[patch.profile]
        : current.contextTokens,
  );
  const next: ContextStoreConfig = {
    version: 1,
    profile,
    contextTokens,
    perChangeApply: patch.perChangeApply ?? current.perChangeApply,
    editBlocks: patch.editBlocks ?? current.editBlocks,
    updatedAt: new Date().toISOString(),
  };
  await writeSmallFile(storePath("config.json"), `${JSON.stringify(next, null, 2)}\n`, 4000);
  return next;
}

export async function resolveBudget(): Promise<ContextBudget> {
  return budgetsFor((await readStoreConfig()).contextTokens);
}

function languageFor(relativePath: string): string {
  return LANGUAGE_BY_EXTENSION[path.extname(relativePath).toLowerCase()] || "plaintext";
}

export function extractSymbols(content: string, limit = 24): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    if (line.length > 400) continue;
    for (const pattern of SYMBOL_PATTERNS) {
      const match = pattern.exec(line);
      if (!match?.[1] || seen.has(match[1])) continue;
      seen.add(match[1]);
      symbols.push(match[1]);
      break;
    }
    if (symbols.length >= limit) break;
  }
  return symbols;
}

export function extractImports(content: string, limit = 16): string[] {
  const imports: string[] = [];
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/).slice(0, 200)) {
    for (const pattern of IMPORT_PATTERNS) {
      const match = pattern.exec(line);
      if (!match?.[1] || seen.has(match[1])) continue;
      seen.add(match[1]);
      imports.push(match[1]);
      break;
    }
    if (imports.length >= limit) break;
  }
  return imports;
}

export function digestFor(relativePath: string, content: string, sha: string, size: number): FileDigest {
  return {
    path: normalizeRelativePath(relativePath),
    sha,
    size,
    lines: content.split(/\r?\n/).length,
    language: languageFor(relativePath),
    symbols: extractSymbols(content),
    imports: extractImports(content),
    updatedAt: new Date().toISOString(),
  };
}

export async function writeFileDigest(digest: FileDigest): Promise<void> {
  await writeSmallFile(storePath("files", `${pathSlug(digest.path)}.json`), `${JSON.stringify(digest, null, 2)}\n`, MAX_CARD_CHARS);
}

export async function readFileDigest(relativePath: string): Promise<FileDigest | undefined> {
  return readJsonOrUndefined<FileDigest>(storePath("files", `${pathSlug(relativePath)}.json`));
}

/**
 * Refreshes digests for a set of workspace paths. Called after a promotion so
 * the store never describes a file the agent has since rewritten.
 */
export async function refreshFileDigests(relativePaths: string[]): Promise<string[]> {
  const refreshed: string[] = [];
  for (const relativePath of [...new Set(relativePaths.map(normalizeRelativePath))].slice(0, 64)) {
    try {
      const absolute = absoluteWorkspacePath(relativePath);
      const stat = await fs.stat(absolute);
      if (!stat.isFile() || stat.size > 2_000_000) continue;
      const content = await fs.readFile(absolute, "utf8");
      await writeFileDigest(digestFor(relativePath, content, sha256(content), stat.size));
      refreshed.push(relativePath);
    } catch {
      // A deleted or unreadable target simply loses its digest on the next prune.
    }
  }
  return refreshed;
}

function directoryKeyFor(relativePath: string): string {
  const segments = normalizeRelativePath(relativePath).split("/");
  if (segments.length === 1) return ".";
  return segments.slice(0, Math.min(2, segments.length - 1)).join("/");
}

function summarizeDirectories(snapshot: WorkspaceSnapshot): DirectorySummary[] {
  const grouped = new Map<string, SnapshotEntry[]>();
  for (const file of snapshot.files) {
    const key = directoryKeyFor(file.path);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(file);
    else grouped.set(key, [file]);
  }
  return [...grouped.entries()]
    .map(([dir, files]) => ({
      dir,
      files: files.length,
      bytes: files.reduce((total, file) => total + file.size, 0),
      languages: [...new Set(files.map((file) => languageFor(file.path)))].filter((language) => language !== "plaintext").slice(0, 6),
      top: files
        .slice()
        .sort((a, b) => b.size - a.size)
        .slice(0, MAX_FILES_PER_CARD)
        .map((file) => file.path),
    }))
    .sort((a, b) => b.files - a.files)
    .slice(0, MAX_DIRECTORY_CARDS);
}

function directoryCardText(summary: DirectorySummary, digests: Map<string, FileDigest>): string {
  const lines = [
    `# ${summary.dir === "." ? "Repository root" : summary.dir}`,
    "",
    `${summary.files} indexed file${summary.files === 1 ? "" : "s"} · ${Math.round(summary.bytes / 1024)} KB · ${summary.languages.join(", ") || "mixed"}`,
    "",
  ];
  for (const filePath of summary.top) {
    const digest = digests.get(filePath);
    const symbols = digest?.symbols.slice(0, 6).join(", ");
    lines.push(`- \`${filePath}\`${digest ? ` — ${digest.lines} lines` : ""}${symbols ? ` — ${symbols}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Rebuilds the directory rollup and module cards from a snapshot. Digests are
 * written only for the largest files in each directory so the store stays a
 * bounded set of small files even in a very large repository.
 */
export async function refreshProjectIndex(snapshot: WorkspaceSnapshot, maxDigests = MAX_FILE_DIGESTS): Promise<ProjectIndex> {
  const directories = summarizeDirectories(snapshot);
  const sizeByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const digests = new Map<string, FileDigest>();
  let budget = Math.max(0, maxDigests);

  for (const summary of directories) {
    for (const filePath of summary.top) {
      if (budget <= 0) break;
      const entry = sizeByPath.get(filePath);
      if (!entry || entry.size > 400_000) continue;
      const existing = await readFileDigest(filePath);
      if (existing?.sha === entry.sha) {
        digests.set(filePath, existing);
        budget -= 1;
        continue;
      }
      try {
        const content = await fs.readFile(absoluteWorkspacePath(filePath), "utf8");
        const digest = digestFor(filePath, content, entry.sha, entry.size);
        await writeFileDigest(digest);
        digests.set(filePath, digest);
        budget -= 1;
      } catch {
        // Unreadable files are represented by the directory rollup alone.
      }
    }
  }

  for (const summary of directories) {
    await writeSmallFile(storePath("map", `${slugify(summary.dir, "root")}.md`), directoryCardText(summary, digests), MAX_CARD_CHARS);
  }

  const index: ProjectIndex = {
    version: 1,
    snapshotId: snapshot.id,
    generatedAt: new Date().toISOString(),
    fileCount: snapshot.files.length,
    directories: directories.map(({ dir, files, bytes, languages }) => ({ dir, files, bytes, languages, top: [] })),
  };
  await writeSmallFile(storePath("map", "index.json"), `${JSON.stringify(index, null, 2)}\n`, 24_000);
  return index;
}

export async function readProjectIndex(): Promise<ProjectIndex | undefined> {
  return readJsonOrUndefined<ProjectIndex>(storePath("map", "index.json"));
}

export async function readDirectoryCard(dir: string): Promise<string | undefined> {
  return readTextOrUndefined(storePath("map", `${slugify(dir, "root")}.md`));
}

export async function readProjectCard(): Promise<string | undefined> {
  return readTextOrUndefined(storePath("project.md"));
}

export async function writeProjectCard(content: string): Promise<void> {
  await writeSmallFile(storePath("project.md"), content, MAX_CARD_CHARS);
}

async function detectVerificationCommands(): Promise<string[]> {
  const raw = await readTextOrUndefined(path.join(workspaceRoot(), "package.json"));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return ["typecheck", "lint", "test", "build"].filter((name) => Boolean(parsed.scripts?.[name])).map((name) => `npm run ${name}`);
  } catch {
    return [];
  }
}

/**
 * Writes the project card when it is missing. The card is the one file included
 * in every prompt, so it is derived deterministically and kept very short.
 */
export async function ensureProjectCard(snapshot: WorkspaceSnapshot, index: ProjectIndex): Promise<string> {
  const existing = await readProjectCard();
  if (existing?.trim()) return existing;

  const manifests = MANIFEST_FILES.filter((name) => snapshot.files.some((file) => file.path === name));
  const languages = [...new Set(snapshot.files.map((file) => languageFor(file.path)))]
    .filter((language) => language !== "plaintext")
    .slice(0, 8);
  const commands = await detectVerificationCommands();
  const card = [
    `# ${path.basename(workspaceRoot())}`,
    "",
    `Indexed ${snapshot.files.length} source files across ${index.directories.length} directories.`,
    "",
    "## Stack",
    languages.length ? languages.map((language) => `- ${language}`).join("\n") : "- Not detected yet",
    "",
    "## Manifests",
    manifests.length ? manifests.map((name) => `- \`${name}\``).join("\n") : "- None detected",
    "",
    "## Verification",
    commands.length ? commands.map((command) => `- \`${command}\``).join("\n") : "- No trusted scripts detected",
    "",
    "## Main areas",
    index.directories.slice(0, 10).map((entry) => `- \`${entry.dir}\` (${entry.files} files)`).join("\n"),
    "",
    "> Forge maintains this card. Edit it freely; Forge only rewrites it when it is missing.",
    "",
  ].join("\n");
  await writeProjectCard(card);
  return card;
}

function scoreTokens(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z_][a-z0-9_.-]{2,}/g) || [])]
    .filter((token) => !STOP_WORDS.has(token))
    .slice(0, 32);
}

function overlapScore(candidate: string, tokens: string[]): number {
  const lowered = candidate.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lowered.includes(token)) score += token.length >= 5 ? 3 : 1;
  }
  return score;
}

export async function readNoteIndex(): Promise<NoteIndex> {
  return (await readJsonOrUndefined<NoteIndex>(storePath("notes", "index.json"))) || { version: 1, notes: [] };
}

export async function recordNote(note: Omit<StoreNote, "id" | "createdAt"> & { id?: string }): Promise<StoreNote> {
  const created: StoreNote = {
    id: note.id || randomUUID().slice(0, 8),
    kind: note.kind,
    title: note.title.trim().slice(0, 120) || "Untitled note",
    paths: [...new Set(note.paths.map(normalizeRelativePath))].slice(0, 12),
    body: note.body.trim().slice(0, MAX_NOTE_CHARS),
    createdAt: new Date().toISOString(),
  };
  const file = `${created.createdAt.slice(0, 10)}-${slugify(created.title, "note")}-${created.id}.md`;
  const body = [
    `# ${created.title}`,
    "",
    `- kind: ${created.kind}`,
    `- recorded: ${created.createdAt}`,
    created.paths.length ? `- paths: ${created.paths.map((item) => `\`${item}\``).join(", ")}` : "- paths: none",
    "",
    created.body,
    "",
  ].join("\n");
  await writeSmallFile(storePath("notes", file), body, MAX_NOTE_CHARS + 400);

  const index = await readNoteIndex();
  index.notes = [
    { id: created.id, kind: created.kind, title: created.title, paths: created.paths, file, createdAt: created.createdAt },
    ...index.notes.filter((item) => item.id !== created.id),
  ];
  const dropped = index.notes.slice(MAX_NOTES);
  index.notes = index.notes.slice(0, MAX_NOTES);
  await writeSmallFile(storePath("notes", "index.json"), `${JSON.stringify(index, null, 2)}\n`, 40_000);
  for (const stale of dropped) {
    await fs.rm(storePath("notes", stale.file), { force: true });
  }
  return created;
}

export async function selectNotes(taskText: string, limit = 4): Promise<string[]> {
  const index = await readNoteIndex();
  if (!index.notes.length) return [];
  const tokens = scoreTokens(taskText);
  const ranked = index.notes
    .map((entry) => ({
      entry,
      score: overlapScore(`${entry.title} ${entry.paths.join(" ")}`, tokens) + (entry.kind === "failure" ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt))
    .filter((item) => item.score > 0)
    .slice(0, limit);
  const bodies: string[] = [];
  for (const item of ranked) {
    const text = await readTextOrUndefined(storePath("notes", item.entry.file));
    if (text) bodies.push(text.trim());
  }
  return bodies;
}

function journalFile(runId: string): string {
  return storePath("tasks", `${slugify(runId, "run")}.md`);
}

export async function appendTaskJournal(runId: string, title: string, body: string): Promise<void> {
  const entry = [
    `## ${new Date().toISOString()} — ${title.trim().slice(0, 120)}`,
    "",
    body.trim().slice(0, MAX_JOURNAL_ENTRY_CHARS),
    "",
  ].join("\n");
  const file = journalFile(runId);
  const existing = (await readTextOrUndefined(file)) || `# Run ${runId}\n\n`;
  const [header, ...entries] = existing.split(/\n(?=## )/);
  const kept = [...entries, entry].slice(-MAX_JOURNAL_ENTRIES);
  await writeSmallFile(file, [header.trim(), "", ...kept].join("\n"), MAX_JOURNAL_ENTRY_CHARS * (MAX_JOURNAL_ENTRIES + 2));
}

export async function readTaskJournal(runId: string, maxChars = 2000): Promise<string> {
  const existing = await readTextOrUndefined(journalFile(runId));
  if (!existing) return "";
  const entries = existing.split(/\n(?=## )/).slice(1);
  const tail: string[] = [];
  let used = 0;
  for (const entry of entries.reverse()) {
    if (used + entry.length > maxChars) break;
    tail.unshift(entry.trim());
    used += entry.length;
  }
  return tail.join("\n\n");
}

export interface ContextPackOptions {
  taskText: string;
  budgetChars: number;
  runId?: string;
  focusPaths?: string[];
  maxDirectoryCards?: number;
}

/**
 * Assembles the compact prompt block that replaces a repository-scale file map:
 * the project card, the directory cards that match the task, digests for the
 * paths already known to matter, prior learnings, and the tail of the current
 * run journal — all clipped to the caller's character budget.
 */
export async function buildContextPack(options: ContextPackOptions): Promise<string> {
  const { taskText, budgetChars, runId, focusPaths = [], maxDirectoryCards = 4 } = options;
  if (budgetChars <= 0) return "";
  const sections: string[] = [];
  let remaining = budgetChars;

  const push = (heading: string, body: string): void => {
    const text = body.trim();
    if (!text) return;
    const block = `### ${heading}\n${text}`;
    if (block.length > remaining) return;
    sections.push(block);
    remaining -= block.length + 2;
  };

  const card = await readProjectCard();
  if (card) push("Project card", card);

  const index = await readProjectIndex();
  if (index) {
    const tokens = scoreTokens(`${taskText} ${focusPaths.join(" ")}`);
    push(
      "Directory rollup",
      index.directories
        .slice(0, 24)
        .map((entry) => `- ${entry.dir} — ${entry.files} files, ${entry.languages.join("/") || "mixed"}`)
        .join("\n"),
    );

    const ranked = index.directories
      .map((entry) => ({ entry, score: overlapScore(entry.dir, tokens) + (focusPaths.some((item) => item.startsWith(`${entry.dir}/`)) ? 5 : 0) }))
      .sort((a, b) => b.score - a.score)
      .filter((item) => item.score > 0)
      .slice(0, maxDirectoryCards);
    for (const item of ranked) {
      const cardText = await readDirectoryCard(item.entry.dir);
      if (cardText) push(`Module: ${item.entry.dir}`, cardText);
    }
  }

  const digestLines: string[] = [];
  for (const focusPath of focusPaths.slice(0, 12)) {
    const digest = await readFileDigest(focusPath);
    if (!digest) continue;
    digestLines.push(`- \`${digest.path}\` (${digest.lines} lines, ${digest.language}) — ${digest.symbols.slice(0, 8).join(", ") || "no exported symbols detected"}`);
  }
  push("Known targets", digestLines.join("\n"));

  const notes = await selectNotes(taskText);
  if (notes.length) push("Prior learnings", notes.join("\n\n"));

  if (runId) {
    const journal = await readTaskJournal(runId, Math.min(1600, Math.max(0, remaining)));
    if (journal) push("This run so far", journal);
  }

  return sections.join("\n\n");
}

export async function pruneStore(): Promise<void> {
  const journals = await listDirectory(storePath("tasks"));
  const files = journals.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  for (const stale of files.slice(0, Math.max(0, files.length - MAX_JOURNALS))) {
    await fs.rm(storePath("tasks", stale), { force: true });
  }
}

export async function ensureContextStore(): Promise<void> {
  await fs.mkdir(storePath("map"), { recursive: true });
  await fs.mkdir(storePath("files"), { recursive: true });
  await fs.mkdir(storePath("notes"), { recursive: true });
  await fs.mkdir(storePath("tasks"), { recursive: true });
  const configFile = storePath("config.json");
  if (!(await readTextOrUndefined(configFile))) {
    await saveStoreConfig(defaultStoreConfig());
  }
  const readme = storePath("README.md");
  if (!(await readTextOrUndefined(readme))) {
    await writeSmallFile(
      readme,
      [
        "# .ai-forge",
        "",
        "Forge keeps its durable understanding of this workspace here as many small files.",
        "Each one is small enough to drop into a prompt for a local model with a narrow context window.",
        "",
        "- `config.json` — context profile and per-call budgets for this workspace.",
        "- `project.md` — the project card included in nearly every prompt. Safe to edit by hand.",
        "- `map/index.json`, `map/*.md` — directory rollup and one card per module.",
        "- `files/*.json` — per-file digests: hash, size, symbols, imports.",
        "- `notes/*.md` — durable decisions, conventions, and failures worth remembering.",
        "- `tasks/*.md` — one compact journal per agent run.",
        "",
        "Everything here is derived. Deleting the folder loses accumulated learnings but never source code.",
        "",
      ].join("\n"),
      MAX_CARD_CHARS,
    );
  }
}

export async function summarizeStore(): Promise<ContextStoreSummary> {
  await ensureContextStore();
  const config = await readStoreConfig();
  const index = await readProjectIndex();
  const card = await readProjectCard();
  const [mapEntries, fileEntries, noteEntries, journalEntries] = await Promise.all([
    listDirectory(storePath("map")),
    listDirectory(storePath("files")),
    listDirectory(storePath("notes")),
    listDirectory(storePath("tasks")),
  ]);
  return {
    root: contextStoreRoot(),
    workspace: workspaceRoot(),
    config,
    budget: budgetsFor(config.contextTokens),
    projectCardChars: card?.length ?? 0,
    indexedSnapshotId: index?.snapshotId,
    indexedAt: index?.generatedAt,
    directoryCards: mapEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length,
    fileDigests: fileEntries.filter((entry) => entry.isFile()).length,
    notes: noteEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length,
    journals: journalEntries.filter((entry) => entry.isFile()).length,
  };
}

export const __testables = {
  directoryKeyFor,
  overlapScore,
  pathSlug,
  scoreTokens,
  slugify,
  summarizeDirectories,
};
