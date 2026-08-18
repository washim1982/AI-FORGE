import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

await import("./build-forge-extension.mjs");

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, "..");
const token = "forge-code-oss-integration-test";
const worker = new Worker(path.join(workspace, "extensions", "forge-agent", "server", "forge-worker.mjs"), {
  env: {
    ...process.env,
    FORGE_API_TOKEN: token,
    FORGE_CODE_OSS: "1",
    PORT: "0",
    WORKSPACE_ROOT: workspace,
  },
});

const apiUrl = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Forge worker integration test timed out.")), 20_000);
  worker.once("error", reject);
  worker.on("message", (message) => {
    if (message?.type === "ready") {
      clearTimeout(timeout);
      resolve(message.url);
    } else if (message?.type === "error") {
      clearTimeout(timeout);
      reject(new Error(message.message));
    }
  });
});

try {
  const unauthorized = await fetch(`${apiUrl}/api/health`);
  assert.equal(unauthorized.status, 401);

  const headers = { authorization: `Bearer ${token}` };
  const healthResponse = await fetch(`${apiUrl}/api/health`, { headers });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.codeOss, true);
  assert.equal(path.resolve(health.workspace), workspace);

  const runtimesResponse = await fetch(`${apiUrl}/api/runtimes`, { headers });
  assert.equal(runtimesResponse.status, 200);
  const runtimes = await runtimesResponse.json();
  assert.equal(Array.isArray(runtimes.runtimes), true);
  assert.equal(runtimes.runtimes.length, 3);

  const routeResponse = await fetch(`${apiUrl}/api/agent/route`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Build an error-handling middleware for the API" }),
  });
  assert.equal(routeResponse.status, 200);
  const route = await routeResponse.json();
  assert.equal(route.decision.intent, "CREATE");
  assert.equal(route.decision.target, "agent");
  assert.equal(route.decision.tier, "heuristic");

  const abstainResponse = await fetch(`${apiUrl}/api/agent/route`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Make it better" }),
  });
  assert.equal(abstainResponse.status, 200);
  const abstain = await abstainResponse.json();
  assert.equal(abstain.decision.intent, "CLARIFY");
  assert.equal(typeof abstain.decision.question, "string");
  console.log(`Forge worker integration passed at ${apiUrl}; ${runtimes.runtimes.filter((item) => item.reachable).length}/3 runtimes reachable.`);
} finally {
  await worker.terminate();
}
