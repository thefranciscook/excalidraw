// Share links for boards (/s/<token>), kept in data/shares.json. A link lets
// people look at its board ("view", the default) or also change it ("edit").
// An edit link can carry a label, the name of the person it's for, which is
// the author of their changes in the board's journal.
//
// A link's token is 24 random bytes (192 bits), not derived from anything,
// so links can't be guessed or worked out from a board's id or name. A
// viewer only ever learns the token, never the board's id.
//
// Links expire (30 days unless asked otherwise) and can be turned off. Both
// stay on record for a while afterwards, so the viewer is told the link
// expired or was turned off, rather than that it never existed.
const fs = require("fs");
const crypto = require("crypto");

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
// a link that lets people change the board is better short-lived
const DEFAULT_EDIT_DAYS = 7;
const MAX_DAYS = 365;
// how long an expired or turned-off link is remembered
const KEEP_ENDED_MS = 180 * DAY_MS;

// Whole days from 1 to MAX_DAYS; anything else gets the default.
const validDays = (days, fallback = DEFAULT_DAYS) => {
  const n = Number(days);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : fallback;
};

const MAX_LABEL = 40;
// one line of plain text: no control characters, no line breaks
const cleanLabel = (label) =>
  String(label == null ? "" : label)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL);

const roleOf = (s) => (s.role === "edit" ? "edit" : "view");

// who a link's changes are by, in the board's journal: "guest" or "guest:<label>"
const guestAuthor = (share) => (share.label ? `guest:${share.label}` : "guest");

// What an edit link may save: elements with the fields merging relies on.
const validGuestElements = (elements) =>
  Array.isArray(elements) &&
  elements.every(
    (el) =>
      el &&
      typeof el === "object" &&
      !Array.isArray(el) &&
      typeof el.id === "string" &&
      el.id.length > 0 &&
      el.id.length <= 100 &&
      typeof el.type === "string" &&
      Number.isSafeInteger(el.version) &&
      el.version >= 0 &&
      Number.isSafeInteger(el.versionNonce),
  );

// The board as someone with the link gets it. Deleted elements are left out.
// An edit link also gets `deleted`: which elements were deleted, without what
// was in them, so a deletion made elsewhere reaches the open board.
const sharedScene = (board, share, extra = {}) => {
  const role = roleOf(share);
  const all = board.elements || [];
  return {
    name: board.name,
    role,
    ...(role === "edit" ? { label: share.label || "" } : {}),
    elements: all.filter((el) => !el.isDeleted),
    ...(role === "edit"
      ? {
          deleted: all
            .filter((el) => el.isDeleted)
            .map(({ id, version, versionNonce, updated }) => ({ id, version, versionNonce, updated })),
        }
      : {}),
    appState: { viewBackgroundColor: (board.appState || {}).viewBackgroundColor },
    rev: board.rev || 0,
    expiresAt: share.expiresAt,
    ...extra,
  };
};

const newToken = () => crypto.randomBytes(24).toString("base64url");

const createShares = (file, { now = Date.now } = {}) => {
  let shares = {};
  try {
    shares = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {}

  const save = () => {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(shares, null, 1));
    fs.renameSync(tmp, file);
  };

  const endedAt = (s) => Math.min(s.expiresAt, s.revokedAt || Infinity);

  // forget links that ended long ago
  const prune = () => {
    const t = now();
    let changed = false;
    for (const token of Object.keys(shares)) {
      if (t - endedAt(shares[token]) > KEEP_ENDED_MS) {
        delete shares[token];
        changed = true;
      }
    }
    return changed;
  };
  if (prune()) save();

  const view = (token, s) => ({
    token,
    role: roleOf(s),
    label: s.label || "",
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    expired: now() >= s.expiresAt,
  });

  return {
    TOKEN_RE,
    DEFAULT_DAYS,
    DEFAULT_EDIT_DAYS,
    MAX_DAYS,

    // A new link to `boardId`. `opts` is {days?, role?, label?}, or just the
    // days: it expires in `days` days (30 for a view link, 7 for an edit
    // link, unless given), and `role` "edit" lets people change the board.
    create(boardId, opts) {
      prune();
      const { days, role, label } = opts && typeof opts === "object" ? opts : { days: opts };
      const edit = role === "edit";
      let token;
      do token = newToken();
      while (shares[token]);
      const createdAt = now();
      shares[token] = {
        boardId,
        createdAt,
        expiresAt: createdAt + validDays(days, edit ? DEFAULT_EDIT_DAYS : DEFAULT_DAYS) * DAY_MS,
        ...(edit ? { role: "edit" } : {}),
        ...(cleanLabel(label) ? { label: cleanLabel(label) } : {}),
      };
      save();
      return view(token, shares[token]);
    },

    // the board's links that haven't been turned off, newest first
    list(boardId) {
      return Object.entries(shares)
        .filter(([, s]) => s.boardId === boardId && !s.revokedAt)
        .map(([token, s]) => view(token, s))
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    // turns a link off; false when the board has no such link
    revoke(boardId, token) {
      const s = Object.hasOwn(shares, token) && shares[token];
      if (!s || s.boardId !== boardId) return false;
      if (!s.revokedAt) {
        s.revokedAt = now();
        save();
      }
      return true;
    },

    // -> {status: "ok", boardId, expiresAt, role: "view" | "edit", label}
    //  | {status: "expired", expiresAt} | {status: "revoked"} | {status: "unknown"}
    resolve(token) {
      if (typeof token !== "string" || !TOKEN_RE.test(token) || !Object.hasOwn(shares, token)) {
        return { status: "unknown" };
      }
      const s = shares[token];
      if (s.revokedAt) return { status: "revoked" };
      if (now() >= s.expiresAt) return { status: "expired", expiresAt: s.expiresAt };
      return { status: "ok", boardId: s.boardId, expiresAt: s.expiresAt, role: roleOf(s), label: s.label || "" };
    },
  };
};

module.exports = {
  createShares,
  validDays,
  cleanLabel,
  guestAuthor,
  validGuestElements,
  sharedScene,
  TOKEN_RE,
  DEFAULT_DAYS,
  DEFAULT_EDIT_DAYS,
  MAX_DAYS,
};
