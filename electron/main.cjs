const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session } = require("electron");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow;
let apiServer;
let apiUrl;
let workspaceModule;

/**
 * Window icon for the current system theme: light ink reads on a dark taskbar,
 * dark ink on a light one. Falls back to the static icon if the pair is
 * missing, so an older build still starts.
 */
function themedIconPath() {
  const variant = nativeTheme.shouldUseDarkColors ? "icon-light.png" : "icon-dark.png";
  const themed = path.join(__dirname, "..", "build", variant);
  return existsSync(themed) ? themed : path.join(__dirname, "..", "build", "icon.png");
}

function settingsPath() {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

async function readSettings() {
  try {
    return JSON.parse(await fs.readFile(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

async function writeSettings(settings) {
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

async function importBuiltModule(relativePath) {
  return import(pathToFileURL(path.join(__dirname, "..", "dist-server", relativePath)).href);
}

async function prepareWorkspace() {
  workspaceModule = await importBuiltModule(path.join("server", "workspace.js"));
  const settings = await readSettings();
  const developmentRoot = path.resolve(__dirname, "..");
  const fallback = app.isPackaged ? app.getPath("documents") : developmentRoot;
  const requested = process.env.WORKSPACE_ROOT || settings.lastWorkspace || fallback;
  try {
    await workspaceModule.setWorkspaceRoot(requested);
  } catch {
    await workspaceModule.setWorkspaceRoot(fallback);
  }
}

async function startEmbeddedApi() {
  process.env.FORGE_DESKTOP = "1";
  await prepareWorkspace();
  const { startApiServer } = await importBuiltModule(path.join("server", "index.js"));
  const requestedPort = process.env.FORGE_DEV_URL ? 8787 : 0;
  const started = await startApiServer(requestedPort);
  apiServer = started.server;
  apiUrl = started.url;
}

function isTrustedSender(event) {
  try {
    const senderUrl = new URL(event.senderFrame.url);
    const allowed = new URL(process.env.FORGE_DEV_URL || apiUrl);
    return senderUrl.origin === allowed.origin;
  } catch {
    return false;
  }
}

function registerIpc() {
  ipcMain.handle("forge:get-desktop-info", (event) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted renderer.");
    return {
      platform: process.platform,
      version: app.getVersion(),
      workspace: workspaceModule.workspaceRoot(),
    };
  });

  ipcMain.handle("forge:select-workspace", async (event) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted renderer.");
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Open workspace in Forge",
      defaultPath: workspaceModule.workspaceRoot(),
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Open workspace",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = await workspaceModule.setWorkspaceRoot(result.filePaths[0]);
    await writeSettings({ ...(await readSettings()), lastWorkspace: root });
    return { root };
  });

  ipcMain.on("forge:window-action", (event, action) => {
    if (!isTrustedSender(event)) return;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (action === "minimize") window.minimize();
    else if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (action === "close") window.close();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 980,
    minHeight: 660,
    show: false,
    frame: false,
    icon: themedIconPath(),
    backgroundColor: "#08070a",
    title: "Forge — Local Agent IDE",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  const rendererUrl = process.env.FORGE_DEV_URL || apiUrl;
  await mainWindow.loadURL(rendererUrl);
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = undefined; });

  // The taskbar and title bar sit on the system chrome, so the window icon
  // follows the system theme: light ink on a dark taskbar, dark ink on a light
  // one. The icon compiled into the .exe cannot change — Windows has no
  // theme-variant icon mechanism — so this only affects the running window.
  nativeTheme.on("updated", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setIcon(themedIconPath());
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (new URL(targetUrl).origin !== new URL(rendererUrl).origin) event.preventDefault();
  });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady()
  .then(async () => {
    app.setAppUserModelId("com.forge.localagent");
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    await startEmbeddedApi();
    registerIpc();
    await createWindow();
  })
  .catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error("Forge desktop failed to start:", message);
    dialog.showErrorBox("Forge desktop failed to start", message);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  apiServer?.close();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
