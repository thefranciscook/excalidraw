// part of the repo's vitest suite (yarn test)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  mergeElements,
  diffElements,
  clientIsBehind,
  pruneTombstones,
  createJournal,
  foldChanges,
} from "../scene";

const el = (id, version, extra = {}) => ({
  id,
  type: "rectangle",
  version,
  versionNonce: 100,
  index: `a${id}`,
  isDeleted: false,
  ...extra,
});

test("merge keeps the higher version of each element, from either side", () => {
  const stored = [el("1", 3), el("2", 1)];
  const incoming = [el("1", 2), el("2", 5)];
  const merged = mergeElements(stored, incoming);
  assert.deepEqual(
    merged.map((e) => [e.id, e.version]),
    [
      ["1", 3],
      ["2", 5],
    ],
  );
});

test("merge breaks version ties with the lower versionNonce, like Excalidraw", () => {
  const a = el("1", 4, { versionNonce: 50, x: 1 });
  const b = el("1", 4, { versionNonce: 70, x: 2 });
  assert.equal(mergeElements([a], [b])[0].x, 1);
  assert.equal(mergeElements([b], [a])[0].x, 1);
});

test("merge never drops elements the other side doesn't have", () => {
  const merged = mergeElements([el("1", 1), el("2", 1)], [el("3", 1)]);
  assert.deepEqual(merged.map((e) => e.id).sort(), ["1", "2", "3"]);
});

test("a deletion (tombstone) wins over the older live element", () => {
  const merged = mergeElements([el("1", 2)], [el("1", 3, { isDeleted: true })]);
  assert.equal(merged[0].isDeleted, true);
});

test("merge orders by fractional index", () => {
  const merged = mergeElements(
    [el("b", 1, { index: "a2" })],
    [el("a", 1, { index: "a1" })],
  );
  assert.deepEqual(
    merged.map((e) => e.id),
    ["a", "b"],
  );
});

test("diff: adds, updates and deletes; re-sent elements aren't changes", () => {
  const before = [el("1", 1), el("2", 1), el("3", 1)];
  const after = [
    el("1", 1),
    el("2", 2),
    el("3", 2, { isDeleted: true }),
    el("4", 1),
  ];
  assert.deepEqual(diffElements(before, after), [
    { id: "2", type: "rectangle", op: "update", version: 2 },
    { id: "3", type: "rectangle", op: "delete", version: 2 },
    { id: "4", type: "rectangle", op: "add", version: 1 },
  ]);
  assert.deepEqual(diffElements(after, after), []);
});

test("diff: restoring a deleted element is an add; a new tombstone is nothing", () => {
  const before = [el("1", 2, { isDeleted: true })];
  const after = [el("1", 3), el("2", 2, { isDeleted: true })];
  assert.deepEqual(diffElements(before, after), [
    { id: "1", type: "rectangle", op: "add", version: 3 },
  ]);
});

test("clientIsBehind ignores tombstones the client never had", () => {
  const merged = [el("1", 1), el("2", 2, { isDeleted: true })];
  assert.equal(clientIsBehind([el("1", 1)], merged), false);
  assert.equal(clientIsBehind([], merged), true);
  assert.equal(clientIsBehind([el("1", 1), el("2", 1)], merged), true);
});

test("old tombstones are pruned, live elements never", () => {
  const now = Date.now();
  const old = now - 40 * 24 * 3600 * 1000;
  const kept = pruneTombstones(
    [
      el("1", 1, { updated: old }),
      el("2", 2, { isDeleted: true, updated: old }),
      el("3", 2, { isDeleted: true, updated: now }),
    ],
    now,
  );
  assert.deepEqual(
    kept.map((e) => e.id),
    ["1", "3"],
  );
});

test("journal: append, read since a rev, survive a torn line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-journal-"));
  const journal = createJournal(dir);
  journal.append("abcdefghij", { rev: 1, author: "human", changes: [] });
  journal.append("abcdefghij", { rev: 2, author: "claude", changes: [] });
  fs.appendFileSync(path.join(dir, "abcdefghij.jsonl"), '{"rev":3,"auth');
  assert.deepEqual(
    journal.since("abcdefghij", 1).map((e) => e.rev),
    [2],
  );
  assert.deepEqual(journal.since("zzzzzzzzzz", 0), []);
  assert.throws(() => journal.since("../etc", 0));
});

test("foldChanges: one line per element, with everyone who touched it", () => {
  const entries = [
    {
      rev: 5,
      author: "human",
      changes: [
        { id: "a", type: "text", op: "add" },
        { id: "b", type: "rectangle", op: "update" },
      ],
    },
    {
      rev: 6,
      author: "claude",
      changes: [
        { id: "b", type: "rectangle", op: "update" },
        { id: "c", type: "arrow", op: "add" },
      ],
    },
    {
      rev: 7,
      author: "human",
      changes: [
        { id: "a", type: "text", op: "update" },
        { id: "c", type: "arrow", op: "delete" },
        { id: "d", type: "ellipse", op: "delete" },
      ],
    },
  ];
  const folded = foldChanges(entries);
  assert.deepEqual(
    folded.map(({ id, op, authors }) => [id, op, authors]),
    [
      ["a", "add", ["human"]],
      ["b", "update", ["human", "claude"]],
      ["d", "delete", ["human"]],
    ],
  );
  // this call's own edits are left out
  const others = foldChanges(entries, { skipRevs: new Set([6]) });
  assert.deepEqual(
    others.map((c) => c.id),
    ["a", "b", "c", "d"],
  );
  assert.equal(others.find((c) => c.id === "c").op, "delete");
});
