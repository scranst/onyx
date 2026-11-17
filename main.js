/**
 * Onyx — Electron main process.
 *
 * Reconstructed from Obsidian 1.15.1 (resources/app.asar → main.js) using REA
 * (https://github.com/morluto/rea). Channel names and behaviors mirror the
 * ipcMain handlers observed in the original, trimmed to Onyx's feature set.
 *
 * Obsidian facts recovered from the original (see README.md for details):
 *   - window: 800x600, backgroundColor #1e1e1e, custom title bar
 *   - vault roster persisted in a JSON file in userData (original: obsidian.json)
 *   - per-vault config dir (original: .obsidian/ with appearance.json, app.json,
 *     core-plugins.json, hotkeys.json, workspace.json)
 *   - custom "app://" file protocol serves vault content to the renderer
 *   - IPC surface: vault-list/vault-open/vault-move/vault-remove, trash,
 *     resources, get-default-vault-path, context-menu, set-menu, check-update
 */
const { app, BrowserWindow, ipcMain, shell, protocol, net } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const { pathToFileURL } = require("url");

const VAULT_LIST_FILE = "onyx-vaults.json"; // original: "obsidian.json"
const CONFIG_DIR = ".onyx"; // original: ".obsidian"
const BG_COLOR = "#1e1e1e"; // original window background

let mainWindow = null;
let currentVault = null;

// ---------------------------------------------------------------- vault roster

const vaultListPath = () => path.join(app.getPath("userData"), VAULT_LIST_FILE);

const readVaultList = () => {
  try {
    return JSON.parse(fs.readFileSync(vaultListPath(), "utf8"));
  } catch {
    return { vaults: {} }; // original shape: { vaults: { [path]: { ts, name? } } }
  }
};

const writeVaultList = (list) => {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(vaultListPath(), JSON.stringify(list, null, 2), "utf8");
};

// ------------------------------------------------------------- window creation

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 800, // original default
    height: 600,
    backgroundColor: BG_COLOR,
    title: "Onyx",
    webPreferences: {
      // Obsidian ships contextIsolation:false + nodeIntegration:true so that
      // third-party plugins get full Node access. Onyx keeps the same plugin
      // contract but routes file I/O through the preload bridge where possible.
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  if (process.env.ONYX_HEADLESS) {
    // Smoke-test mode: verify the renderer booted, then exit.
    mainWindow.webContents.executeJavaScript("document.readyState + ':' + !!window.onyx")
      .then((result) => { console.log(`onyx headless smoke: ${result}`); app.quit(); })
      .catch((err) => { console.error("onyx headless smoke failed:", err.message); app.exit(1); });
    return;
  }
  mainWindow.on("closed", () => (mainWindow = null));
};

// ------------------------------------------------------------------ app:// glue

// Serve vault files to the renderer through a custom protocol, the way the
// original registers "app" (protocol.handle / registerFileProtocol in main.js).
app.whenReady().then(() => {
  protocol.handle("onyx", (request) => {
    if (!currentVault) return new Response("", { status: 404 });
    const rel = decodeURIComponent(new URL(request.url).pathname);
    const abs = path.join(currentVault, rel);
    if (!abs.startsWith(currentVault)) return new Response("", { status: 403 });
    return net.fetch(pathToFileURL(abs).toString());
  });

  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());

// --------------------------------------------------------- IPC: vault lifecycle
// Channel names follow the original's ipcMain handlers.

ipcMain.on("vault-list", (event) => {
  const list = readVaultList();
  event.returnValue = Object.entries(list.vaults).map(([dir, meta]) => ({
    path: dir,
    name: meta.name ?? path.basename(dir),
    ts: meta.ts ?? 0,
  }));
});

ipcMain.on("vault-open", (event, dir) => {
  if (!dir || !fs.existsSync(dir)) { event.returnValue = null; return; }
  const list = readVaultList();
  list.vaults[dir] = { ts: Date.now(), name: path.basename(dir) }; // "most recently used" roster
  writeVaultList(list);
  currentVault = dir;
  event.returnValue = { path: dir, name: path.basename(dir), configDir: CONFIG_DIR };
});

ipcMain.on("vault-remove", (event, dir) => {
  // Removes the vault from the roster without deleting any files (original wording).
  const list = readVaultList();
  delete list.vaults[dir];
  writeVaultList(list);
  event.returnValue = true;
});

ipcMain.on("vault-move", (event, from, to) => {
  const list = readVaultList();
  const meta = list.vaults[from];
  if (!meta) { event.returnValue = false; return; }
  delete list.vaults[from];
  list.vaults[to] = meta;
  writeVaultList(list);
  event.returnValue = true;
});

ipcMain.on("vault-create", (event, dir) => {
  // Creates the folder (original: "Create new vault" wizard) then lets the
  // normal vault-open flow register it.
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    event.returnValue = true;
  } catch { event.returnValue = false; }
});

ipcMain.on("vault-message", (event, msg) => mainWindow?.webContents.send("vault-message", msg));

// --------------------------------------------------------------- IPC: utilities

ipcMain.on("get-default-vault-path", (event) => {
  // Original: Documents dir when it exists, else the home directory.
  try { event.returnValue = app.getPath("documents") || os.homedir(); }
  catch { event.returnValue = os.homedir(); }
});

ipcMain.on("resources", (event) => {
  // Original returns bundled asset paths; Onyx serves everything from app://.
  event.returnValue = { root: path.join(__dirname, "renderer") };
});

ipcMain.handle("trash", async (_event, filePath, askConfirm) => {
  // Original offers system trash via adapter.trashSystem; fall back to unlink.
  try {
    await shell.trashItem(filePath);
    return true;
  } catch (err) {
    if (askConfirm) return err.message;
    await fsp.unlink(filePath);
    return true;
  }
});

ipcMain.on("context-menu", (event, menuSpec) => {
  // Original builds an Electron Menu from the renderer spec.
  const { Menu } = require("electron");
  const menu = Menu.buildFromTemplate(
    (menuSpec ?? []).map(({ label, command }) => ({
      label,
      click: () => mainWindow?.webContents.send("context-menu-command", command),
    })),
  );
  menu.popup({ window: mainWindow });
});

ipcMain.on("check-update", (event) => {
  // The original asks the updater for the latest public version; Onyx is quiet.
  event.returnValue = null;
});

ipcMain.on("startup", (event) => { event.returnValue = app.getVersion(); });
ipcMain.on("version", (event) => { event.returnValue = app.getVersion(); });

// --------------------------------------------------- IPC: vault "adapter" (fs)
// The original renderer talks to the vault through an adapter object with
// read/write/exists/stat/remove/list operations. Onyx mirrors that surface as
// synchronous IPC, resolving paths inside the current vault only.

const inVault = (rel) => {
  if (!currentVault || typeof rel !== "string") return null;
  const abs = path.resolve(currentVault, rel);
  return abs.startsWith(path.resolve(currentVault)) ? abs : null;
};

ipcMain.on("adapter-read", (event, rel) => {
  const abs = inVault(rel);
  try { event.returnValue = { data: abs ? fs.readFileSync(abs, "utf8") : null }; }
  catch (err) { event.returnValue = { error: err.message }; }
});

ipcMain.on("adapter-write", (event, rel, data) => {
  const abs = inVault(rel);
  if (!abs) { event.returnValue = { error: "not in vault" }; return; }
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data, "utf8");
    event.returnValue = { ok: true };
  } catch (err) { event.returnValue = { error: err.message }; }
});

ipcMain.on("adapter-exists", (event, rel) => {
  const abs = inVault(rel);
  event.returnValue = abs ? fs.existsSync(abs) : false;
});

ipcMain.on("adapter-stat", (event, rel) => {
  const abs = inVault(rel);
  try {
    const s = fs.statSync(abs);
    event.returnValue = { type: s.isDirectory() ? "folder" : "file", ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
  } catch { event.returnValue = null; }
});

ipcMain.on("adapter-remove", (event, rel) => {
  const abs = inVault(rel);
  try { fs.rmSync(abs, { recursive: true }); event.returnValue = true; }
  catch { event.returnValue = false; }
});

ipcMain.on("adapter-list", (event, rel, { recursive = true } = {}) => {
  const abs = inVault(rel ?? "");
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue; // hidden config dirs stay out of the index
      const full = path.join(dir, entry.name);
      const relPath = path.relative(currentVault, full).split(path.sep).join("/");
      if (entry.isDirectory()) { out.push({ path: relPath, type: "folder" }); if (recursive) walk(full); }
      else out.push({ path: relPath, type: "file" });
    }
  };
  try { walk(abs); event.returnValue = out; } catch { event.returnValue = []; }
});
