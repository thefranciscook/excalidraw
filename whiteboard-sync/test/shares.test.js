// part of the repo's vitest suite (yarn test)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createShares, validDays } from "../shares";

const DAY = 24 * 60 * 60 * 1000;

const setup = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shares-")), "shares.json");
  const clock = { t: Date.UTC(2026, 0, 1) };
  const open = () => createShares(file, { now: () => clock.t });
  return { file, clock, open };
};

test("a link opens its board until it expires, 30 days by default", () => {
  const { clock, open } = setup();
  const shares = open();
  const share = shares.create("board00001");
  assert.match(share.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(share.expiresAt - share.createdAt, 30 * DAY);
  assert.deepEqual(shares.resolve(share.token), { status: "ok", boardId: "board00001", expiresAt: share.expiresAt });

  clock.t += 30 * DAY - 1;
  assert.equal(shares.resolve(share.token).status, "ok");
  clock.t += 1;
  assert.deepEqual(shares.resolve(share.token), { status: "expired", expiresAt: share.expiresAt });
  assert.equal(shares.list("board00001")[0].expired, true);
});

test("links are random and say nothing about the board", () => {
  const { open } = setup();
  const shares = open();
  const tokens = new Set(Array.from({ length: 200 }, () => shares.create("board00001").token));
  assert.equal(tokens.size, 200);
  for (const t of tokens) assert.ok(!t.includes("board00001"));
});

test("expiry can be chosen, within limits", () => {
  assert.equal(validDays(7), 7);
  assert.equal(validDays("90"), 90);
  assert.equal(validDays(365), 365);
  for (const bad of [0, -1, 1.5, 366, "x", null, undefined]) assert.equal(validDays(bad), 30);
  const { open } = setup();
  const share = open().create("board00001", 7);
  assert.equal(share.expiresAt - share.createdAt, 7 * DAY);
});

test("a turned-off link stops working, and only its board can turn it off", () => {
  const { open } = setup();
  const shares = open();
  const a = shares.create("board00001");
  const b = shares.create("board00001");
  assert.equal(shares.revoke("board00002", a.token), false);
  assert.equal(shares.resolve(a.token).status, "ok");
  assert.equal(shares.revoke("board00001", a.token), true);
  assert.deepEqual(shares.resolve(a.token), { status: "revoked" });
  assert.deepEqual(
    shares.list("board00001").map((s) => s.token),
    [b.token],
  );
  assert.equal(shares.revoke("board00001", "nope"), false);
});

test("unknown and malformed tokens are just unknown", () => {
  const { open } = setup();
  const shares = open();
  for (const t of ["", "short", "x".repeat(32), "../../etc/passwd", "__proto__", "constructor", undefined]) {
    assert.deepEqual(shares.resolve(t), { status: "unknown" });
  }
});

test("links survive a restart, and ones that ended long ago are forgotten", () => {
  const { clock, open } = setup();
  const first = open();
  const old = first.create("board00001", 1);
  const live = first.create("board00001", 365);
  const reopened = open();
  assert.equal(reopened.resolve(live.token).status, "ok");
  clock.t += 100 * DAY;
  assert.equal(open().resolve(old.token).status, "expired");
  clock.t += 100 * DAY;
  const later = open();
  assert.equal(later.resolve(old.token).status, "unknown");
  assert.equal(later.resolve(live.token).status, "ok");
});
