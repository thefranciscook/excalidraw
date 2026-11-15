// part of the repo's vitest suite (yarn test)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanLabel, createShares, guestAuthor, sharedScene, validDays, validGuestElements } from "../shares";

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
  assert.deepEqual(shares.resolve(share.token), {
    status: "ok",
    boardId: "board00001",
    expiresAt: share.expiresAt,
    role: "view",
    label: "",
  });

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

test("a link is view-only unless it's made an edit link, which lasts 7 days by default", () => {
  const { open } = setup();
  const shares = open();
  const view = shares.create("board00001", { label: "Team" });
  assert.equal(view.role, "view");
  assert.equal(shares.resolve(view.token).role, "view");
  for (const role of ["EDIT", "admin", true, 1, null]) {
    assert.equal(shares.resolve(shares.create("board00001", { role }).token).role, "view");
  }

  const edit = shares.create("board00001", { role: "edit", label: "  Anna\n B. " });
  assert.equal(edit.role, "edit");
  assert.equal(edit.label, "Anna B.");
  assert.equal(edit.expiresAt - edit.createdAt, 7 * DAY);
  assert.deepEqual(shares.resolve(edit.token), {
    status: "ok",
    boardId: "board00001",
    expiresAt: edit.expiresAt,
    role: "edit",
    label: "Anna B.",
  });
  assert.equal(shares.create("board00001", { role: "edit", days: 90 }).expiresAt - edit.createdAt, 90 * DAY);
  // kept across a restart, and listed with the board's other links
  assert.equal(open().resolve(edit.token).role, "edit");
  assert.deepEqual(
    shares.list("board00001").find((s) => s.token === edit.token),
    { token: edit.token, role: "edit", label: "Anna B.", createdAt: edit.createdAt, expiresAt: edit.expiresAt, expired: false },
  );
});

test("an edit link stops saving when it expires or is turned off", () => {
  const { clock, open } = setup();
  const shares = open();
  const a = shares.create("board00001", { role: "edit" });
  const b = shares.create("board00001", { role: "edit", days: 1 });
  shares.revoke("board00001", a.token);
  assert.deepEqual(shares.resolve(a.token), { status: "revoked" });
  clock.t += DAY;
  assert.equal(shares.resolve(b.token).status, "expired");
});

test("labels are one short line of text", () => {
  assert.equal(cleanLabel("Anna"), "Anna");
  assert.equal(cleanLabel(" a\r\n\tb\u0000c\u2028d "), "a b c d");
  assert.equal(cleanLabel("x".repeat(100)).length, 40);
  for (const empty of [undefined, null, "", "   "]) assert.equal(cleanLabel(empty), "");
  assert.equal(guestAuthor({ label: "Anna" }), "guest:Anna");
  assert.equal(guestAuthor({ label: "" }), "guest");
});

test("an edit link may only save well-formed elements", () => {
  const el = { id: "a", type: "rectangle", version: 3, versionNonce: 12345 };
  assert.equal(validGuestElements([]), true);
  assert.equal(validGuestElements([el, { ...el, id: "b", isDeleted: true }]), true);
  for (const bad of [
    undefined,
    null,
    {},
    "x",
    [null],
    [[]],
    [{ ...el, id: "" }],
    [{ ...el, id: 5 }],
    [{ ...el, id: "x".repeat(101) }],
    [{ ...el, type: undefined }],
    [{ ...el, version: "9" }],
    [{ ...el, version: 1e300 }],
    [{ ...el, version: -1 }],
    [{ ...el, version: 1.5 }],
    [{ ...el, versionNonce: null }],
  ]) {
    assert.equal(validGuestElements(bad), false, JSON.stringify(bad));
  }
});

test("a shared board leaves out what was deleted; an edit link learns only that it was", () => {
  const board = {
    name: "Plans",
    rev: 7,
    appState: { viewBackgroundColor: "#fff", scrollX: 40, name: "secret" },
    files: { f1: { dataURL: "data:..." } },
    elements: [
      { id: "a", type: "text", text: "kept", version: 2, versionNonce: 1 },
      { id: "b", type: "text", text: "old secret", version: 5, versionNonce: 9, updated: 123, isDeleted: true },
    ],
  };
  const viewScene = sharedScene(board, { role: "view", label: "Team", expiresAt: 99 });
  assert.deepEqual(viewScene, {
    name: "Plans",
    role: "view",
    elements: [board.elements[0]],
    appState: { viewBackgroundColor: "#fff" },
    rev: 7,
    expiresAt: 99,
  });

  const editScene = sharedScene(board, { role: "edit", label: "Anna", expiresAt: 99 }, { images: true });
  assert.deepEqual(editScene, {
    name: "Plans",
    role: "edit",
    label: "Anna",
    elements: [board.elements[0]],
    deleted: [{ id: "b", version: 5, versionNonce: 9, updated: 123 }],
    appState: { viewBackgroundColor: "#fff" },
    rev: 7,
    expiresAt: 99,
    images: true,
  });
  assert.ok(!JSON.stringify(editScene).includes("secret"));
});
