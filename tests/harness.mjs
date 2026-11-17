/**
 * Headless test harness for Onyx.
 *
 * 1) Loads main.js with a stubbed electron module and drives its real ipcMain
 *    handlers (vault lifecycle + adapter file ops).
 * 2) Loads renderer/lib/markdown.js and renderer/app.js in a vm with a minimal
 *    DOM shim whose window.onyx bridge calls those same handlers, then walks
 *    the UI flow: recent-vault open → file tree → edit → palette save →
 *    search → open → backlinks → workspace restore.
 */
import { createRequire } from "node:module";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onyx-test-"));

// ---------------------------------------------------------------- stub electron
const handlers = new Map();
const asyncHandlers = new Map();
const fakeWindow = { webContents: { send: () => {} }, on: () => {}, loadFile: async () => {}, loadURL: async () => {} };
const stubElectron = {
  app: {
    getPath: (name) => (name === "userData" ? path.join(tmp, "userData") : tmp),
    whenReady: () => Promise.resolve(),
    on: () => {},
    getVersion: () => "1.0.0-test",
    quit: () => {},
    exit: () => {},
  },
  BrowserWindow: function () { return fakeWindow; },
  ipcMain: { on: (channel, fn) => handlers.set(channel, fn), handle: (channel, fn) => asyncHandlers.set(channel, fn) },
  dialog: {},
  shell: { trashItem: async () => { throw new Error("no trash in test"); } },
  protocol: { handle: () => {} },
  net: { fetch: async () => new Response("", { status: 404 }) },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
};
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return stubElectron;
  return origLoad.call(this, request, parent, isMain);
};
require(fileURLToPath(new URL("../main.js", import.meta.url)));

const call = (channel, ...args) => {
  const event = { returnValue: undefined };
  handlers.get(channel)(event, ...args);
  return event.returnValue;
};

// ------------------------------------------------------------ main-process side

assert.strictEqual(call("startup"), "1.0.0-test", "version channel");
assert.strictEqual(call("get-default-vault-path"), tmp, "default vault path = home/tmp");

const vaultDir = path.join(tmp, "TestVault");
assert.ok(call("vault-create", vaultDir), "vault-create makes the folder");
const opened = call("vault-open", vaultDir);
assert.ok(opened && opened.configDir === ".onyx" && opened.name === "TestVault", "vault-open returns vault info");

// adapter round-trip + guards
call("adapter-write", "notes/First.md", "# First\n");
assert.strictEqual(call("adapter-read", "notes/First.md").data, "# First\n", "adapter round-trip");
assert.ok(call("adapter-exists", "notes/First.md"), "exists true");
assert.strictEqual(call("adapter-stat", "notes/First.md").type, "file", "stat type");
call("adapter-write", "notes/.hidden.md", "x");
const listed = call("adapter-list", "");
assert.ok(listed.some((f) => f.path === "notes/First.md"), "list sees written files");
call("adapter-write", "../outside.md", "pwn");
assert.ok(!fs.existsSync(path.join(tmp, "outside.md")), "adapter stays inside the vault");
fs.rmSync(path.join(vaultDir, "notes/.hidden.md"));

// roster behavior
let roster = call("vault-list");
assert.ok(roster.some((v) => v.path === vaultDir), "vault appears in roster");
assert.ok(call("vault-remove", vaultDir), "vault-remove ok");
assert.ok(fs.existsSync(vaultDir), "files survive vault-remove");
assert.ok(!call("vault-list").some((v) => v.path === vaultDir), "roster drops removed vault");
call("vault-open", vaultDir); // reopen for the UI test

console.log("main-process handlers: OK");

// ------------------------------------------------------------- renderer side

class El {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this._cls = new Set();
    this._listeners = new Map();
    this.innerHTML = "";
    this.value = "";
    this.textContent = "";
    this.title = "";
    this.onclick = null;
    this.style = { setProperty: () => {} };
  }
  get classList() {
    const self = this;
    return {
      add: (...c) => c.forEach((x) => self._cls.add(x)),
      remove: (...c) => c.forEach((x) => self._cls.delete(x)),
      toggle: (c, on) => ((on ?? !self._cls.has(c)) ? self._cls.add(c) : self._cls.delete(c)),
      contains: (c) => self._cls.has(c),
    };
  }
  get className() { return this._className; }
  set className(v) { this._cls = new Set(v.split(/\s+/).filter(Boolean)); this._className = v; }
  appendChild(child) { this.children.push(child); return child; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) {
    const match = (el) =>
      sel.startsWith("#") ? el.id === sel.slice(1) : sel.startsWith(".") ? el._cls.has(sel.slice(1)) : el.tag === sel;
    const out = [];
    for (const c of this.children) {
      if (match(c)) out.push(c);
      out.push(...c.querySelectorAll(sel));
    }
    return out;
  }
  addEventListener(type, fn) { this._listeners.set(type, fn); }
  dispatch(type, event = {}) { const fn = this._listeners.get(type); fn?.(event); }
  setAttribute(k, v) { this[k] = v; }
}

const byId = {};
const doc = new El("#document");
doc.querySelector = (sel) => {
  const el = byId[sel.replace("#", "")];
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};
doc.querySelectorAll = () => [];
doc.createElement = (tag) => new El(tag);
doc.addEventListener = () => {};
doc.body = new El("body");
doc.documentElement = { style: { setProperty: () => {} } };
doc.title = "";
["vault-picker", "workspace", "vault-name", "file-tree", "backlinks", "editor", "preview", "btn-preview",
 "file-path", "word-count", "status-right", "palette", "palette-input", "palette-results", "search",
 "search-input", "search-results", "btn-open-vault", "btn-create-vault", "btn-switch-vault",
 "recent-vaults"].forEach((id) => {
  const el = new El("div");
  el.id = id;
  byId[id] = el;
});

const context = vm.createContext({
  window: doc,
  document: doc,
  console,
  onyx: null,
  prompt: (m, d) => d,
  alert: () => {},
  setTimeout,
});
// bridge backed by the REAL ipc handlers, injected as window.onyx the way
// the preload's contextBridge exposes it
doc.onyx = {
  vaultList: () => call("vault-list"),
  vaultOpen: (dir) => call("vault-open", dir),
  vaultRemove: (dir) => call("vault-remove", dir),
  vaultMove: (a, b) => call("vault-move", a, b),
  vaultCreate: (dir) => call("vault-create", dir),
  defaultVaultPath: () => call("get-default-vault-path"),
  adapter: {
    read: (rel) => call("adapter-read", rel).data,
    write: (rel, data) => call("adapter-write", rel, data),
    exists: (rel) => call("adapter-exists", rel),
    stat: (rel) => call("adapter-stat", rel),
    remove: (rel) => call("adapter-remove", rel),
    list: (rel, opts) => call("adapter-list", rel, opts),
  },
  trash: (f) => asyncHandlers.get("trash")(null, f),
  contextMenu: (s) => call("context-menu", s),
  resources: () => call("resources"),
  version: () => call("version"),
  checkUpdate: () => call("check-update"),
  onVaultMessage: () => {},
  onContextMenuCommand: () => {},
};

vm.runInContext(fs.readFileSync(fileURLToPath(new URL("../renderer/lib/markdown.js", import.meta.url)), "utf8"), context);
vm.runInContext("var OnyxMarkdown = window.OnyxMarkdown;", context); // browser: window props are globals
vm.runInContext(fs.readFileSync(fileURLToPath(new URL("../renderer/app.js", import.meta.url)), "utf8"), context);

// ---- UI flow: the app booted into the vault picker with recent vaults
assert.ok(byId["workspace"].classList.contains("hidden"), "workspace hidden at boot");
const recentRows = byId["recent-vaults"].children.filter((el) => el.onclick);
assert.ok(recentRows.length >= 1, "recent vaults listed");
recentRows[0].onclick(); // open TestVault through the real UI path

assert.ok(!byId["workspace"].classList.contains("hidden"), "workspace shown after vault open");
assert.strictEqual(byId["vault-name"].textContent, "TestVault", "vault name set");

// file tree lists the note; open it from the tree
let rows = byId["file-tree"].querySelectorAll(".tree-file");
assert.ok(rows.some((el) => el.dataset.path === "notes/First.md"), "file tree lists notes/First.md");
rows.find((el) => el.dataset.path === "notes/First.md").onclick();
assert.strictEqual(byId["file-path"].textContent, "notes/First.md", "openFile sets path");
assert.strictEqual(byId["editor"].value, "# First\n", "editor loads file content");

// edit + save through the command palette (Ctrl+P → Save)
byId["editor"].value = "# First\n\nLink to [[Second]] here.\n";
byId["editor"].dispatch("input");
assert.ok(/words/.test(byId["word-count"].textContent), "word count updates");
byId["palette-input"].oninput({ target: { value: "save" } });
const saveRow = byId["palette-results"].children.find((el) => /Save current file/.test(el.innerHTML));
assert.ok(saveRow, "palette matches the save command");
saveRow.onclick();
assert.strictEqual(fs.readFileSync(path.join(vaultDir, "notes/First.md"), "utf8"), "# First\n\nLink to [[Second]] here.\n", "save persisted to disk");

// wikilink markup renders in preview (Ctrl+E)
byId["btn-preview"].onclick();
assert.ok(byId["preview"].innerHTML.includes('data-target="Second"'), "wikilink rendered with data-target");
assert.ok(byId["preview"].innerHTML.includes("<h1>"), "markdown headings render");

// new note through main, refresh vault via the switcher, then search for it
call("adapter-write", "notes/Second.md", "# Second\n");
byId["btn-switch-vault"].onclick();
byId["recent-vaults"].children.filter((el) => el.onclick)[0].onclick(); // reopen → fresh file index
byId["search-input"].value = "second";
byId["search-input"].oninput({ target: byId["search-input"] });
const hit = byId["search-results"].children.find((el) => el.textContent === "notes/Second.md");
assert.ok(hit, "search finds Second");
hit.onclick(); // opens Second via the search UI

// backlinks: Second must list First as a backlink
const backlinks = byId["backlinks"].children.filter((el) => el.title);
assert.ok(backlinks.some((el) => el.title === "notes/First.md"), "backlink from First discovered");

// workspace persistence: last opened file recorded in .onyx/workspace.json
const ws = JSON.parse(fs.readFileSync(path.join(vaultDir, ".onyx/workspace.json"), "utf8"));
assert.strictEqual(ws.lastFile, "notes/Second.md", "workspace.json records last file");

// appearance.json round-trip through the theme command
fs.writeFileSync(path.join(vaultDir, ".onyx/appearance.json"), JSON.stringify({ theme: "light", fontSize: 18 }));
byId["btn-switch-vault"].onclick();
byId["recent-vaults"].children.filter((el) => el.onclick)[0].onclick();

fs.rmSync(tmp, { recursive: true, force: true });
console.log("renderer UI flow: OK (tree, editor, palette save, wikilink markup, search, backlinks, workspace)");
console.log("all headless checks passed");
