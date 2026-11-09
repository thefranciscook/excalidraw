// Element-level merging, diffing and the change journal of a board.
//
// Boards are edited from two sides at once: browsers (server-sync.js pushes
// the whole scene every couple of seconds) and Claude (the connector). Instead
// of "last save wins", every save is merged per element with Excalidraw's own
// rule (packages/excalidraw/data/reconcile.ts, shouldDiscardRemoteElement):
// the higher `version` wins, a tie goes to the lower `versionNonce`. Deletes
// are tombstones (`isDeleted`), so neither side can lose the other's elements.
//
// Each save that changes something gets the next `rev` of the board and a
// line in data/journal/<board>.jsonl: {rev, at, author, changes}. That's the
// board's history: who changed which element when. The connector reads it to
// tell Claude what changed since it last looked.
const fs = require("fs");
const path = require("path");

// keep `stored` over `incoming`?
const storedWins = (stored, incoming) =>
  stored.version > incoming.version ||
  (stored.version === incoming.version && stored.versionNonce <= incoming.versionNonce);

const isElement = (el) => el && typeof el === "object" && typeof el.id === "string" && el.id;

// Fractional indices are strings that sort as plain strings (orderByFractionalIndex).
// Elements without one (very old scenes) keep their place.
const orderByIndex = (elements) => {
  if (!elements.every((el) => typeof el.index === "string")) return elements;
  return [...elements].sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

/** Merges `incoming` into `stored`, per element. -> merged elements, ordered */
function mergeElements(stored, incoming) {
  const merged = new Map();
  for (const el of stored || []) if (isElement(el)) merged.set(el.id, el);
  for (const el of incoming || []) {
    if (!isElement(el)) continue;
    const current = merged.get(el.id);
    if (!current || !storedWins(current, el)) merged.set(el.id, el);
  }
  return orderByIndex([...merged.values()]);
}

/**
 * What changed from `before` to `after`: elements that are new or whose
 * version went up. An element sent again unchanged (same version) is not a
 * change, so a browser re-sending what it got from Claude isn't one either.
 * -> [{id, type, op: "add" | "update" | "delete", version}]
 */
function diffElements(before, after) {
  const prev = new Map();
  for (const el of before || []) if (isElement(el)) prev.set(el.id, el);
  const changes = [];
  for (const el of after || []) {
    if (!isElement(el)) continue;
    const old = prev.get(el.id);
    if (old && old.version === el.version && old.versionNonce === el.versionNonce) continue;
    let op;
    if (!old || old.isDeleted) {
      if (el.isDeleted) continue; // created and deleted before anyone saw it
      op = "add";
    } else {
      op = el.isDeleted ? "delete" : "update";
    }
    changes.push({ id: el.id, type: el.type, op, version: el.version });
  }
  return changes;
}

/**
 * Does a client holding `client` lack anything in `merged`? Deleted elements
 * it never had don't count: browsers forget deleted elements on reload.
 */
function clientIsBehind(client, merged) {
  const theirs = new Map();
  for (const el of client || []) if (isElement(el)) theirs.set(el.id, el);
  return merged.some((el) => {
    const c = theirs.get(el.id);
    if (!c) return !el.isDeleted;
    return c.version !== el.version || c.versionNonce !== el.versionNonce;
  });
}

// Deleted elements are kept so the deletion reaches every copy of the board,
// then dropped after a month.
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const pruneTombstones = (elements, now = Date.now()) =>
  elements.filter((el) => !el.isDeleted || !(now - (el.updated || 0) > TOMBSTONE_TTL_MS));

const BOARD_ID_RE = /^[a-z0-9]{10}$/;

function createJournal(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (boardId) => {
    if (!BOARD_ID_RE.test(boardId)) throw new Error(`bad board id ${boardId}`);
    return path.join(dir, boardId + ".jsonl");
  };

  const append = (boardId, entry) => fs.appendFileSync(file(boardId), JSON.stringify(entry) + "\n");

  /** journal entries with rev > sinceRev, oldest first */
  const since = (boardId, sinceRev) => {
    const name = file(boardId);
    let text;
    try {
      text = fs.readFileSync(name, "utf8");
    } catch {
      return [];
    }
    const entries = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.rev > sinceRev) entries.push(entry);
      } catch {
        // a torn last line after a crash
      }
    }
    return entries;
  };

  return { append, since };
}

/**
 * Folds journal entries into one line per element: what happened to it
 * overall and who did it.
 * -> [{id, type, op: "add" | "update" | "delete", authors: [..], firstRev, lastRev}]
 */
function foldChanges(entries, { skipRevs } = {}) {
  const byId = new Map();
  for (const entry of entries) {
    if (skipRevs && skipRevs.has(entry.rev)) continue;
    for (const ch of entry.changes || []) {
      const cur = byId.get(ch.id);
      if (!cur) {
        byId.set(ch.id, { id: ch.id, type: ch.type, first: ch.op, op: ch.op, authors: new Set([entry.author]), firstRev: entry.rev, lastRev: entry.rev });
        continue;
      }
      cur.authors.add(entry.author);
      cur.lastRev = entry.rev;
      cur.type = ch.type || cur.type;
      // added and then changed is still "added"; deleted and back is "update"
      if (cur.first === "add") cur.op = ch.op === "delete" ? "gone" : "add";
      else if (ch.op === "add") cur.op = cur.first === "delete" ? "update" : "add";
      else cur.op = ch.op;
    }
  }
  return [...byId.values()]
    .filter((c) => c.op !== "gone") // added and removed again in between
    .map(({ first, authors, ...c }) => ({ ...c, authors: [...authors] }));
}

module.exports = { mergeElements, diffElements, clientIsBehind, pruneTombstones, createJournal, foldChanges, orderByIndex };
