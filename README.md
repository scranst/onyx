# Onyx

A local-first markdown notebook for Electron — **reconstructed from Obsidian
1.15.1** using [REA (morluto/rea)](https://github.com/morluto/rea) and direct
inspection of the app bundle.

Onyx is a clean-room implementation: it reproduces Obsidian's *architecture and
behavior* (vault model, IPC surface, config layout, editor flow), not its code.
No Obsidian source or assets are included.

## Run it

```sh
npm install
npm start          # opens the vault picker
```

Headless smoke test (no display needed):

```sh
npm test           # drives the real IPC handlers and the UI flow in Node
```

## How Obsidian was reverse engineered

1. **Audited REA first** — the tool itself was scanned for telemetry, beaconing
   and backdoors before use. Findings: no analytics services, no `sendBeacon`
   in runtime code (only analysis *of* target apps that use it), no hardcoded
   external IPs (only `127.0.0.1` for local MCP transports). Its only outbound
   calls are the npm registry (update check), GitHub's API (release resolution
   in `install.sh`), and user-configured endpoints.
2. **Grabbed the app bundle** — Obsidian publishes the renderer bundle as
   `obsidian-1.15.1.asar.gz` alongside the platform installers.
3. **Ran REA** — `rea analyze-javascript-application obsidian.asar --json`
   (static analysis; the app is never executed).
4. **Read the extracted sources** (`main.js`, `app.js`, `package.json`) to
   confirm the IPC channels, window options, config layout and core features.

### What the analysis recovered (Obsidian 1.15.1)

| Fact | Evidence (from `app.asar`) |
| --- | --- |
| Electron renderer with full Node access: `webPreferences { contextIsolation: false, nodeIntegration: true, webviewTag: true, spellcheck: true }` | `main.js`, three BrowserWindow configs |
| Default window 800×600, background `#1e1e1e` | `main.js` window options |
| Custom `app://` file protocol serving vault content | `protocol.registerFileProtocol("app")`, `protocol.handle("app")` |
| Vault roster persisted as JSON in userData (`obsidian.json`, shape `{ vaults: { [path]: { ts, name } } }`) | `main.js` vault handlers |
| Vault config lives in a dotfolder (`.obsidian/`) with `appearance.json`, `app.json`, `core-plugins.json`, `hotkeys.json`, `workspace.json` | `app.js` references |
| IPC surface: `vault-list`, `vault-open`, `vault-move`, `vault-remove`, `vault-message`, `get-default-vault-path`, `get-sandbox-vault-path`, `trash`, `resources`, `set-menu`, `render-menu`, `context-menu`, `check-update`, `update`, `startup-snapshot`, `print-to-pdf`, `relaunch`, `file-url`, `open-url`, `open-file`, `policy`, `terms`, `help`, … | `ipcMain` registrations in `main.js` |
| Renderer talks through `electron.ipcRenderer` (synchronous channels) — 68 references | `app.js` |
| Filesystem access through an *adapter* object: `read`, `write`, `exists`, `stat`, `remove`, `writeBinary`, `trashSystem`, `save` | `app.js` |
| Core plugins include `search` and `command-palette`; backlinks (`Backlinks`, `BacklinkCollapsed`, `BacklinksInDocument`) are core features | `app.js` |
| Editor stack: CodeMirror (`lib/codemirror/…`) with modes + vim; rendering libs: Prism, MathJax (`obsidian-mathjax.js`), pdf.js, pixi.js, moment, defuddle, turndown, reveal.js | asar file listing |
| Fonts: Inter (UI), Source Code Pro (mono) | `public/` in the asar |
| Starter/help vault ships as markdown (`sandbox/` guides, `starter.html`/`starter.js`) | asar file listing |

### What REA's completed analysis recovered

The completed run analyzed the app's own eight bundles (`main.js`, `app.js`,
`starter.js`, `help.js`, `quicklook.js`, `worker.js`, `app.css`,
`package.json`); its full JSON Evidence is preserved at
`evidence/rea-javascript-application.json.gz` (regenerate with
`rea analyze-javascript-application <dir> --json`).

| REA statistic | Value |
| --- | --- |
| Parsed JavaScript files | 6 (0 parse failures, 7 relevant files) |
| AST nodes visited | 1,294,975 |
| Findings | 419 |
| Literal IPC channels → main handlers | **53 → 53** (0 dynamic, 0 unpaired) |
| Native addon bindings | 0 (pure-JS app) |
| Utility processes / web routes | 0 (single-window SPA) |
| Semantic graph | 100,000 nodes, 63,705 relations, 37 boundaries, 127 events, 133 listeners |
| Unknowns flagged for follow-up | 83,747 (conservative semantic-precision budget) |

The first attempt over the whole asar hit REA's default 300 s per-source
deadline on a 460 KB emscripten `pdf.js` wasm fallback
(`provider_timeout`, `retryable: true`); trimming the third-party `lib/`
bundles (the remediation REA suggested for that failure) let the same
operation complete. Notably, the original's minified window classes
(`new Ke(...)` extending `BrowserWindow`) are why window/preload detection in
the summary reads zero — the IPC, adapter and config evidence above came from
cross-checking the extracted `main.js`/`app.js` directly.

## Architecture mapping

| Obsidian | Onyx | Notes |
| --- | --- | --- |
| `main.js` (Electron main) | `main.js` | window options, vault roster, IPC, `app://` protocol |
| `obsidian.json` in userData | `onyx-vaults.json` in userData | same `{ vaults: { [path]: { ts, name } } }` shape |
| `.obsidian/` config dir | `.onyx/` config dir | `appearance.json`, `app.json`, `workspace.json` implemented; `core-plugins.json`, `hotkeys.json` reserved |
| `adapter.*` API | `window.onyx.adapter.*` | read/write/exists/stat/remove/list, vault-relative paths |
| `ipcRenderer.sendSync` channels | same channel names via preload bridge | `vault-list`, `vault-open`, `vault-move`, `vault-remove`, `vault-create`*, `trash`, `resources`, `check-update`, … |
| CodeMirror editor | plain `<textarea>` + bundled renderer | divergence: keeps Onyx dependency-free |
| CommonMark + plugins pipeline | `renderer/lib/markdown.js` | CommonMark subset + wikilinks, callouts (`> [!tip]`), task lists, `==highlight==` |
| `app://` protocol | `onyx://` protocol | serves vault files to the renderer |
| Plugin API (contextIsolation off) | `window.onyx` bridge (contextIsolation on) | divergence: safer default, same plugin contract |

\* `vault-create` is an Onyx addition (the original's wizard runs elsewhere).

## Features reconstructed

- Vault model: pick a folder, vault roster with most-recently-used ordering,
  remove-from-roster without deleting files (`vault-remove` semantics)
- File tree of all non-hidden files, nested folders
- Markdown editor with preview (`Ctrl+E`), word count, per-note save (`Ctrl+S`)
- Wiki links `[[Note]]` / `[[Note|alias]]`, creating missing notes on demand
- Backlinks pane (scan vault for links to the current note)
- Command palette (`Ctrl+P`) and vault-wide search (`Ctrl+Shift+F`)
- Per-vault settings: dark/light theme (`appearance.json`), last-opened file
  (`workspace.json`)
- Dark theme matching the original's `#1e1e1e` window background and
  Inter / Source Code Pro font stack

## Layout

```
onyx/
├── main.js              # Electron main process (vault lifecycle + IPC + protocol)
├── preload.js           # contextBridge → window.onyx
├── renderer/
│   ├── index.html
│   ├── app.js           # workspace, file tree, editor, palette, search, backlinks
│   ├── app.css          # theme (#1e1e1e dark, light variant)
│   └── lib/markdown.js  # markdown renderer (wikilinks, callouts, tasks)
├── sample-vault/        # example vault to open on first run
└── tests/harness.mjs    # headless end-to-end test (real handlers, DOM shim)
```

## License

MIT. Obsidian is a trademark of Obsidian.tools; this project is not affiliated
with or endorsed by it.
