import { promises as fs } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express, { type Express } from "express";
import type { AgentDecisionRequest, AgentRouteRequest, AgentRunRequest, ChatRequest, ProviderConfig } from "../shared/types.js";
import { recoverInterruptedPromotions, resumeAgentLoop, runAgentLoop, runAgentLoopV2 } from "./agent.js";
import {
  buildContextPack,
  ensureContextStore,
  ensureProjectCard,
  refreshProjectIndex,
  saveStoreConfig,
  summarizeStore,
} from "./context-store.js";
import { CONTEXT_PROFILE_TOKENS, isContextProfileName } from "./model-profile.js";
import { resolveAgentIntent } from "./intent-router.js";
import { chatWithLocalModel, discoverLocalRuntimes, listLocalModels } from "./providers.js";
import { listRunManifests, readRunManifest, recoverInterruptedRuns } from "./run-store.js";
import { readProjectScripts, readWorkspaceStatus, runProjectCheck, searchWorkspace } from "./workbench.js";
import { buildWorkspaceTree, createSnapshot, createWorkspaceEntry, deleteWorkspaceEntry, readWorkspaceFile, renameWorkspaceEntry, repositoryMap, retrieveEvidence, saveWorkspaceFile, workspaceRoot } from "./workspace.js";
import { createTerminal, getTerminal, resizeTerminal, destroyTerminal } from "./terminal.js";

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    ["ollama", "lmstudio", "llamacpp"].includes(String(record.kind)) &&
    typeof record.endpoint === "string" &&
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(?:\/.*)?$/i.test(record.endpoint) &&
    typeof record.model === "string" &&
    typeof record.temperature === "number" &&
    record.temperature >= 0 &&
    record.temperature <= 2
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof TypeError && /fetch failed/i.test(error.message)) {
    return "Could not reach the local model server. Make sure its API server is started, then retry discovery.";
  }
  return error instanceof Error ? error.message : "Unknown server error";
}

async function findRendererDist(): Promise<string | undefined> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, "../../dist"),
    path.resolve(process.cwd(), "dist"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, "index.html"));
      return candidate;
    } catch {
      // Continue to the next packaging/development layout.
    }
  }
  return undefined;
}

export async function createApiApp(): Promise<Express> {
  const app = express();
  const recoveredTransactions = await recoverInterruptedPromotions();
  const recoveredRuns = await recoverInterruptedRuns();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "4mb" }));

  // The Electron renderer uses the API without a token because it is served by
  // the same embedded process. The Code-OSS extension launches the sidecar with
  // a random token so that other local processes cannot silently submit agent
  // runs to its loopback port.
  const apiToken = process.env.FORGE_API_TOKEN?.trim();
  app.use("/api", (request, response, next) => {
    if (apiToken && request.header("authorization") !== `Bearer ${apiToken}`) {
      response.status(401).json({ error: "Invalid Forge sidecar token." });
      return;
    }
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({
      ok: true,
      workspace: workspaceRoot(),
      desktop: Boolean(process.env.FORGE_DESKTOP),
      codeOss: Boolean(process.env.FORGE_CODE_OSS),
      forgeVersion: 2,
      recoveredTransactions,
      recoveredRuns,
    });
  });

  app.get("/api/runtimes", async (_request, response) => {
    try {
      response.json({ runtimes: await discoverLocalRuntimes() });
    } catch (error) {
      response.status(502).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/tree", async (_request, response) => {
    try {
      response.json({ nodes: await buildWorkspaceTree(), root: workspaceRoot() });
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/search", async (request, response) => {
    try {
      const query = String(request.query.q || "").trim();
      response.json({ results: await searchWorkspace(query) });
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/workspace/status", async (_request, response) => {
    try {
      response.json(await readWorkspaceStatus());
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/project/scripts", async (_request, response) => {
    try {
      response.json(await readProjectScripts());
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/project/check", async (request, response) => {
    const name = typeof request.body?.name === "string" ? request.body.name : "";
    const controller = new AbortController();
    let finished = false;
    response.on("close", () => {
      if (!finished) controller.abort();
    });
    try {
      const result = await runProjectCheck(name, controller.signal);
      finished = true;
      response.json(result);
    } catch (error) {
      finished = true;
      if (!response.writableEnded) response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/terminal/spawn", (request, response) => {
    try {
      const { cols = 80, rows = 24 } = request.body || {};
      const { id } = createTerminal(cols, rows);
      response.json({ id });
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/terminal/:id/stream", (request, response) => {
    const { id } = request.params;
    const pty = getTerminal(id);
    if (!pty) {
      response.status(404).json({ error: "Terminal not found." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    
    const onData = (data: string) => {
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    
    const disposable = pty.onData(onData);
    
    request.on("close", () => {
      disposable.dispose();
    });
  });

  app.post("/api/terminal/:id/input", (request, response) => {
    const { id } = request.params;
    const { data } = request.body || {};
    const pty = getTerminal(id);
    if (!pty) {
      response.status(404).json({ error: "Terminal not found." });
      return;
    }
    if (typeof data === "string") {
      pty.write(data);
    }
    response.json({ success: true });
  });

  app.post("/api/terminal/:id/resize", (request, response) => {
    const { id } = request.params;
    const { cols, rows } = request.body || {};
    const pty = getTerminal(id);
    if (!pty) {
      response.status(404).json({ error: "Terminal not found." });
      return;
    }
    if (typeof cols === "number" && typeof rows === "number") {
      resizeTerminal(id, cols, rows);
    }
    response.json({ success: true });
  });

  app.get("/api/context", async (_request, response) => {
    try {
      response.json(await summarizeStore());
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/context/refresh", async (_request, response) => {
    try {
      await ensureContextStore();
      const snapshot = await createSnapshot();
      const index = await refreshProjectIndex(snapshot);
      await ensureProjectCard(snapshot, index);
      response.json({ snapshotId: snapshot.id, ...(await summarizeStore()) });
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/context/pack", async (request, response) => {
    try {
      const body = request.body as Record<string, unknown>;
      const taskText = typeof body.task === "string" ? body.task : "";
      if (!taskText.trim()) {
        response.status(400).json({ error: "A task description is required to build a context pack." });
        return;
      }
      const summary = await summarizeStore();
      const budgetChars = typeof body.budgetChars === "number" && body.budgetChars > 0
        ? Math.min(Math.floor(body.budgetChars), summary.budget.plannerPrompt)
        : summary.budget.contextPack;
      const focusPaths = Array.isArray(body.focusPaths)
        ? body.focusPaths.filter((item): item is string => typeof item === "string").slice(0, 12)
        : [];
      const pack = await buildContextPack({ taskText, budgetChars, focusPaths });
      response.json({ pack, chars: pack.length, budgetChars });
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.put("/api/context/config", async (request, response) => {
    try {
      const body = request.body as Record<string, unknown>;
      if (body.profile !== undefined && !isContextProfileName(body.profile)) {
        response.status(400).json({ error: `profile must be one of ${Object.keys(CONTEXT_PROFILE_TOKENS).join(", ")}.` });
        return;
      }
      await saveStoreConfig({
        profile: isContextProfileName(body.profile) ? body.profile : undefined,
        contextTokens: typeof body.contextTokens === "number" ? body.contextTokens : undefined,
        perChangeApply: typeof body.perChangeApply === "boolean" ? body.perChangeApply : undefined,
        editBlocks: typeof body.editBlocks === "boolean" ? body.editBlocks : undefined,
      });
      response.json(await summarizeStore());
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/workspace/create", async (request, response) => {
    try {
      const { path: relativePath, kind } = request.body as Record<string, unknown>;
      if (typeof relativePath !== "string" || !relativePath.trim()) {
        response.status(400).json({ error: "A file or folder name is required." });
        return;
      }
      if (kind !== "file" && kind !== "directory") {
        response.status(400).json({ error: "kind must be \"file\" or \"directory\"." });
        return;
      }
      response.json({ path: await createWorkspaceEntry(relativePath, kind), kind });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/workspace/rename", async (request, response) => {
    try {
      const { from, to } = request.body as Record<string, unknown>;
      if (typeof from !== "string" || !from.trim() || typeof to !== "string" || !to.trim()) {
        response.status(400).json({ error: "Both a current path and a new name are required." });
        return;
      }
      response.json({ path: await renameWorkspaceEntry(from, to) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/workspace/delete", async (request, response) => {
    try {
      const { path: relativePath } = request.body as Record<string, unknown>;
      if (typeof relativePath !== "string" || !relativePath.trim()) {
        response.status(400).json({ error: "A path is required." });
        return;
      }
      response.json({ path: await deleteWorkspaceEntry(relativePath) });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/file", async (request, response) => {
    try {
      const relativePath = String(request.query.path || "");
      response.json(await readWorkspaceFile(relativePath));
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.put("/api/file", async (request, response) => {
    try {
      const { path: relativePath, content, expectedSha } = request.body as Record<string, unknown>;
      if (typeof relativePath !== "string" || typeof content !== "string") {
        response.status(400).json({ error: "path and content are required" });
        return;
      }
      response.json(await saveWorkspaceFile(relativePath, content, typeof expectedSha === "string" ? expectedSha : undefined));
    } catch (error) {
      response.status(409).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/models", async (request, response) => {
    const config = request.body as unknown;
    if (!isProviderConfig(config)) {
      response.status(400).json({ error: "A valid loopback local-model configuration is required." });
      return;
    }
    try {
      const models = await listLocalModels(config);
      response.json({ models, endpoint: config.endpoint, reachable: true });
    } catch (error) {
      response.status(502).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/chat", async (request, response) => {
    const body = request.body as Partial<ChatRequest>;
    if (typeof body.prompt !== "string" || !body.prompt.trim() || !isProviderConfig(body.provider)) {
      response.status(400).json({ error: "A message and valid local-model configuration are required." });
      return;
    }
    const history = Array.isArray(body.history)
      ? body.history
        .filter((message) => message && ["user", "assistant"].includes(message.role) && typeof message.content === "string")
        .slice(-12)
        .map((message) => ({ role: message.role as "user" | "assistant", content: message.content.slice(0, 20_000) }))
      : [];
    const controller = new AbortController();
    let finished = false;
    response.on("close", () => {
      if (!finished) controller.abort();
    });
    try {
      const message = await chatWithLocalModel(
        body.provider,
        [
          {
            role: "system",
            content: "You are Forge, a concise local coding assistant. Respond conversationally using GitHub-Flavored Markdown. Use headings and lists when they improve clarity. Put every code sample in a fenced code block with an accurate language identifier. Do not claim to have inspected or changed workspace files unless an agent run actually did so.",
          },
          ...history,
          { role: "user", content: body.prompt.trim() },
        ],
        controller.signal,
        { structured: false },
      );
      finished = true;
      if (!response.writableEnded && !response.destroyed) response.json({ message });
    } catch (error) {
      finished = true;
      if (!response.writableEnded && !response.destroyed) response.status(502).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/agent/route", async (request, response) => {
    const body = request.body as Partial<AgentRouteRequest>;
    if (typeof body.prompt !== "string" || !body.prompt.trim()) {
      response.status(400).json({ error: "A prompt is required for Auto Agent routing." });
      return;
    }
    if (body.provider !== undefined && !isProviderConfig(body.provider)) {
      response.status(400).json({ error: "The Auto Agent classifier requires a valid local-model configuration." });
      return;
    }
    const controller = new AbortController();
    let finished = false;
    response.on("close", () => {
      if (!finished) controller.abort();
    });
    try {
      const decision = await resolveAgentIntent(body.prompt.trim(), body.provider, controller.signal);
      finished = true;
      if (!response.writableEnded && !response.destroyed) response.json({ decision });
    } catch (error) {
      finished = true;
      if (!response.writableEnded && !response.destroyed) response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/agent/review", async (request, response) => {
    const body = request.body as Partial<AgentRunRequest>;
    if (typeof body.prompt !== "string" || body.prompt.trim().length < 4 || !isProviderConfig(body.provider)) {
      response.status(400).json({ error: "A review request and valid local-model configuration are required." });
      return;
    }
    const controller = new AbortController();
    let finished = false;
    response.on("close", () => {
      if (!finished) controller.abort();
    });
    try {
      const snapshot = await createSnapshot();
      const evidence = await retrieveEvidence([body.prompt.trim()], [], 20, snapshot);
      const evidenceText = evidence.length
        ? evidence.map((item) => `--- ${item.path}:${item.startLine}-${item.endLine} | sha:${item.sha.slice(0, 12)}\n${item.content}`).join("\n\n")
        : `No focused excerpts matched. Use this repository map:\n${repositoryMap(snapshot, 600)}`;
      const message = await chatWithLocalModel(
        body.provider,
        [
          {
            role: "system",
            content: "You are Forge in read-only repository review mode. Analyze only the supplied snapshot evidence. Give concrete, prioritized findings and enhancements with file references. Return clean GitHub-Flavored Markdown with headings and lists, and put every code sample in a fenced code block with an accurate language identifier. Do not claim to have modified files and do not output JSON unless requested.",
          },
          {
            role: "user",
            content: `REQUEST\n${body.prompt.trim()}\n\nSNAPSHOT ${snapshot.id} (${snapshot.files.length} source files)\n\nEVIDENCE\n${evidenceText.slice(0, 100_000)}`,
          },
        ],
        controller.signal,
        { structured: false },
      );
      finished = true;
      if (!response.writableEnded && !response.destroyed) {
        response.json({ message, snapshotId: snapshot.id, fileCount: snapshot.files.length, evidenceCount: evidence.length });
      }
    } catch (error) {
      finished = true;
      if (!response.writableEnded && !response.destroyed) response.status(502).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/agent/run", async (request, response) => {
    const body = request.body as Partial<AgentRunRequest>;
    if (typeof body.prompt !== "string" || body.prompt.trim().length < 4 || !isProviderConfig(body.provider)) {
      response.status(400).json({ error: "A task and valid local-model configuration are required." });
      return;
    }

    response.status(200);
    response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("x-content-type-options", "nosniff");
    response.flushHeaders();

    const controller = new AbortController();
    let finished = false;
    response.on("close", () => {
      if (!finished) controller.abort();
    });

    try {
      const runner = body.architecture === "v1" ? runAgentLoop : runAgentLoopV2;
      await runner(
        {
          prompt: body.prompt.trim(),
          provider: body.provider,
          maxRepairCycles: body.maxRepairCycles,
          maxReplans: body.maxReplans,
          maxTasks: body.maxTasks,
          architecture: body.architecture ?? "v2",
        },
        (agentEvent) => {
          if (!response.writableEnded) response.write(`${JSON.stringify(agentEvent)}\n`);
        },
        controller.signal,
      );
    } finally {
      finished = true;
      if (!response.writableEnded) response.end();
    }
  });

  app.get("/api/agent/runs", async (_request, response) => {
    try {
      response.json({ runs: await listRunManifests() });
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/agent/runs/:runId", async (request, response) => {
    try {
      response.json({ run: await readRunManifest(String(request.params.runId || "")) });
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/agent/resume", async (request, response) => {
    const body = request.body as Partial<AgentDecisionRequest>;
    if (typeof body.runId !== "string" || !["approve", "retry", "discard"].includes(String(body.decision))) {
      response.status(400).json({ error: "A runId and valid Forge v2 decision are required." });
      return;
    }
    response.status(200);
    response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("x-content-type-options", "nosniff");
    response.flushHeaders();
    const controller = new AbortController();
    let finished = false;
    response.on("close", () => {
      if (!finished) controller.abort();
    });
    try {
      await resumeAgentLoop(
        { runId: body.runId, decision: body.decision as AgentDecisionRequest["decision"], guidance: typeof body.guidance === "string" ? body.guidance : undefined },
        (agentEvent) => {
          if (!response.writableEnded) response.write(`${JSON.stringify(agentEvent)}\n`);
        },
        controller.signal,
      );
    } finally {
      finished = true;
      if (!response.writableEnded) response.end();
    }
  });

  const distDir = await findRendererDist();
  if (distDir) {
    app.use(express.static(distDir, { fallthrough: true }));
    app.get("/{*splat}", (_request, response) => response.sendFile(path.join(distDir, "index.html")));
  }
  return app;
}

export async function startApiServer(port = Number(process.env.PORT || 8787)): Promise<{
  server: Server;
  port: number;
  url: string;
}> {
  const app = await createApiApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1");
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({ server, port: actualPort, url: `http://127.0.0.1:${actualPort}` });
    });
  });
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryPath === import.meta.url) {
  const api = await startApiServer();
  console.log(`Forge API listening on ${api.url}`);
  console.log(`Workspace: ${workspaceRoot()}`);
}
