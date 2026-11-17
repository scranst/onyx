/**
 * Onyx preload bridge.
 *
 * The original (app.asar → main.js webPreferences) runs with
 * contextIsolation:false and nodeIntegration:true so plugins can use Node
 * directly. Onyx keeps the renderer sandboxed and exposes the same
 * synchronous-IPC surface through `window.onyx`, preserving the original's
 * sendSync channel names.
 */
const { contextBridge, ipcRenderer } = require("electron");

const send = (channel, ...args) => ipcRenderer.sendSync(channel, ...args);

contextBridge.exposeInMainWorld("onyx", {
  // vault lifecycle (original channel names: vault-list, vault-open, vault-remove, vault-move)
  vaultList: () => send("vault-list"),
  vaultOpen: (dir) => send("vault-open", dir),
  vaultRemove: (dir) => send("vault-remove", dir),
  vaultMove: (from, to) => send("vault-move", from, to),
  vaultCreate: (dir) => send("vault-create", dir),
  defaultVaultPath: () => send("get-default-vault-path"),

  // vault filesystem (original adapter.* methods)
  adapter: {
    read: (rel) => send("adapter-read", rel)?.data ?? null,
    write: (rel, data) => send("adapter-write", rel, data),
    exists: (rel) => send("adapter-exists", rel),
    stat: (rel) => send("adapter-stat", rel),
    remove: (rel) => send("adapter-remove", rel),
    list: (rel, opts) => send("adapter-list", rel, opts),
  },

  // misc (original channel names)
  trash: (file, askConfirm) => ipcRenderer.invoke("trash", file, askConfirm),
  contextMenu: (spec) => send("context-menu", spec),
  resources: () => send("resources"),
  version: () => send("version"),
  checkUpdate: () => send("check-update"), // quiet by design; no beaconing
  onVaultMessage: (fn) => ipcRenderer.on("vault-message", (_e, msg) => fn(msg)),
  onContextMenuCommand: (fn) => ipcRenderer.on("context-menu-command", (_e, cmd) => fn(cmd)),
});
