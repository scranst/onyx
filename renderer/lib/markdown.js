/**
 * Onyx markdown renderer — compact CommonMark subset plus the Obsidian-style
 * extensions the original bundles (wikilinks, callouts-as-quotes, task lists).
 * The original app (app.js, 3.4 MB) embeds full CommonMark + plugins; Onyx
 * keeps a readable subset for the reconstruction.
 */
(function (global) {
  "use strict";

  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // [[Note]] and [[Note|alias]] → <a data-wikilink>
  const renderWikiLinks = (text) =>
    text.replace(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g, (_m, target, _anchor, alias) => {
      const label = alias || target;
      return `<a href="#" class="wikilink" data-target="${escapeHtml(target.trim())}">${escapeHtml(label)}</a>`;
    });

  const inline = (s) =>
    renderWikiLinks(
      escapeHtml(s)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/(^|\W)_([^_]+)_/g, "$1<em>$2</em>")
        .replace(/~~([^~]+)~~/g, "<del>$1</del>")
        .replace(/==([^=]+)==/g, "<mark>$1</mark>")
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    );

  const render = (markdown) => {
    const lines = markdown.split("\n");
    const out = [];
    let inCode = false;
    let listType = null; // "ul" | "ol"
    let inQuote = false;

    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
    const closeQuote = () => { if (inQuote) { out.push("</blockquote>"); inQuote = false; } };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^```/.test(line)) { // code block fence
        if (inCode) { out.push("</code></pre>"); inCode = false; }
        else { closeList(); closeQuote(); out.push('<pre><code>'); inCode = true; }
        continue;
      }
      if (inCode) { out.push(escapeHtml(line)); continue; }

      if (!line.trim()) { closeList(); closeQuote(); continue; }

      const heading = line.match(/^(#{1,6})\s+(.*)/);
      if (heading) {
        closeList(); closeQuote();
        const level = heading[1].length;
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }

      // callout (original bundles callouts as themed blockquotes): > [!note] …
      const callout = line.match(/^>\s+\[!(\w+)\]\s*(.*)/);
      if (callout) {
        closeList();
        if (!inQuote) { out.push('<blockquote class="callout">'); inQuote = true; }
        out.push(`<p><strong>${escapeHtml(callout[1])}</strong> ${inline(callout[2])}</p>`);
        continue;
      }

      if (/^>\s?/.test(line)) {
        closeList();
        if (!inQuote) { out.push("<blockquote>"); inQuote = true; }
        out.push(`<p>${inline(line.replace(/^>\s?/, ""))}</p>`);
        continue;
      }
      closeQuote();

      const hr = /^\s*(-{3,}|\*{3,})\s*$/.test(line);
      if (hr) { closeList(); out.push("<hr>"); continue; }

      const task = line.match(/^[-*]\s+\[( |x|X)\]\s+(.*)/);
      if (task) {
        if (listType !== "ul") { closeList(); out.push('<ul class="task-list">'); listType = "ul"; }
        const done = task[1].toLowerCase() === "x";
        out.push(`<li><input type="checkbox" disabled${done ? " checked" : ""}> ${inline(task[2])}</li>`);
        continue;
      }

      const ul = line.match(/^[-*]\s+(.*)/);
      if (ul) {
        if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
        out.push(`<li>${inline(ul[1])}</li>`);
        continue;
      }

      const ol = line.match(/^\d+\.\s+(.*)/);
      if (ol) {
        if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
        out.push(`<li>${inline(ol[1])}</li>`);
        continue;
      }

      if (/^---+$/.test(line)) continue; // front matter separator, kept simple
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
    closeList(); closeQuote();
    if (inCode) out.push("</code></pre>");
    return out.join("\n");
  };

  global.OnyxMarkdown = { render, escapeHtml };
})(window);
