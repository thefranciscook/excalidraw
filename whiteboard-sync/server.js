// Tiny storage backend for the self-hosted Excalidraw at whiteboard.supa.company.
// Stores each board as JSON and keeps periodic snapshots. Auth is handled by Caddy.
//
//   GET    /api/boards           list boards (no elements)
//   POST   /api/boards           create a board {name, elements?, appState?, files?} -> {id}
//   GET    /api/boards/:id       full board
//   PUT    /api/boards/:id       save scene {savedAt, elements, appState}
//   PATCH  /api/boards/:id       rename {name}
//   DELETE /api/boards/:id       move to data/trash
//
// Image files are kept in a private GitHub repo (files/<fileId>.<ext>), not on
// this disk. Needs GITHUB_TOKEN (fine-grained PAT, Contents read/write on that repo).
//
//   GET    /api/files            list stored file ids
//   GET    /api/files/:fileId    {id, mimeType, dataURL, created}
//   PUT    /api/files/:fileId    store {mimeType, dataURL}
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 3010;
const DATA_DIR = path.join(__dirname, "data");
const BOARDS_DIR = path.join(DATA_DIR, "boards");
const HISTORY_DIR = path.join(DATA_DIR, "history");
const TRASH_DIR = path.join(DATA_DIR, "trash");
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const MAX_SNAPSHOTS_PER_BOARD = 200;
const MAX_BODY = 50 * 1024 * 1024;
const ID_RE = /^[a-z0-9]{10}$/;

for (const dir of [BOARDS_DIR, HISTORY_DIR, TRASH_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

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

const github = (apiPath, opts = {}) =>
  fetch(`${GITHUB_API}/repos/${GITHUB_REPO}${apiPath}`, {
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

const handleFiles = async (req, res, id) => {
  if (!GITHUB_TOKEN) return send(res, 503);
  if (!id) {
    if (req.method !== "GET") return send(res, 405);
    if (!indexLoadedAt) await loadIndex();
    return send(res, 200, [...fileIndex.keys()]);
  }
  if (!FILE_ID_RE.test(id)) return send(res, 400);

  if (req.method === "GET") {
    const filePath = await findFile(id);
    if (!filePath) return send(res, 404);
    const gh = await github(`/contents/${filePath}?ref=${GITHUB_BRANCH}`, {
      headers: { Accept: "application/vnd.github.raw+json" },
    });
    if (gh.status === 404) {
      fileIndex.delete(id);
      return send(res, 404);
    }
    if (!gh.ok) throw new Error(`download ${gh.status}`);
    const mimeType = EXT_MIME[filePath.split(".").pop()] || "application/octet-stream";
    const dataURL = `data:${mimeType};base64,${Buffer.from(await gh.arrayBuffer()).toString("base64")}`;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "private, max-age=31536000, immutable" });
    return res.end(JSON.stringify({ id, mimeType, dataURL, created: Date.now() }));
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

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const f = url.pathname.match(/^\/api\/files(?:\/([^/]+))?$/);
    if (f) {
      return handleFiles(req, res, f[1]).catch((e) => {
        console.error("file request failed:", e.message);
        if (!res.headersSent) send(res, 502);
      });
    }
    const m = url.pathname.match(/^\/api\/boards(?:\/([^/]+))?$/);
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
        return readBody(req, res, (body) => {
          const id = newId();
          const now = Date.now();
          // elements/appState/files are set when importing a .excalidraw file
          const imported = Array.isArray(body.elements);
          const board = {
            id,
            name: cleanName(body.name),
            createdAt: now,
            savedAt: imported ? now : -1,
            elements: imported ? body.elements : [],
            appState: (imported && body.appState) || {},
            files: (imported && body.files) || {},
          };
          writeBoard(id, board);
          send(res, 201, { id });
        });
      }
      return send(res, 405);
    }

    if (!ID_RE.test(id)) return send(res, 404);
    const board = readBoard(id);
    if (!board) return send(res, 404);

    if (req.method === "GET") return send(res, 200, board);

    // PUT for regular saves, POST for navigator.sendBeacon on tab close
    if (req.method === "PUT" || req.method === "POST") {
      return readBody(req, res, (scene) => {
        if (!Array.isArray(scene.elements) || typeof scene.savedAt !== "number") return send(res, 400);
        // Last write wins, but never let an older client state overwrite a newer one.
        if (board.savedAt > scene.savedAt) return send(res, 409, board);
        const updated = { ...board, savedAt: scene.savedAt, elements: scene.elements, appState: scene.appState || {} };
        writeBoard(id, updated);
        snapshot(id, updated);
        send(res, 204);
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
