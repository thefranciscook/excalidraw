// Board versions, kept in the GitHub repo that holds the images.
//
// Each board is one file there, boards/<id>.json, and each version of the
// board is a commit to that file: the file's history is the board's. The
// server commits a board on its own while it changes, at most once every 10
// minutes, and always gets to the last state: a change schedules a commit
// for 10 minutes after the board's previous one (at least a minute from now).
//
// data/versions.json remembers which `rev` of each board was committed last,
// so a restart picks up where it left off (resume).
//
// The file holds the board's live elements, not the deleted ones and not
// images, which are in the repo already (files/). The commit message says
// which revs it covers and who made the changes, from the board's journal:
//
//   Roadmap: rev 41 → 57, by human, guest:Anna
//
//   whiteboard: {"rev":57,"from":41,"authors":["human","guest:Anna"]}
const fs = require("fs");

const INTERVAL_MS = 10 * 60 * 1000;
const MIN_DELAY_MS = 60 * 1000;
const SHA_RE = /^[0-9a-f]{40}$/;
const BOARD_ID_RE = /^[a-z0-9]{10}$/;
const MAX_LISTED = 100;

const versionPath = (id) => `boards/${id}.json`;

// what's committed: one element per line or so, so versions diff well
const versionContent = (board) =>
  JSON.stringify(
    {
      id: board.id,
      name: board.name,
      rev: board.rev || 0,
      savedAt: board.savedAt,
      appState: board.appState || {},
      elements: (board.elements || []).filter((el) => !el.isDeleted),
    },
    null,
    1,
  ) + "\n";

const minute = (ts) => new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC";

// journal entries since the last version -> {message, meta}
const describe = (board, from, entries) => {
  const rev = board.rev || 0;
  const authors = [...new Set(entries.map((e) => e.author).filter(Boolean))];
  const restored = entries.filter((e) => e.restored).pop();
  const meta = { rev, ...(from != null ? { from } : {}), authors, ...(restored ? { restored: restored.restored } : {}) };
  const what = restored
    ? `restored the version of ${minute(restored.restored.at)} (rev ${rev})`
    : (from != null ? `rev ${from} → ${rev}` : `rev ${rev}`) + (authors.length ? `, by ${authors.join(", ")}` : "");
  return { message: `${board.name}: ${what}\n\nwhiteboard: ${JSON.stringify(meta)}`, meta };
};

// a commit of a board's file -> {sha, at, message, rev?, from?, authors?, restored?}
const parseCommit = (c) => {
  const text = (c.commit && c.commit.message) || "";
  let meta = {};
  const m = text.match(/^whiteboard: (\{.*\})$/m);
  if (m) {
    try {
      meta = JSON.parse(m[1]);
    } catch {}
  }
  const date = c.commit && ((c.commit.committer && c.commit.committer.date) || (c.commit.author && c.commit.author.date));
  return {
    sha: c.sha,
    at: Date.parse(date) || 0,
    message: text.split("\n")[0],
    rev: typeof meta.rev === "number" ? meta.rev : undefined,
    from: typeof meta.from === "number" ? meta.from : undefined,
    authors: Array.isArray(meta.authors) ? meta.authors.filter((a) => typeof a === "string") : undefined,
    restored: meta.restored && typeof meta.restored.at === "number" ? { at: meta.restored.at } : undefined,
  };
};

/**
 * github(path, opts): fetch against the repo's API; branch: where to commit;
 * queue(task): runs commits one at a time; file: data/versions.json;
 * readBoard(id); journal ({since}). Without `github`, versions are off.
 */
const createVersions = ({
  github,
  branch = "main",
  queue = (task) => task(),
  file,
  readBoard,
  journal,
  // at most one version per board in this long, and how soon after a change
  intervalMs = INTERVAL_MS,
  minDelayMs = Math.min(MIN_DELAY_MS, intervalMs),
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console.error,
}) => {
  const enabled = !!github;
  let saved = {}; // board id -> {rev, blobSha, at}
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {}
  const save = () => {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(saved, null, 1));
    fs.renameSync(tmp, file);
  };

  const timers = new Map();
  const retryAt = new Map();

  const json = (body) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  // the sha of the board's file as it is in the repo, to commit on top of
  const currentBlobSha = async (id) => {
    const res = await github(`/contents/${versionPath(id)}?ref=${encodeURIComponent(branch)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`lookup ${res.status}`);
    return (await res.json()).sha;
  };

  // Commits the board as it is now, unless that rev is committed already.
  // -> true when it committed
  const push = (id) =>
    queue(async () => {
      const board = readBoard(id);
      if (!board) return false;
      const rev = board.rev || 0;
      const last = Object.hasOwn(saved, id) ? saved[id] : null;
      if (last && last.rev >= rev) return false;
      const entries = journal ? journal.since(id, last ? last.rev : -1) : [];
      const { message } = describe(board, last ? last.rev : null, entries);
      const content = Buffer.from(versionContent(board)).toString("base64");
      const put = (sha) => github(`/contents/${versionPath(id)}`, json({ message, content, branch, ...(sha ? { sha } : {}) }));
      let res = await put(last && last.blobSha);
      if (res.status === 409 || res.status === 422) {
        // the file isn't what was committed last from here (or versions.json is gone)
        res = await put(await currentBlobSha(id));
      }
      if (!res.ok) throw new Error(`commit ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      saved[id] = { rev, blobSha: body.content && body.content.sha, at: now() };
      save();
      retryAt.delete(id);
      return true;
    });

  // A commit of the board is due: 10 minutes after its last one, at least a
  // minute from now. One timer per board.
  const schedule = (id) => {
    if (!enabled || !BOARD_ID_RE.test(id) || timers.has(id)) return;
    const last = Object.hasOwn(saved, id) ? saved[id] : null;
    const due = Math.max(now() + minDelayMs, last ? last.at + intervalMs : 0, retryAt.get(id) || 0);
    const timer = setTimer(() => {
      timers.delete(id);
      push(id).catch((e) => {
        log(`couldn't save a version of board ${id}:`, e.message);
        retryAt.set(id, now() + intervalMs);
        schedule(id);
      });
    }, due - now());
    if (timer && timer.unref) timer.unref();
    timers.set(id, timer);
  };

  return {
    enabled,
    SHA_RE,
    schedule,

    // commits the board now, ahead of its timer
    flush(id) {
      if (!enabled) return Promise.resolve(false);
      if (timers.has(id)) {
        clearTimer(timers.get(id));
        timers.delete(id);
      }
      return push(id);
    },

    // at startup: boards that changed since their last version
    resume(ids) {
      for (const id of ids) {
        const board = readBoard(id);
        const last = Object.hasOwn(saved, id) ? saved[id] : null;
        if (board && (board.rev || 0) > (last ? last.rev : 0)) schedule(id);
      }
    },

    // the board's versions, newest first (the latest 100)
    async list(id) {
      const res = await github(
        `/commits?path=${encodeURIComponent(versionPath(id))}&sha=${encodeURIComponent(branch)}&per_page=${MAX_LISTED}`,
      );
      // 404/409: no such branch yet (an empty repo)
      if (res.status === 404 || res.status === 409) return [];
      if (!res.ok) throw new Error(`versions ${res.status}`);
      return (await res.json()).map(parseCommit);
    },

    // the board as it was at commit `sha`, or null
    async get(id, sha) {
      if (!SHA_RE.test(sha)) return null;
      const res = await github(`/contents/${versionPath(id)}?ref=${sha}`, {
        headers: { Accept: "application/vnd.github.raw+json" },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`version ${res.status}`);
      let board;
      try {
        board = JSON.parse(await res.text());
      } catch {
        return null;
      }
      if (!board || board.id !== id || !Array.isArray(board.elements)) return null;
      return board;
    },
  };
};

module.exports = { createVersions, versionContent, versionPath, describe, parseCommit, INTERVAL_MS, MIN_DELAY_MS, SHA_RE };
