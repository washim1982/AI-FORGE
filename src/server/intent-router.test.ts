import assert from "node:assert/strict";
import test from "node:test";
import { decisionFromModel, routeAgentIntent } from "./intent-router.js";

test("intent router does not confuse prose about errors with failure evidence", () => {
  const decision = routeAgentIntent("Build an error-handling middleware for the API");
  assert.equal(decision.intent, "CREATE");
  assert.equal(decision.target, "agent");
});

test("credible repair evidence gates creation intent", () => {
  const decision = routeAgentIntent("Build the feature, but npm ERR! EACCES currently blocks install");
  assert.equal(decision.intent, "FIX");
  assert.equal(decision.target, "agent");

  const lowerRepairScore = routeAgentIntent("Build a new project and implement the API after resolving EACCES");
  assert.equal(lowerRepairScore.intent, "FIX");
});

test("router separates read-only research, learning, and chat", () => {
  assert.equal(routeAgentIntent("Review this repository and suggest enhancements").intent, "RESEARCH");
  assert.equal(routeAgentIntent("Explain how the event stream works").intent, "LEARN");
  assert.equal(routeAgentIntent("Hello!").intent, "CHAT");
});

test("router abstains on weak and near-tied requests", () => {
  assert.equal(routeAgentIntent("Make it better").intent, "CLARIFY");
  assert.equal(routeAgentIntent("Build a tutorial for fixing flaky tests").intent, "CLARIFY");
});

test("model tier accepts a clear winner and abstains on a near tie", () => {
  const create = decisionFromModel({
    scores: { CHAT: 0.02, CREATE: 0.92, FIX: 0.1, RESEARCH: 0.2, LEARN: 0.1 },
    rationale: "The request explicitly asks to modify files.",
  });
  assert.equal(create?.intent, "CREATE");
  assert.equal(create?.tier, "model");

  const ambiguous = decisionFromModel({
    scores: { CHAT: 0.05, CREATE: 0.74, FIX: 0.12, RESEARCH: 0.68, LEARN: 0.1 },
    rationale: "Both review and implementation are requested.",
  });
  assert.equal(ambiguous?.intent, "CLARIFY");
  assert.equal(ambiguous?.target, "clarify");
});

test("model tier rejects malformed scores", () => {
  assert.equal(decisionFromModel({ scores: { CREATE: 2 } }), null);
});
