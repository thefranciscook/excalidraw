// Tiny storage backend for the self-hosted Excalidraw at whiteboard.supa.company.
// Stores each board as JSON and keeps periodic snapshots. Auth is handled by Caddy,
// except for view-only share links (/s/*, /api/shared/*), which are public.
//
//   GET    /api/boards           list boards (no elements)
//   POST   /api/boards           create a board {name, elements?, appState?, files?} -> {id}
//   GET    /api/boards/:id       full board
//   GET    /api/boards/:id/head  {rev, savedAt, claude?}, cheap to poll for changes;
//                                 claude: {drewAgo?, lookedAgo?} in ms, while Claude is at work there
//   PUT    /api/boards/:id       save scene {elements, appState} -> {rev, board?}
//   PATCH  /api/boards/:id       rename {name}
//   POST   /api/boards/:id/duplicate  copy a board as "<name> (copy)" -> {id, name}
//   DELETE /api/boards/:id       move to data/trash
//
// View-only share links (shares.js). Managing them is behind the site login:
//
//   GET    /api/boards/:id/shares         {shares: [{token, createdAt, expiresAt, expired}], contact, defaultDays, maxDays}
//   POST   /api/boards/:id/shares         new link {days?} (default 30) -> {token, createdAt, expiresAt}
//   DELETE /api/boards/:id/shares/:token  turn a link off
//
// Opening them is public (Caddy lets /s/* and /api/shared/* past its login):
//
//   GET    /s/:token                      the viewer page (render/view.html)
//   GET    /api/shared/:token             {name, elements, appState: {viewBackgroundColor, theme}, rev, expiresAt};
//                                         deleted elements left out.
//                                         410 {status: "expired"|"revoked"|"missing", contact} when it's over
//   GET    /api/shared/:token/head        {rev}, to poll for changes
//   GET    /api/shared/:token/files/:fileId  an image, only if the board shows it
//
// Image files are kept in a private GitHub repo (files/<fileId>.<ext>), not on
// this disk. Needs GITHUB_TOKEN (fine-grained PAT, Contents read/write on that repo).
//
//   GET    /api/files            list stored file ids
//   GET    /api/files/:fileId    {id, mimeType, dataURL, created}
//   PUT    /api/files/:fileId    store {mimeType, dataURL}
//
// Saves are merged per element (scene.js), so browsers and Claude can edit a
// board at the same time. Every save that changes something bumps the board's
// `rev` and is logged with its author in data/journal/<id>.jsonl.
//
// The Claude connector lives in mcp/: /mcp, /oauth/*, /.well-known/*.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { mergeElements, diffElements, clientIsBehind, pruneTombstones, createJournal } = require("./scene");
const { createShares } = require("./shares");

const PORT = Number(process.env.PORT) || 3010;
const DATA_DIR = path.join(__dirname, "data");
const BOARDS_DIR = path.join(DATA_DIR, "boards");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const TRASH_DIR = path.join(DATA_DIR, "trash");
const journal = createJournal(path.join(DATA_DIR, "journal"));
const RENDER_DIR = path.resolve(process.env.WHITEBOARD_RENDER_DIR || "/var/www/excalidraw/render");
// who people whose link expired should ask for a new one, e.g. "Szilard (me@example.com)"
const SHARE_CONTACT = String(process.env.SHARE_CONTACT || "").trim().slice(0, 200);
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const MAX_SNAPSHOTS_PER_BOARD = 200;
const MAX_BODY = 50 * 1024 * 1024;
const ID_RE = /^[a-z0-9]{10}$/;

for (const dir of [BOARDS_DIR, HISTORY_DIR, TRASH_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
const shares = createShares(path.join(DATA_DIR, "shares.json"));

const boardFile = (id) => path.join(BOARDS_DIR, id + ".json");

const readBoard = (id) => {
  try {
    return JSON.parse(fs.readFileSync(boardFile(id), "utf8"));
  } catch {
    return null;
  }
};

const writeBoard = (id, board) => {
  const tmp = boardFile(id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(board));
  fs.renameSync(tmp, boardFile(id));
};

const snapshot = (id, board) => {
  const dir = path.join(HISTORY_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const all = fs.readdirSync(dir).sort();
  const latest = all[all.length - 1];
  if (latest && Date.now() - fs.statSync(path.join(dir, latest)).mtimeMs < SNAPSHOT_INTERVAL_MS) {
    return;
  }
  const name = new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  fs.writeFileSync(path.join(dir, name), JSON.stringify(board));
  all.push(name);
  for (const old of all.slice(0, Math.max(0, all.length - MAX_SNAPSHOTS_PER_BOARD))) {
    fs.unlinkSync(path.join(dir, old));
  }
};

const newId = () => {
  let id;
  do {
    id = Array.from(crypto.randomBytes(10), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  } while (fs.existsSync(boardFile(id)));
  return id;
};

// One-time migration of the single-board layout (data/scene.json).
const legacyScene = path.join(DATA_DIR, "scene.json");
if (fs.existsSync(legacyScene)) {
  const scene = JSON.parse(fs.readFileSync(legacyScene, "utf8"));
  if (scene.elements.length) {
    const id = newId();
    writeBoard(id, { id, name: "My board", createdAt: Date.now(), ...scene });
    console.log(`migrated scene.json to board ${id}`);
  }
  fs.renameSync(legacyScene, path.join(TRASH_DIR, "legacy-scene.json"));
}

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};

const readBody = (req, res, cb) => {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      send(res, 413);
      req.destroy();
    } else {
      chunks.push(c);
    }
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    try {
      cb(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      send(res, 400);
    }
  });
};

const cleanName = (name) => String(name || "").trim().slice(0, 100) || "Untitled board";

const createBoard = ({ name, elements, appState, files }) => {
  const id = newId();
  const now = Date.now();
  // elements/appState/files are set when importing a .excalidraw file
  const imported = Array.isArray(elements);
  const board = {
    id,
    name: cleanName(name),
    createdAt: now,
    savedAt: imported ? now : -1,
    rev: 0,
    elements: imported ? elements : [],
    appState: (imported && appState) || {},
    files: (imported && files) || {},
  };
  writeBoard(id, board);
  return board;
};

// A new board with a copy of `board`'s scene. Deleted elements stay behind,
// and the copy starts its own rev and journal. Images are shared by file id.
const duplicateBoard = (board) =>
  createBoard({
    name: `${board.name} (copy)`,
    elements: (board.elements || []).filter((e) => !e.isDeleted),
    appState: board.appState || {},
    files: board.files || {},
  });

// Merges `elements` into the board and saves it. Synchronous, so two saves
// can't interleave. `author` is "human" (a browser) or "claude" (the connector).
// -> { board, changes, rev } or null when the board doesn't exist
const commit = (id, elements, author, { appState } = {}) => {
  const board = readBoard(id);
  if (!board) return null;
  const merged = mergeElements(board.elements, elements);
  const changes = diffElements(board.elements, merged);
  const nextAppState = appState || board.appState || {};
  const appStateChanged = appState && JSON.stringify(appState) !== JSON.stringify(board.appState || {});
  if (!changes.length && !appStateChanged) return { board, changes, rev: board.rev || 0 };
  const updated = { ...board, elements: changes.length ? pruneTombstones(merged) : merged, appState: nextAppState };
  if (changes.length) {
    updated.rev = (board.rev || 0) + 1;
    updated.savedAt = Date.now();
    journal.append(id, { rev: updated.rev, at: updated.savedAt, author, changes });
  }
  writeBoard(id, updated);
  if (changes.length) snapshot(id, updated);
  return { board: updated, changes, rev: updated.rev || 0 };
};

// When Claude (the connector) last looked at or drew on each board, so open
// tabs can say it's at work there. In memory only: it's about the last minute.
const CLAUDE_ACTIVE_MS = 60 * 1000;
const claudeActivity = new Map(); // board id -> {drewAt?, lookedAt?}
const noteClaudeActivity = (id, what) => {
  const entry = claudeActivity.get(id) || {};
  entry[what === "drawing" ? "drewAt" : "lookedAt"] = Date.now();
  claudeActivity.set(id, entry);
};
// {drewAgo?, lookedAgo?} for the last minute, or undefined. Durations, not
// times, so the browser's clock doesn't have to match the server's.
const claudeActivityOf = (id) => {
  const entry = claudeActivity.get(id);
  if (!entry) return undefined;
  const now = Date.now();
  const out = {};
  if (entry.drewAt && now - entry.drewAt < CLAUDE_ACTIVE_MS) out.drewAgo = now - entry.drewAt;
  if (entry.lookedAt && now - entry.lookedAt < CLAUDE_ACTIVE_MS) out.lookedAgo = now - entry.lookedAt;
  if (!Object.keys(out).length) {
    claudeActivity.delete(id);
    return undefined;
  }
  return out;
};

// --- Image files in GitHub ---

const GITHUB_API = process.env.GITHUB_API || "https://api.github.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || "thefranciscook/whiteboard-images";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
// Excalidraw file ids are SHA-1 hex (or a 40-char nanoid fallback)
const FILE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MIME_EXT = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
  "image/avif": "avif",
  "image/jfif": "jpg",
};
const EXT_MIME = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif" };
const INDEX_REFRESH_MS = 60 * 1000;

// Time limit per GitHub request: uploads run one at a time, so a request that
// never finishes would hold up every upload after it.
const GITHUB_TIMEOUT_MS = 120 * 1000;

const github = (apiPath, opts = {}) =>
  fetch(`${GITHUB_API}/repos/${GITHUB_REPO}${apiPath}`, {
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    ...opts,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "whiteboard-sync",
      Accept: "application/vnd.github+json",
      ...opts.headers,
    },
  });

// fileId -> path in the repo, read from the repo tree
const fileIndex = new Map();
let indexLoadedAt = 0;
let indexLoading = null;
const loadIndex = () => {
  if (indexLoading) return indexLoading;
  indexLoading = github(`/git/trees/${GITHUB_BRANCH}?recursive=1`)
    .then(async (res) => {
      // 404/409: branch doesn't exist yet (empty repo)
      if (res.status === 404 || res.status === 409) return;
      if (!res.ok) throw new Error(`tree ${res.status}`);
      const { tree, truncated } = await res.json();
      if (truncated) console.warn("file index truncated by GitHub");
      for (const entry of tree) {
        const m = entry.type === "blob" && entry.path.match(/^files\/([^/.]+)\.(\w+)$/);
        if (m) fileIndex.set(m[1], entry.path);
      }
      indexLoadedAt = Date.now();
    })
    .catch((e) => console.error("couldn't load file index:", e.message))
    .finally(() => {
      indexLoading = null;
    });
  return indexLoading;
};

// look up a file, refreshing the index on a miss (at most once a minute)
const findFile = async (id) => {
  if (!fileIndex.has(id) && Date.now() - indexLoadedAt > INDEX_REFRESH_MS) await loadIndex();
  return fileIndex.get(id);
};

// Commits on one branch must happen one at a time, or GitHub answers 409.
let uploadQueue = Promise.resolve();
const queueUpload = (task) => {
  const run = uploadQueue.then(task, task);
  uploadQueue = run.catch(() => {});
  return run;
};

const uploadFile = (id, mimeType, base64) =>
  queueUpload(async () => {
    if (fileIndex.has(id)) return;
    const filePath = `files/${id}.${MIME_EXT[mimeType]}`;
    const res = await github(`/contents/${filePath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Add ${filePath}`, content: base64, branch: GITHUB_BRANCH }),
    });
    // 422 is returned when the path already exists
    if (!res.ok && res.status !== 422) throw new Error(`upload ${res.status}: ${await res.text()}`);
    if (res.status === 422) {
      const check = await github(`/contents/${filePath}?ref=${GITHUB_BRANCH}`, { method: "HEAD" });
      if (!check.ok) throw new Error(`upload 422, file not found`);
    }
    fileIndex.set(id, filePath);
  });

// {id, mimeType, dataURL, created}, or null when there's no such file
const getFile = async (id) => {
  if (!GITHUB_TOKEN || !FILE_ID_RE.test(id)) return null;
  const filePath = await findFile(id);
  if (!filePath) return null;
  const gh = await github(`/contents/${filePath}?ref=${GITHUB_BRANCH}`, {
    headers: { Accept: "application/vnd.github.raw+json" },
  });
  if (gh.status === 404) {
    fileIndex.delete(id);
    return null;
  }
  if (!gh.ok) throw new Error(`download ${gh.status}`);
  const mimeType = EXT_MIME[filePath.split(".").pop()] || "application/octet-stream";
  const dataURL = `data:${mimeType};base64,${Buffer.from(await gh.arrayBuffer()).toString("base64")}`;
  return { id, mimeType, dataURL, created: Date.now() };
};

const handleFiles = async (req, res, id) => {
  if (!GITHUB_TOKEN) return send(res, 503);
  if (!id) {
    if (req.method !== "GET") return send(res, 405);
    if (!indexLoadedAt) await loadIndex();
    return send(res, 200, [...fileIndex.keys()]);
  }
  if (!FILE_ID_RE.test(id)) return send(res, 400);

  if (req.method === "GET") {
    const file = await getFile(id);
    if (!file) return send(res, 404);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "private, max-age=31536000, immutable" });
    return res.end(JSON.stringify(file));
  }

  if (req.method === "PUT") {
    return readBody(req, res, (file) => {
      const m = typeof file.dataURL === "string" && file.dataURL.match(/^data:([^;,]+);base64,(.+)$/s);
      const mimeType = m && m[1];
      if (!m || !Object.hasOwn(MIME_EXT, mimeType)) return send(res, 400);
      uploadFile(id, mimeType, m[2]).then(
        () => send(res, 204),
        (e) => {
          console.error(`couldn't store file ${id}:`, e.message);
          send(res, 502);
        },
      );
    });
  }

  send(res, 405);
};

if (GITHUB_TOKEN) loadIndex();
else console.warn("GITHUB_TOKEN not set: image storage (/api/files) is disabled");

// --- View-only share links, open to anyone with the link ---

// Not for search engines, and the link isn't passed on to sites the board links to.
const PUBLIC_HEADERS = { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

const sendPublic = (res, status, body, cache = "no-store") => {
  res.writeHead(status, { ...PUBLIC_HEADERS, "Content-Type": "application/json", "Cache-Control": cache });
  res.end(JSON.stringify(body));
};

// the viewer page; it reads the token from the address and loads the board itself
const handleSharePage = (req, res, token) => {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405);
  let html;
  try {
    html = fs.readFileSync(path.join(RENDER_DIR, "view.html"));
  } catch {
    console.error(`share page: ${path.join(RENDER_DIR, "view.html")} is missing (run rebuild.sh)`);
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("The board viewer isn't installed on this server yet.");
  }
  res.writeHead(shares.TOKEN_RE.test(token) ? 200 : 404, {
    ...PUBLIC_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : html);
};

const showsFile = (board, fileId) =>
  (board.elements || []).some((e) => !e.isDeleted && e.type === "image" && e.fileId === fileId);

const handleShared = async (req, res, token, sub, fileId) => {
  if (req.method !== "GET") return sendPublic(res, 405, { status: "error" });
  const share = shares.resolve(token);
  const contact = SHARE_CONTACT || undefined;
  if (share.status === "unknown") return sendPublic(res, 404, { status: "unknown", contact });
  if (share.status !== "ok") return sendPublic(res, 410, { status: share.status, expiresAt: share.expiresAt, contact });
  const board = readBoard(share.boardId);
  if (!board) return sendPublic(res, 410, { status: "missing", contact });

  if (sub === "head") return sendPublic(res, 200, { rev: board.rev || 0 });

  if (sub === "files") {
    // only images on the board: a link to one board doesn't open the others' images
    if (!FILE_ID_RE.test(fileId) || !showsFile(board, fileId)) return sendPublic(res, 404, { status: "error" });
    const inline = board.files && Object.hasOwn(board.files, fileId) && board.files[fileId];
    const file = inline && inline.dataURL ? inline : await getFile(fileId);
    if (!file) return sendPublic(res, 404, { status: "error" });
    const { id, mimeType, dataURL, created } = file;
    return sendPublic(res, 200, { id, mimeType, dataURL, created }, "private, max-age=86400");
  }

  sendPublic(res, 200, {
    name: board.name,
    elements: (board.elements || []).filter((e) => !e.isDeleted),
    // the theme it was last edited in, so viewers see it as its owner does
    appState: {
      viewBackgroundColor: (board.appState || {}).viewBackgroundColor,
      theme: (board.appState || {}).theme === "dark" ? "dark" : "light",
    },
    rev: board.rev || 0,
    expiresAt: share.expiresAt,
  });
};

// Claude connector (remote MCP server + its OAuth login). Caddy exposes these
// paths without its own login; they check their own bearer tokens.
const connector = require("./mcp")({
  dataDir: DATA_DIR,
  readBoard,
  createBoard,
  commit,
  journal,
  listBoardIds: () =>
    fs
      .readdirSync(BOARDS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5)),
  getFile,
  noteClaudeActivity,
});

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (connector.handles(url.pathname)) {
      return connector.handle(req, res, url).catch((e) => {
        console.error("connector request failed:", e.stack || e.message);
        if (!res.headersSent) send(res, 500);
      });
    }
    const page = url.pathname.match(/^\/s\/([^/]+)\/?$/);
    if (page) return handleSharePage(req, res, page[1]);
    const shared = url.pathname.match(/^\/api\/shared\/([^/]+)(?:\/(head)|\/(files)\/([^/]+))?$/);
    if (shared) {
      return handleShared(req, res, shared[1], shared[2] || shared[3], shared[4]).catch((e) => {
        console.error("shared board request failed:", e.message);
        if (!res.headersSent) sendPublic(res, 502, { status: "error" });
      });
    }
    const f = url.pathname.match(/^\/api\/files(?:\/([^/]+))?$/);
    if (f) {
      return handleFiles(req, res, f[1]).catch((e) => {
        console.error("file request failed:", e.message);
        if (!res.headersSent) send(res, 502);
      });
    }
    const m = url.pathname.match(/^\/api\/boards(?:\/([^/]+)(\/head|\/duplicate|\/shares(?:\/([^/]+))?)?)?$/);
    if (!m) return send(res, 404);
    const id = m[1];

    if (!id) {
      if (req.method === "GET") {
        const boards = fs
          .readdirSync(BOARDS_DIR)
          .filter((f) => f.endsWith(".json"))
          .map((f) => readBoard(f.slice(0, -5)))
          .filter(Boolean)
          .map((b) => ({
            id: b.id,
            name: b.name,
            createdAt: b.createdAt,
            savedAt: b.savedAt,
            // lightweight preview data for the board list
            elements: (b.elements || [])
              .filter((e) => !e.isDeleted)
              .map((e) => ({
                type: e.type,
                x: e.x,
                y: e.y,
                width: e.width,
                height: e.height,
                angle: e.angle,
                points: e.points,
                strokeColor: e.strokeColor,
                backgroundColor: e.backgroundColor,
                text: e.type === "text" ? e.text : undefined,
                fontSize: e.fontSize,
              })),
          }))
          .sort((a, b) => b.savedAt - a.savedAt);
        return send(res, 200, boards);
      }
      if (req.method === "POST") {
        return readBody(req, res, (body) => send(res, 201, { id: createBoard(body).id }));
      }
      return send(res, 405);
    }

    if (!ID_RE.test(id)) return send(res, 404);
    const board = readBoard(id);
    if (!board) return send(res, 404);

    if (m[2] === "/duplicate") {
      if (req.method !== "POST") return send(res, 405);
      const copy = duplicateBoard(board);
      return send(res, 201, { id: copy.id, name: copy.name });
    }

    if (m[2] && m[2].startsWith("/shares")) {
      const token = m[3];
      if (token) {
        if (req.method !== "DELETE") return send(res, 405);
        return send(res, shares.revoke(id, token) ? 204 : 404);
      }
      if (req.method === "GET") {
        return send(res, 200, {
          shares: shares.list(id),
          contact: SHARE_CONTACT || null,
          defaultDays: shares.DEFAULT_DAYS,
          maxDays: shares.MAX_DAYS,
        });
      }
      if (req.method === "POST") return readBody(req, res, (body) => send(res, 201, shares.create(id, body && body.days)));
      return send(res, 405);
    }

    if (m[2]) {
      if (req.method !== "GET") return send(res, 405);
      return send(res, 200, { rev: board.rev || 0, savedAt: board.savedAt, claude: claudeActivityOf(id) });
    }

    if (req.method === "GET") return send(res, 200, { ...board, rev: board.rev || 0 });

    // PUT for regular saves, POST for navigator.sendBeacon on tab close.
    // Merged per element; the answer carries the board when the server has
    // elements (e.g. Claude's) that the browser doesn't have yet.
    if (req.method === "PUT" || req.method === "POST") {
      return readBody(req, res, (scene) => {
        if (!Array.isArray(scene.elements)) return send(res, 400);
        const result = commit(id, scene.elements, "human", {
          appState: scene.appState && typeof scene.appState === "object" ? scene.appState : undefined,
        });
        if (!result) return send(res, 404);
        const behind = clientIsBehind(scene.elements, result.board.elements);
        send(res, 200, { rev: result.rev, ...(behind ? { board: { ...result.board, rev: result.rev } } : {}) });
      });
    }

    if (req.method === "PATCH") {
      return readBody(req, res, (body) => {
        writeBoard(id, { ...board, name: cleanName(body.name) });
        send(res, 204);
      });
    }

    if (req.method === "DELETE") {
      fs.renameSync(boardFile(id), path.join(TRASH_DIR, `${id}-${Date.now()}.json`));
      return send(res, 204);
    }

    send(res, 405);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`whiteboard-sync listening on 127.0.0.1:${PORT}`));
