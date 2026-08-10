import type { ContextBudget, ContextProfileName } from "../shared/types.js";

export const CONTEXT_PROFILE_TOKENS: Record<ContextProfileName, number> = {
  tiny: 4096,
  small: 8192,
  balanced: 32768,
  large: 131072,
};

export const DEFAULT_CONTEXT_PROFILE: ContextProfileName = "small";

const CHARS_PER_TOKEN = 3.5;

// A local runtime spends its window on the system prompt, the schema, the
// prompt body, and the completion. Only about half of it can hold repository
// material before a small model starts truncating its own answer.
const PROMPT_SHARE = 0.5;

export function clampContextTokens(value: unknown): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!Number.isFinite(parsed)) return CONTEXT_PROFILE_TOKENS[DEFAULT_CONTEXT_PROFILE];
  return Math.max(2048, Math.min(parsed, 1_000_000));
}

export function isContextProfileName(value: unknown): value is ContextProfileName {
  return typeof value === "string" && value in CONTEXT_PROFILE_TOKENS;
}

/**
 * Every prompt the agent builds is sized from this budget instead of from fixed
 * constants, so the same loop runs on a 4k local model and on a 128k one.
 */
export function budgetsFor(contextTokens: number): ContextBudget {
  const tokens = clampContextTokens(contextTokens);
  const usable = Math.floor(tokens * CHARS_PER_TOKEN * PROMPT_SHARE);
  return {
    contextTokens: tokens,
    plannerPrompt: usable,
    retrievalPrompt: usable,
    gatherEvidence: Math.floor(usable * 0.75),
    applyTarget: Math.floor(usable * 0.7),
    supplementalEvidence: Math.floor(usable * 0.35),
    diagnostics: Math.floor(usable * 0.3),
    contextPack: Math.floor(usable * 0.3),
    // A whole-file rewrite has to fit in the completion as well as the prompt,
    // so it gets a much smaller allowance than a read-only view of the target.
    wholeFileRewriteLimit: Math.floor(usable * 0.35),
    evidenceRegions: Math.max(4, Math.min(Math.round(usable / 1500), 18)),
    maxTasks: tokens <= 8192 ? 8 : 6,
    maxChangesPerBrief: tokens <= 8192 ? 3 : 6,
  };
}

export function profileForTokens(contextTokens: number): ContextProfileName {
  const tokens = clampContextTokens(contextTokens);
  const entries = Object.entries(CONTEXT_PROFILE_TOKENS) as Array<[ContextProfileName, number]>;
  const exact = entries.find(([, value]) => value === tokens);
  return exact ? exact[0] : "balanced";
}

/**
 * Local model names usually advertise their parameter count. A 1–8B model is
 * assumed to be running with a small window unless the workspace overrides it.
 */
export function suggestedProfileForModel(model: string): ContextProfileName {
  const normalized = model.toLowerCase();
  const parameters = normalized.match(/(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/);
  const billions = parameters ? Number.parseFloat(parameters[1]) : NaN;
  if (Number.isFinite(billions)) {
    if (billions <= 2) return "tiny";
    if (billions <= 9) return "small";
    if (billions <= 40) return "balanced";
    return "large";
  }
  return DEFAULT_CONTEXT_PROFILE;
}

export function truncateForBudget(value: string, budget: number, label = "content"): string {
  if (budget <= 0) return "";
  if (value.length <= budget) return value;
  const notice = `\n… ${label} truncated to fit the configured context budget.`;
  if (budget <= notice.length) return value.slice(0, budget);
  return `${value.slice(0, budget - notice.length)}${notice}`;
}
