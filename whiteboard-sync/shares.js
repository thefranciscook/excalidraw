// View-only share links for boards (/s/<token>), kept in data/shares.json.
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
const MAX_DAYS = 365;
// how long an expired or turned-off link is remembered
const KEEP_ENDED_MS = 180 * DAY_MS;

// Whole days from 1 to MAX_DAYS; anything else gets the default.
const validDays = (days) => {
  const n = Number(days);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : DEFAULT_DAYS;
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
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    expired: now() >= s.expiresAt,
  });

  return {
    TOKEN_RE,
    DEFAULT_DAYS,
    MAX_DAYS,

    // a new link to `boardId` that expires in `days` days
    create(boardId, days) {
      prune();
      let token;
      do token = newToken();
      while (shares[token]);
      const createdAt = now();
      shares[token] = { boardId, createdAt, expiresAt: createdAt + validDays(days) * DAY_MS };
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

    // -> {status: "ok", boardId, expiresAt}
    //  | {status: "expired", expiresAt} | {status: "revoked"} | {status: "unknown"}
    resolve(token) {
      if (typeof token !== "string" || !TOKEN_RE.test(token) || !Object.hasOwn(shares, token)) {
        return { status: "unknown" };
      }
      const s = shares[token];
      if (s.revokedAt) return { status: "revoked" };
      if (now() >= s.expiresAt) return { status: "expired", expiresAt: s.expiresAt };
      return { status: "ok", boardId: s.boardId, expiresAt: s.expiresAt };
    },
  };
};

module.exports = { createShares, validDays, TOKEN_RE, DEFAULT_DAYS, MAX_DAYS };
