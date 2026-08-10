/**
 * Bounded editing primitives.
 *
 * A small local model cannot reliably re-emit a large file, so Forge lets Apply
 * return anchored search/replace blocks instead of whole file contents. The
 * blocks are applied deterministically here — the model never writes to disk,
 * and an anchor that does not match exactly once is rejected rather than
 * guessed at.
 */

export interface EditBlock {
  find: string;
  replace: string;
  /** 1-based line where the find block starts, as read from the numbered view. */
  startLine?: number;
}

const MAX_EDIT_BLOCKS = 12;
const MAX_EDIT_CHARS = 20_000;

/** Separator used by the numbered view: `42→const total = 0;`. */
export const LINE_NUMBER_MARKER = "→";

const NUMBERED_LINE = /^\s*(\d+)\s*→/;

/**
 * A model reading a numbered view often copies the numbers back into its find
 * block. Stripping them is unambiguous — and the first number recovered this
 * way doubles as the anchor line.
 */
function stripNumbering(block: string): { text: string; firstLine?: number } {
  const lines = block.split("\n");
  const meaningful = lines.filter((line) => line.trim());
  if (!meaningful.length || !meaningful.every((line) => NUMBERED_LINE.test(line))) return { text: block };
  const firstLine = Number.parseInt(NUMBERED_LINE.exec(meaningful[0])![1], 10);
  return {
    text: lines.map((line) => line.replace(NUMBERED_LINE, "")).join("\n"),
    firstLine: Number.isFinite(firstLine) ? firstLine : undefined,
  };
}

export function validateEditBlocks(value: unknown): EditBlock[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error("edits must be a non-empty array of {start_line, find, replace} blocks.");
  }
  if (value.length > MAX_EDIT_BLOCKS) {
    throw new Error(`An edit set may contain at most ${MAX_EDIT_BLOCKS} blocks.`);
  }
  return value.map((item, index) => {
    const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : null;
    if (!record) throw new Error(`Edit ${index + 1} must be an object.`);
    const rawFind = record.find;
    const rawReplace = record.replace ?? "";
    if (typeof rawFind !== "string" || !rawFind.trim()) {
      throw new Error(`Edit ${index + 1} needs a non-empty find block copied exactly from the file.`);
    }
    if (typeof rawReplace !== "string") throw new Error(`Edit ${index + 1} needs a string replace block.`);
    if (rawFind.length + rawReplace.length > MAX_EDIT_CHARS) {
      throw new Error(`Edit ${index + 1} is too large; split it into smaller anchored blocks.`);
    }
    const find = stripNumbering(rawFind);
    const replace = stripNumbering(rawReplace);
    const declared = record.start_line ?? record.startLine;
    const startLine = typeof declared === "number" && Number.isFinite(declared) && declared >= 1
      ? Math.floor(declared)
      : find.firstLine;
    return { find: find.text, replace: replace.text, startLine };
  });
}

interface AnchorMatch {
  index: number;
  length: number;
  crlf: boolean;
  indentDelta: string;
}

function exactMatch(haystack: string, needle: string): AnchorMatch | null {
  for (const candidate of [needle, needle.replace(/\r?\n/g, "\r\n"), needle.replace(/\r\n/g, "\n")]) {
    const index = haystack.indexOf(candidate);
    if (index === -1) continue;
    if (haystack.indexOf(candidate, index + 1) !== -1) {
      throw new Error("AMBIGUOUS");
    }
    return { index, length: candidate.length, crlf: candidate.includes("\r\n"), indentDelta: "" };
  }
  return null;
}

/**
 * Small models frequently reproduce a block correctly except for its leading
 * indentation. A trimmed line-by-line comparison recovers that case, but only
 * when exactly one region of the file matches — an ambiguous anchor is still an
 * error rather than a guess.
 */
function indentTolerantMatch(haystack: string, needle: string): AnchorMatch | null {
  const haystackLines = haystack.split("\n");
  const needleLines = needle.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  if (!needleLines.length) return null;

  const matches: number[] = [];
  for (let start = 0; start + needleLines.length <= haystackLines.length; start += 1) {
    const same = needleLines.every((line, offset) => haystackLines[start + offset].trim().replace(/\r$/, "") === line.trim());
    if (same) matches.push(start);
  }
  if (matches.length !== 1) return null;

  const start = matches[0];
  const index = haystackLines.slice(0, start).reduce((total, line) => total + line.length + 1, 0);
  const matchedText = haystackLines.slice(start, start + needleLines.length).join("\n");
  const fileIndent = /^\s*/.exec(haystackLines[start])?.[0].replace(/\r$/, "") ?? "";
  const needleIndent = /^\s*/.exec(needleLines[0])?.[0] ?? "";
  return {
    index,
    length: matchedText.length,
    crlf: matchedText.includes("\r"),
    indentDelta: fileIndent.startsWith(needleIndent) ? fileIndent.slice(needleIndent.length) : "",
  };
}

function reindent(text: string, delta: string): string {
  if (!delta) return text;
  return text.split("\n").map((line) => (line.trim() ? `${delta}${line}` : line)).join("\n");
}

function mismatchHint(haystack: string, needle: string): string {
  const firstLine = needle.replace(/\r\n/g, "\n").split("\n").find((line) => line.trim()) ?? "";
  const target = firstLine.trim();
  if (!target) return "";
  const lines = haystack.split("\n");
  const exact = lines.findIndex((line) => line.trim() === target);
  const partial = exact === -1 ? lines.findIndex((line) => line.includes(target.slice(0, Math.max(8, Math.floor(target.length / 2))))) : exact;
  if (partial === -1) return ` No line in the file resembles "${target.slice(0, 80)}".`;
  const start = Math.max(0, partial - 2);
  const region = lines.slice(start, Math.min(lines.length, partial + 3))
    .map((line, offset) => `${start + offset + 1}: ${line}`)
    .join("\n");
  return ` The closest region is:\n${region}`;
}

/**
 * Resolves a find block against a declared anchor line. Searching a small
 * window around the stated line keeps an off-by-a-few line number usable while
 * still refusing to pick between two equally good candidates.
 */
function anchoredMatch(haystack: string, needle: string, startLine: number, slack = 3): AnchorMatch | null {
  const haystackLines = haystack.split("\n");
  const needleLines = needle.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const fits = (start: number): boolean => start >= 0
    && start + needleLines.length <= haystackLines.length
    && needleLines.every((line, offset) => haystackLines[start + offset].replace(/\r$/, "").trim() === line.trim());

  // A hit on the declared line is unambiguous by definition. Only when the
  // stated number is wrong does the search widen, and then it must be unique.
  let start = startLine - 1;
  if (!fits(start)) {
    const found: number[] = [];
    for (let candidate = Math.max(0, startLine - 1 - slack); candidate <= startLine - 1 + slack; candidate += 1) {
      if (fits(candidate)) found.push(candidate);
    }
    if (found.length !== 1) return null;
    start = found[0];
  }

  const index = haystackLines.slice(0, start).reduce((total, line) => total + line.length + 1, 0);
  const matchedText = haystackLines.slice(start, start + needleLines.length).join("\n");
  const fileIndent = /^\s*/.exec(haystackLines[start])?.[0].replace(/\r$/, "") ?? "";
  const needleIndent = /^\s*/.exec(needleLines[0])?.[0] ?? "";
  return {
    index,
    length: matchedText.length,
    crlf: matchedText.includes("\r"),
    indentDelta: fileIndent.startsWith(needleIndent) ? fileIndent.slice(needleIndent.length) : "",
  };
}

export function applyEditBlocks(original: string, edits: EditBlock[]): string {
  let next = original;
  for (const [index, edit] of edits.entries()) {
    let match: AnchorMatch | null = edit.startLine ? anchoredMatch(next, edit.find, edit.startLine) : null;
    if (!match) {
      try {
        match = exactMatch(next, edit.find);
      } catch {
        throw new Error(`Edit ${index + 1} matched more than once. Set start_line to the line number of the first find line, or extend the find block until it is unique.`);
      }
    }
    match ??= indentTolerantMatch(next, edit.find);
    if (!match) {
      throw new Error(`Edit ${index + 1} did not match the current file. Copy the find block exactly from the CURRENT FILE section.${mismatchHint(next, edit.find)}`);
    }
    const reindented = reindent(edit.replace, match.indentDelta);
    const replacement = match.crlf ? reindented.replace(/\r?\n/g, "\r\n") : reindented.replace(/\r\n/g, "\n");
    next = next.slice(0, match.index) + replacement + next.slice(match.index + match.length);
  }
  if (next === original) throw new Error("The edit blocks produced no change to the file.");
  return next;
}

export interface TargetView {
  text: string;
  windowed: boolean;
  totalLines: number;
}

function scoreLine(line: string, terms: string[]): number {
  const lowered = line.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lowered.includes(term)) score += term.length >= 5 ? 3 : 1;
  }
  return score;
}

/**
 * Renders a file for Apply. Small files are shown whole. Large files are shown
 * as numbered regions around the lines that match the change intent, with the
 * gaps marked so the model knows it is not seeing everything.
 */
export function targetView(
  content: string,
  budgetChars: number,
  focusTerms: string[],
  options: { contextLines?: number; numbered?: boolean } = {},
): TargetView {
  const { contextLines = 24, numbered = false } = options;
  const lines = content.split("\n");
  const render = (start: number, end: number): string => lines
    .slice(start, end)
    .map((line, offset) => (numbered ? `${start + offset + 1}${LINE_NUMBER_MARKER}${line}` : line))
    .join("\n");

  if (content.length + (numbered ? lines.length * 6 : 0) <= budgetChars) {
    return { text: render(0, lines.length), windowed: false, totalLines: lines.length };
  }

  const terms = [...new Set(focusTerms.map((term) => term.toLowerCase()).filter((term) => term.length >= 3))].slice(0, 24);
  const scored = lines
    .map((line, index) => ({ index, score: scoreLine(line, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const cost = (start: number, end: number): number => render(start, end).length + 24;

  // The head of a file carries its imports and is worth showing, but it never
  // takes so much of the budget that the matching regions get squeezed out.
  const headBudget = Math.floor(budgetChars * 0.35);
  let headEnd = 0;
  while (headEnd < Math.min(lines.length, contextLines) && cost(0, headEnd + 1) <= headBudget) headEnd += 1;

  const ranges: Array<{ start: number; end: number }> = headEnd > 0 ? [{ start: 0, end: headEnd }] : [];
  let used = headEnd > 0 ? cost(0, headEnd) : 0;

  for (const hit of scored) {
    if (used >= budgetChars) break;
    let span = contextLines;
    while (span >= 1) {
      const start = Math.max(0, hit.index - span);
      const end = Math.min(lines.length, hit.index + span);
      if (ranges.some((range) => start < range.end && end > range.start)) break;
      if (used + cost(start, end) <= budgetChars) {
        ranges.push({ start, end });
        used += cost(start, end);
        break;
      }
      span = span > 1 ? Math.floor(span / 2) : 0;
    }
  }

  ranges.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 2) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) parts.push(`… lines ${cursor + 1}-${range.start} omitted …`);
    parts.push(`[lines ${range.start + 1}-${range.end}]\n${render(range.start, range.end)}`);
    cursor = range.end;
  }
  if (cursor < lines.length) parts.push(`… lines ${cursor + 1}-${lines.length} omitted …`);

  return { text: parts.join("\n\n"), windowed: true, totalLines: lines.length };
}

/**
 * Repairs the two ways a small model commonly corrupts whole-file output: it
 * prints the file name as the first line, or it wraps the body in a markdown
 * fence. Both are stripped only when unambiguous — a bare path on its own line
 * is not valid content in any supported language, and a fence is removed only
 * when it encloses the entire body.
 */
export function normalizeFileContent(content: string, filePath: string): string {
  let text = content.replace(/^﻿/, "");

  const fenced = /^\s*```[a-zA-Z0-9_+-]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```\s*$/.exec(text);
  if (fenced) text = fenced[1];

  const basename = filePath.split("/").pop() ?? filePath;
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first !== -1) {
    const candidate = lines[first].trim().replace(/:$/, "");
    // Prose formats can legitimately open with a file name, but no code or data
    // file can, so a bare path there is always a stray label.
    const prose = /\.(?:md|markdown|txt|rst|adoc)$/i.test(filePath);
    const strayLabel = candidate === filePath
      || candidate === basename
      || (!prose && /^[\w./@-]+\.[A-Za-z0-9]{1,6}$/.test(candidate));
    if (strayLabel && lines.slice(first + 1).some((line) => line.trim())) {
      lines.splice(first, 1);
      text = lines.join("\n").replace(/^\r?\n/, "");
    }
  }
  return text;
}

export function focusTermsFor(...sources: string[]): string[] {
  return [...new Set(sources.join(" ").toLowerCase().match(/[a-z_][a-z0-9_.-]{2,}/g) || [])].slice(0, 32);
}

export const __testables = { indentTolerantMatch, mismatchHint, scoreLine };
