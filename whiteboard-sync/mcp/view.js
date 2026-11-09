// MCP App view: shows the frame (or image) a tool returned right in the chat,
// in hosts that render MCP Apps (claude.ai, Claude desktop). Without it the
// rendered picture only reaches the model, never the person.
//
// The page is self-contained: the MCP Apps client (@modelcontextprotocol/ext-apps,
// installed with `npm install` next to server.js) is inlined, so the host's
// default sandbox (inline scripts, data: images, no network) is all it needs.
const fs = require("fs");

const VIEW_URI = "ui://whiteboard/frame-view.html";
const MIME_TYPE = "text/html;profile=mcp-app";

// app-with-deps.js is one ES module ending in `export{a as App,...}`. Inline
// scripts can't import from each other, so turn that export into a global.
function loadClientBundle() {
  const file = require.resolve("@modelcontextprotocol/ext-apps/app-with-deps");
  const src = fs.readFileSync(file, "utf8");
  const m = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(src);
  if (!m || /\bimport\s*[{*\s"']/.test(src.slice(0, 200)) || src.includes("</script")) {
    throw new Error("unexpected format of @modelcontextprotocol/ext-apps/app-with-deps");
  }
  const names = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [local, exported = local] = s.split(/\s+as\s+/);
      return `${JSON.stringify(exported)}:${local}`;
    });
  // modules are strict; keep it that way inside the wrapper
  return `(function(){"use strict";\n${src.slice(0, m.index)}\nwindow.McpApps={${names.join(",")}};})();`;
}

const VIEW_SCRIPT = String.raw`
(function () {
  var M = window.McpApps;
  var app = new M.App({ name: "Whiteboard view", version: "1.0.0" }, {}, { autoResize: true });
  var $ = function (id) { return document.getElementById(id); };
  var lastArgs = null;
  var link = null;

  function status(text) {
    $("status").textContent = text;
    $("status").hidden = !text;
  }

  function applyContext(ctx) {
    if (!ctx) return;
    if (ctx.theme && M.applyDocumentTheme) M.applyDocumentTheme(ctx.theme);
    if (ctx.styles && ctx.styles.variables && M.applyHostStyleVariables) M.applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles && ctx.styles.css && ctx.styles.css.fonts && M.applyHostFonts) M.applyHostFonts(ctx.styles.css.fonts);
  }

  function imgEl(image, alt) {
    var img = document.createElement("img");
    img.alt = alt;
    img.src = "data:" + image.mimeType + ";base64," + image.data;
    return img;
  }

  function draw(title, images) {
    $("title").textContent = title || "Whiteboard";
    $("open").hidden = !link;
    var main = $("main");
    var thumbs = $("thumbs");
    main.replaceChildren();
    thumbs.replaceChildren();
    if (!images.length) {
      status("No picture came with this result.");
      return;
    }
    status("");
    main.append(imgEl(images[0], title || "Whiteboard frame"));
    images.slice(1).forEach(function (image, i) {
      thumbs.append(imgEl(image, "Image " + (i + 1)));
    });
    thumbs.hidden = images.length < 2;
  }

  function show(result) {
    var content = (result && result.content) || [];
    var text = content.filter(function (c) { return c.type === "text"; }).map(function (c) { return c.text; }).join("\n");
    if (result && result.isError) {
      $("title").textContent = "Whiteboard";
      $("main").replaceChildren();
      $("thumbs").hidden = true;
      status(text || "Something went wrong.");
      return;
    }
    var t = /^# (.+)$/m.exec(text);
    var l = /^- Link: (https?:\/\/\S+)$/m.exec(text);
    link = l ? l[1] : null;
    var title = t ? t[1] : lastArgs && lastArgs.file_id ? "Image" : "Whiteboard";
    var images = content.filter(function (c) { return c.type === "image" && c.data; });
    // drawing tools also put their picture in structuredContent
    var sc = (result && result.structuredContent) || {};
    if (!images.length && sc.images && sc.images.length) images = sc.images;
    if (images.length || !lastArgs) return draw(title, images);

    // the host passed the result on without its images: ask the server for them
    status("Loading picture…");
    app.callServerTool({ name: "view_images", arguments: lastArgs }).then(
      function (r) {
        var sc = (r && r.structuredContent) || {};
        draw(title, sc.images || []);
      },
      function () { draw(title, []); },
    );
  }

  app.ontoolinput = function (p) {
    lastArgs = (p && p.arguments) || null;
    status("Loading…");
  };
  app.ontoolresult = show;
  app.ontoolcancelled = function () { status("Cancelled."); };
  app.onhostcontextchanged = applyContext;
  $("open").onclick = function () {
    if (link) app.openLink({ url: link });
  };
  app.connect().then(function () { applyContext(app.getHostContext()); }, function (e) {
    status("Couldn't connect to the chat: " + (e && e.message));
  });
})();
`;

const VIEW_HTML = (bundle) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Whiteboard</title>
<style>
  :root {
    --fg: var(--color-text-primary, #1f1f1f);
    --muted: var(--color-text-secondary, #6b6b6b);
    --line: var(--color-border-primary, #8884);
    --accent: #6965db;
    color-scheme: light dark;
  }
  :root[data-theme="dark"] { --fg: var(--color-text-primary, #ececec); --muted: var(--color-text-secondary, #a3a3a3); }
  body { margin: 0; padding: 12px; font: 14px/1.4 var(--font-sans, system-ui, sans-serif); color: var(--fg); background: transparent; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
  #title { flex: 1; min-width: 0; margin: 0; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #open { flex: none; font: inherit; font-size: 13px; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
  #open:hover { border-color: var(--accent); color: var(--accent); }
  #status { margin: 0 0 8px; color: var(--muted); white-space: pre-line; }
  #main img { display: block; width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--line); background: #fff; }
  #thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; margin-top: 8px; }
  #thumbs img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); background: #fff; }
</style></head>
<body>
<header><h1 id="title">Whiteboard</h1><button id="open" type="button" hidden>Open in whiteboard</button></header>
<p id="status">Loading…</p>
<div id="main"></div>
<div id="thumbs" hidden></div>
<script>${bundle}</script>
<script>${VIEW_SCRIPT}</script>
</body></html>`;

// -> { uri, mimeType, html } or null when the MCP Apps package isn't installed
function createView() {
  try {
    return { uri: VIEW_URI, mimeType: MIME_TYPE, html: VIEW_HTML(loadClientBundle()) };
  } catch (e) {
    console.warn(`Claude connector: no in-chat view (${e.message.split("\n")[0]}); run npm install in whiteboard-sync`);
    return null;
  }
}

module.exports = { createView, VIEW_URI, MIME_TYPE };
