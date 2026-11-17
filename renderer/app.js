/**
 * Onyx renderer application.
 *
 * Reconstructed behavior (evidence in README.md):
 *   - vault roster + most-recently-used ordering (original ipc: vault-list/vault-open)
 *   - per-vault config dir ".onyx" holding appearance.json, app.json,
 *     workspace.json (original: .obsidian/)
 *   - file tree lists all non-hidden files (original skips dotfolders)
 *   - wiki links [[Note]] resolved inside the vault, with a backlinks pane
 *     (original core features: wikilink + backlinks)
 *   - command palette on Ctrl+P (original core plugin: command-palette)
 *   - fuzzy note search on Ctrl+Shift+F (original core plugin: search)
 *   - preview toggle on Ctrl+E (original hotkey)
 */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const api = window.onyx;

  let vault = null; // { path, name }
  let files = []; // [{ path, type }]
  let currentFile = null;
  let previewOn = false;
  let dirty = false;

  // ------------------------------------------------------------ per-vault config

  const configPath = (name) => ".onyx/" + name;
  // Paths handed to the adapter are vault-relative; ".onyx" mirrors the
  // original's dotfolder (original name: ".obsidian").

  const readConfig = (name, fallback) => {
    const raw = api.adapter.read(configPath(name));
    try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
  };

  const writeConfig = (name, value) => api.adapter.write(configPath(name), JSON.stringify(value, null, 2));

  const saveWorkspace = () => {
    if (!vault) return;
    const ws = readConfig("workspace.json", {});
    ws.lastFile = currentFile;
    writeConfig("workspace.json", ws);
  };

  const applyAppearance = () => {
    const appearance = readConfig("appearance.json", { theme: "dark", fontSize: 16 });
    document.body.classList.toggle("theme-light", appearance.theme === "light");
    document.body.classList.toggle("theme-dark", appearance.theme !== "light");
    document.documentElement.style.setProperty("--editor-font-size", `${appearance.fontSize}px`);
  };

  // ------------------------------------------------------------------ vault flow

  const refreshFileTree = () => {
    files = api.adapter.list("", { recursive: true }).filter((f) => f.type === "file");
    renderFileTree();
  };

  const openVault = (dir) => {
    vault = api.vaultOpen(dir);
    if (!vault) { alert("Could not open that folder."); return; }
    applyAppearance();
    $("#vault-picker").classList.add("hidden");
    $("#workspace").classList.remove("hidden");
    $("#vault-name").textContent = vault.name;
    document.title = `${vault.name} — Onyx`;
    refreshFileTree();
    const ws = readConfig("workspace.json", {});
    if (ws.lastFile && api.adapter.exists(ws.lastFile)) openFile(ws.lastFile);
    else if (files.length) openFile(files[0].path);
    else api.adapter.write("Untitled.md", "# Untitled\n");
    refreshFileTree();
  };

  const showVaultPicker = () => {
    $("#workspace").classList.add("hidden");
    const picker = $("#vault-picker");
    picker.classList.remove("hidden");
    const recent = api.vaultList().sort((a, b) => b.ts - a.ts).slice(0, 8);
    const host = $("#recent-vaults");
    host.innerHTML = recent.length ? "<h3>Recent vaults</h3>" : "";
    for (const v of recent) {
      const row = document.createElement("button");
      row.className = "recent-vault";
      row.textContent = v.name;
      row.title = v.path;
      row.onclick = () => openVault(v.path);
      host.appendChild(row);
    }
  };

  // ------------------------------------------------------------------ file tree

  const renderFileTree = () => {
    const tree = $("#file-tree");
    tree.innerHTML = "";
    const folders = new Map([["", tree]]);

    for (const entry of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = entry.path.split("/");
      const name = parts.pop();
      let parent = folders.get(parts.join("/")) ?? null;
      if (parts.length) {
        const folderPath = parts.join("/");
        for (let i = 0; i <= parts.length; i++) {
          const key = parts.slice(0, i).join("/");
          if (!folders.has(key)) {
            const div = document.createElement("div");
            div.className = "tree-folder";
            div.innerHTML = `<span class="tree-folder-name">${OnyxMarkdown.escapeHtml(key.split("/").pop())}</span>`;
            folders.set(key, div);
            const grandparent = folders.get(parts.slice(0, i - 1).join("/")) ?? tree;
            grandparent.appendChild(div);
          }
        }
        parent = folders.get(folderPath);
      }
      const row = document.createElement("div");
      row.className = "tree-file";
      row.textContent = name.replace(/\.md$/, "");
      row.title = entry.path;
      row.dataset.path = entry.path;
      row.onclick = () => openFile(entry.path);
      (parent ?? tree).appendChild(row);
    }
    highlightCurrent();
  };

  const highlightCurrent = () => {
    document.querySelectorAll(".tree-file").forEach((el) =>
      el.classList.toggle("active", el.dataset.path === currentFile));
  };

  // ------------------------------------------------------------------- file I/O

  const openFile = (filePath) => {
    if (dirty) saveFile();
    currentFile = filePath;
    $("#editor").value = api.adapter.read(filePath) ?? "";
    $("#file-path").textContent = filePath;
    dirty = false;
    highlightCurrent();
    renderPreviewIfOn();
    renderBacklinks();
    saveWorkspace();
  };

  const saveFile = () => {
    if (!currentFile) return;
    api.adapter.write(currentFile, $("#editor").value);
    dirty = false;
    $("#status-right").textContent = "saved";
    renderBacklinks();
  };

  // ------------------------------------------------------------------- preview

  const renderPreviewIfOn = () => {
    if (!previewOn) return;
    $("#preview").innerHTML = OnyxMarkdown.render($("#editor").value);
    $("#preview").querySelectorAll(".wikilink").forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        openWikiTarget(a.dataset.target);
      }));
  };

  const openWikiTarget = (target) => {
    const candidates = [
      `${target}.md`,
      ...files.filter((f) => f.path.replace(/\.md$/, "").endsWith(target)).map((f) => f.path),
    ];
    const hit = candidates.find((p) => api.adapter.exists(p));
    if (hit) openFile(hit);
    else { // create the note on demand, like the original
      const p = `${target}.md`;
      api.adapter.write(p, `# ${target}\n`);
      refreshFileTree();
      openFile(p);
    }
  };

  // ------------------------------------------------------------------ backlinks

  const renderBacklinks = () => {
    if (!currentFile) return;
    const target = currentFile.replace(/\.md$/, "").split("/").pop();
    const links = [];
    for (const f of files) {
      if (f.path === currentFile) continue;
      const text = api.adapter.read(f.path) ?? "";
      const re = new RegExp(`\\[\\[${target}(?:[\\]|#][^\\]]*)?\\]\\]`, "g");
      if (re.test(text)) links.push(f.path);
    }
    const pane = $("#backlinks");
    pane.innerHTML = links.length ? "<h3>Backlinks</h3>" : "";
    for (const p of links) {
      const row = document.createElement("div");
      row.className = "backlink";
      row.textContent = p.replace(/\.md$/, "").split("/").pop();
      row.title = p;
      row.onclick = () => openFile(p);
      pane.appendChild(row);
    }
  };

  // ----------------------------------------------------------------- commands

  const commands = [
    { id: "file:save", label: "Save current file", hotkey: "Ctrl+S", run: saveFile },
    { id: "view:preview", label: "Toggle preview", hotkey: "Ctrl+E", run: () => togglePreview() },
    { id: "file:new", label: "New note", run: () => { const p = `Untitled ${Date.now()}.md`; api.adapter.write(p, "# Untitled\n"); refreshFileTree(); openFile(p); } },
    { id: "file:delete", label: "Delete current note", run: () => { if (!currentFile) return; api.adapter.remove(currentFile); currentFile = null; refreshFileTree(); $("#editor").value = ""; $("#file-path").textContent = ""; } },
    { id: "app:search", label: "Search notes", hotkey: "Ctrl+Shift+F", run: () => $("#search").classList.remove("hidden") },
    { id: "app:vault", label: "Switch vault", run: () => { saveWorkspace(); showVaultPicker(); } },
    { id: "app:appearance", label: "Toggle dark/light theme", run: () => { const a = readConfig("appearance.json", {}); a.theme = a.theme === "light" ? "dark" : "light"; writeConfig("appearance.json", a); applyAppearance(); } },
  ];

  const togglePreview = () => {
    previewOn = !previewOn;
    $("#preview").classList.toggle("hidden", !previewOn);
    $("#editor").classList.toggle("hidden", previewOn);
    $("#btn-preview").textContent = previewOn ? "Edit" : "Preview";
    renderPreviewIfOn();
  };

  const openPalette = () => {
    const pal = $("#palette");
    pal.classList.remove("hidden");
    const input = $("#palette-input");
    input.value = "";
    renderPalette("");
    input.focus();
  };

  const renderPalette = (query) => {
    const results = $("#palette-results");
    results.innerHTML = "";
    const q = query.toLowerCase();
    for (const cmd of commands.filter((c) => c.label.toLowerCase().includes(q))) {
      const li = document.createElement("li");
      li.innerHTML = `${OnyxMarkdown.escapeHtml(cmd.label)}${cmd.hotkey ? `<span class="hotkey">${cmd.hotkey}</span>` : ""}`;
      li.onclick = () => { $("#palette").classList.add("hidden"); cmd.run(); };
      results.appendChild(li);
    }
  };

  // ------------------------------------------------------------------- search

  const runSearch = () => {
    const q = $("#search-input").value.toLowerCase();
    const results = $("#search-results");
    results.innerHTML = "";
    if (q.length < 2) return;
    for (const f of files) {
      const text = (api.adapter.read(f.path) ?? "").toLowerCase();
      if (text.includes(q)) {
        const li = document.createElement("li");
        li.textContent = f.path;
        li.onclick = () => { $("#search").classList.add("hidden"); openFile(f.path); };
        results.appendChild(li);
      }
    }
  };

  // -------------------------------------------------------------------- wiring

  $("#btn-open-vault").onclick = async () => {
    const dir = prompt("Folder to open as vault:", api.defaultVaultPath());
    if (dir) openVault(dir);
  };

  $("#btn-create-vault").onclick = () => {
    const dir = prompt("New vault folder:", api.defaultVaultPath() + "/MyVault");
    if (!dir) return;
    if (api.vaultCreate(dir)) openVault(dir);
  };

  $("#btn-switch-vault").onclick = () => { saveWorkspace(); showVaultPicker(); };
  $("#btn-preview").onclick = togglePreview;
  $("#palette-input").oninput = (e) => renderPalette(e.target.value);
  $("#search-input").oninput = runSearch;

  $("#editor").addEventListener("input", () => {
    dirty = true;
    const words = $("#editor").value.trim() ? $("#editor").value.trim().split(/\s+/).length : 0;
    $("#word-count").textContent = `${words} words`;
  });

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === "s") { e.preventDefault(); saveFile(); }
    if (mod && e.key === "e") { e.preventDefault(); togglePreview(); }
    if (mod && e.key === "p" && !e.shiftKey) { e.preventDefault(); openPalette(); }
    if (mod && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); $("#search").classList.remove("hidden"); $("#search-input").focus(); }
    if (e.key === "Escape") { $("#palette").classList.add("hidden"); $("#search").classList.add("hidden"); }
  });

  // first paint: pick a vault (the original shows its starter window first)
  showVaultPicker();
})();
