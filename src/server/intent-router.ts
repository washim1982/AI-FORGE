import type {
  AgentExecutionTarget,
  AgentIntent,
  AgentRouteDecision,
  ProviderConfig,
} from "../shared/types.js";
import { chatWithLocalModel, parseModelJson } from "./providers.js";

type RoutedIntent = Exclude<AgentIntent, "CLARIFY">;

interface Signal {
  intent: RoutedIntent;
  weight: number;
  pattern: RegExp;
  label: string;
}

const SIGNALS: Signal[] = [
  // Repair artifacts are evidence, so they outweigh verbs. Errno-style codes
  // stay case-sensitive: /i would make the ordinary word "Error" look like an
  // errno and recreate the routing defect called out in the architecture.
  { intent: "FIX", weight: 3, pattern: /\bE[A-Z]{4,}\b/, label: "errno code" },
  { intent: "FIX", weight: 3, pattern: /npm ERR!|yarn error/, label: "package-manager error" },
  { intent: "FIX", weight: 3, pattern: /\b[A-Z]\w+(?:Error|Exception):/, label: "exception line" },
  { intent: "FIX", weight: 3, pattern: /\btraceback\b|\bstack trace\b/i, label: "traceback" },
  { intent: "FIX", weight: 3, pattern: /\bexit(?:ed with)? code [1-9]\b/i, label: "nonzero exit" },
  { intent: "FIX", weight: 3, pattern: /^\s*at .+\(.+:\d+:\d+\)$/m, label: "JavaScript stack frame" },
  { intent: "FIX", weight: 2, pattern: /\b(fix|debug|repair|resolve|patch|failing|fails|crashes|broken|regression)\b/i, label: "repair verb" },

  { intent: "CREATE", weight: 2, pattern: /\b(build|create|scaffold|initiali[sz]e|implement|generate|set up|add|update|change|refactor|rewrite|remove|delete|rename)\b/i, label: "mutation verb" },
  { intent: "CREATE", weight: 1, pattern: /\b(new project|from scratch|greenfield|boilerplate|starter)\b/i, label: "creation artifact" },

  { intent: "RESEARCH", weight: 2, pattern: /\b(research|investigate|compare|survey|look up|find out|audit|review|inspect|analy[sz]e|assess|recommend|suggest)\b/i, label: "research verb" },
  { intent: "RESEARCH", weight: 1, pattern: /\b(which|what are the|options for|trade-?offs|findings|enhancements)\b/i, label: "research artifact" },

  { intent: "LEARN", weight: 2, pattern: /\b(explain|teach me|walk me through|tutorial|how does|why does|what is|summari[sz]e)\b/i, label: "learning verb" },

  { intent: "CHAT", weight: 3, pattern: /^\s*(hi|hello|hey|good\s+(morning|afternoon|evening)|thanks|thank\s+you)[\s!.,?]*$/i, label: "conversation marker" },
  { intent: "CHAT", weight: 2, pattern: /\b(brainstorm|chat|discuss|talk through)\b/i, label: "conversation verb" },
];

const MIN_SCORE = 2;
const NEAR_TIE_MARGIN = 1;
const MODEL_MIN_SCORE = 0.65;
const MODEL_NEAR_TIE_MARGIN = 0.15;

const TARGETS: Record<RoutedIntent, AgentExecutionTarget> = {
  CHAT: "chat",
  CREATE: "agent",
  FIX: "agent",
  RESEARCH: "review",
  LEARN: "chat",
};

const CLARIFY_QUESTION = "Should Forge modify the workspace, diagnose a failure, perform a read-only review, or only explain the topic?";

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clarify(
  scores: AgentRouteDecision["scores"],
  rationale: string,
  tier: AgentRouteDecision["tier"] = "human",
): AgentRouteDecision {
  return {
    intent: "CLARIFY",
    target: "clarify",
    confidence: 0,
    rationale,
    scores,
    tier,
    question: CLARIFY_QUESTION,
  };
}

/**
 * Cheap deterministic tier from §§4 and 14.1 of the reviewed architecture.
 * It acts only on a clear winner; low scores and near ties deliberately ask.
 */
export function routeAgentIntent(prompt: string): AgentRouteDecision {
  const scores: AgentRouteDecision["scores"] = {};
  const matches = new Map<RoutedIntent, string[]>();

  for (const signal of SIGNALS) {
    // RegExp instances have no global flag, so test() is stable across calls.
    if (!signal.pattern.test(prompt)) continue;
    scores[signal.intent] = (scores[signal.intent] ?? 0) + signal.weight;
    matches.set(signal.intent, [...(matches.get(signal.intent) ?? []), signal.label]);
  }

  const ranked = (Object.entries(scores) as Array<[RoutedIntent, number]>).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return clarify(scores, "No decisive intent signal; asking instead of guessing.");

  let [topIntent, topScore] = ranked[0];
  const fixScore = scores.FIX ?? 0;

  // Credible failure evidence gates creation: planning new work against an
  // already broken environment wastes the run and hides the actual blocker.
  if ((topIntent === "CREATE" || topIntent === "FIX") && fixScore >= 3 && (scores.CREATE ?? 0) > 0) {
    return {
      intent: "FIX",
      target: "agent",
      confidence: 0.8,
      rationale: `Repair evidence (${fixScore}) gates creation intent (${topScore}).`,
      scores,
      tier: "heuristic",
    };
  }

  const secondScore = ranked.find(([intent]) => intent !== topIntent)?.[1] ?? 0;
  if (topScore < MIN_SCORE) {
    return clarify(scores, `Top signal ${topIntent} scored ${topScore}, below ${MIN_SCORE}.`);
  }
  if (topScore - secondScore < NEAR_TIE_MARGIN) {
    return clarify(scores, `Near tie: ${topIntent} ${topScore} versus runner-up ${secondScore}.`);
  }

  return {
    intent: topIntent,
    target: TARGETS[topIntent],
    confidence: clamp((topScore - secondScore) / topScore),
    rationale: `Matched ${(matches.get(topIntent) ?? []).join(", ")}.`,
    scores,
    tier: "heuristic",
  };
}

function modelScores(value: unknown): Partial<Record<RoutedIntent, number>> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawScores = record.scores;
  if (!rawScores || typeof rawScores !== "object") return null;
  const result: Partial<Record<RoutedIntent, number>> = {};
  for (const intent of ["CHAT", "CREATE", "FIX", "RESEARCH", "LEARN"] as const) {
    const score = (rawScores as Record<string, unknown>)[intent];
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) return null;
    result[intent] = score;
  }
  return result;
}

export function decisionFromModel(value: unknown): AgentRouteDecision | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const scores = modelScores(value);
  if (!scores) return null;
  const ranked = (Object.entries(scores) as Array<[RoutedIntent, number]>).sort((a, b) => b[1] - a[1]);
  let [topIntent, topScore] = ranked[0];
  const fixScore = scores.FIX ?? 0;
  if ((topIntent === "CREATE" || topIntent === "FIX") && fixScore >= 0.8 && (scores.CREATE ?? 0) > 0) {
    return {
      intent: "FIX",
      target: "agent",
      confidence: 0.8,
      rationale: "High-confidence repair evidence gates the requested creation work.",
      scores,
      tier: "model",
    };
  }
  const secondScore = ranked.find(([intent]) => intent !== topIntent)?.[1] ?? 0;
  const rationale = typeof record.rationale === "string" ? record.rationale.trim().slice(0, 500) : "Local classifier decision.";
  if (topScore < MODEL_MIN_SCORE) return clarify(scores, `Local classifier abstained: ${rationale}`);
  if (topScore - secondScore < MODEL_NEAR_TIE_MARGIN) {
    return clarify(scores, `Local classifier found a near tie: ${topIntent} ${topScore.toFixed(2)} versus ${secondScore.toFixed(2)}.`);
  }
  return {
    intent: topIntent,
    target: TARGETS[topIntent],
    confidence: clamp(topScore - secondScore),
    rationale,
    scores,
    tier: "model",
  };
}

/**
 * Full two-tier route. The model is consulted only after the free heuristic
 * abstains; malformed, low-confidence, and unavailable classifier results all
 * fall back to a human clarification instead of silently choosing a tool mode.
 */
export async function resolveAgentIntent(
  prompt: string,
  provider?: ProviderConfig,
  signal?: AbortSignal,
): Promise<AgentRouteDecision> {
  const heuristic = routeAgentIntent(prompt);
  if (heuristic.intent !== "CLARIFY" || !provider) return heuristic;

  try {
    const raw = await chatWithLocalModel(
      { ...provider, temperature: 0 },
      [
        {
          role: "system",
          content: `Classify one Forge request. Return only JSON with this exact shape:\n{"scores":{"CHAT":0,"CREATE":0,"FIX":0,"RESEARCH":0,"LEARN":0},"rationale":"short reason"}\nEach score is from 0 to 1. CREATE means modify workspace files. FIX means diagnose or repair an existing failure. RESEARCH means read-only repository inspection. LEARN means explanation without repository tools. CHAT means ordinary conversation. Score the requested action, not words mentioned inside examples.`,
        },
        {
          role: "user",
          content: `REQUEST\n${prompt.slice(0, 20_000)}\n\nHEURISTIC\n${JSON.stringify(heuristic.scores)}`,
        },
      ],
      signal,
      { structured: true },
    );
    return decisionFromModel(parseModelJson(raw))
      ?? clarify(heuristic.scores, "The local classifier returned an invalid decision.");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Local classifier unavailable.";
    return clarify(heuristic.scores, `The local classifier could not resolve the ambiguity: ${detail.slice(0, 300)}`);
  }
}

export const __testables = { decisionFromModel };
