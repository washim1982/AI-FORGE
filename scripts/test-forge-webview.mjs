import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptDirectory, "..");
const extensionRoot = path.join(workspace, "extensions", "forge-agent");
const [source, manifestText] = await Promise.all([
  readFile(path.join(extensionRoot, "src", "extension.ts"), "utf8"),
  readFile(path.join(extensionRoot, "package.json"), "utf8"),
]);

for (const id of ["prompt", "run", "runtime", "model", "mode", "autopilot", "refresh", "statusDot", "collapseResponses"]) {
  assert.ok(source.includes(`id="${id}"`), `Missing webview control: ${id}`);
}

const scriptStart = source.indexOf("    const vscode = acquireVsCodeApi();");
const scriptEndMarker = "    vscode.postMessage({ type: 'ready' });";
const scriptEnd = source.indexOf(scriptEndMarker, scriptStart);
assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "Unable to locate the Forge webview script.");
const browserScript = source.slice(scriptStart, scriptEnd + scriptEndMarker.length);
new Function(browserScript);
assert.ok(source.includes("return String.raw`<!doctype html>"), "Webview HTML must preserve browser-script escapes.");
assert.ok(browserScript.includes("function renderMarkdown(container, value)"), "Markdown response renderer is missing.");
assert.ok(browserScript.includes("createElement(isResponse ? 'details' : 'div')"), "Collapsible response cards are missing.");
assert.ok(browserScript.includes("className = 'code-block'"), "Fenced code-block rendering is missing.");
assert.ok(browserScript.includes("event.kind === 'run.suspended'"), "Forge v2 suspension actions are missing.");
assert.ok(browserScript.includes("type: 'decision'"), "Forge v2 human-decision messaging is missing.");
assert.ok(source.includes('value="default">Auto Agent</option>'), "Auto Agent mode is missing.");
assert.ok(browserScript.includes("data.type === 'agentRoute'"), "Auto Agent route rendering is missing.");
assert.equal(browserScript.includes(".innerHTML"), false, "Model output must not be inserted as raw HTML.");
assert.ok(source.includes(".code-block code { display: block; padding: 0;"), "Block code must override inherited inline-code decoration.");
assert.ok(source.includes("background: transparent !important; box-shadow: none !important;"), "Block code background/shadow reset is missing.");

const templateStart = source.indexOf("String.raw`<!doctype html>");
const templateEnd = source.indexOf("</html>`;", templateStart);
assert.ok(templateStart >= 0 && templateEnd > templateStart, "Unable to locate the complete webview HTML template.");
const templateExpression = source.slice(templateStart, templateEnd + "</html>`".length);
const renderedHtml = new Function("scriptNonce", `return ${templateExpression};`)("test-nonce");
const renderedScriptStart = renderedHtml.indexOf("    const vscode = acquireVsCodeApi();");
const renderedScriptEnd = renderedHtml.indexOf(scriptEndMarker, renderedScriptStart);
assert.ok(renderedScriptStart >= 0 && renderedScriptEnd > renderedScriptStart, "Rendered webview script is incomplete.");
new Function(renderedHtml.slice(renderedScriptStart, renderedScriptEnd + scriptEndMarker.length));

const manifest = JSON.parse(manifestText);
assert.equal(manifest.contributes.viewsContainers.secondarySidebar[0].id, "forge");
assert.equal(manifest.contributes.viewsContainers.secondarySidebar[0].icon, "media/forge.svg");
assert.equal(manifest.icon, "media/forge.png");
assert.equal(manifest.capabilities.untrustedWorkspaces.supported, "limited");
assert.ok(manifest.activationEvents.includes("onStartupFinished"));
console.log(`Forge chat webview contract passed for extension ${manifest.version}.`);
