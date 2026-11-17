// part of the repo's vitest suite (yarn test)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mergeElements, restoreTo } from "../scene";
import { createVersions, INTERVAL_MS, MIN_DELAY_MS, parseCommit, versionContent } from "../versions";

const ID = "board00001";
const MIN = 60 * 1000;

// A stand-in for the repo's API: commits per path, newest first.
const fakeGithub = () => {
  const commits = {}; // path -> [{sha, blobSha, content, message, date}]
  const calls = [];
  let n = 0;
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const api = async (apiPath, opts = {}) => {
    calls.push(`${opts.method || "GET"} ${apiPath}`);
    if (api.failing) return reply(500, "down");
    const url = new URL(apiPath, "http://x");
    const contents = url.pathname.match(/^\/contents\/(.+)$/);
    if (contents && opts.method === "PUT") {
      const body = JSON.parse(opts.body);
      const list = (commits[contents[1]] ||= []);
      const head = list[0];
      if ((head ? head.blobSha : undefined) !== body.sha) return reply(head ? 409 : 422, "sha mismatch");
      n++;
      const commit = {
        sha: String(n).padStart(40, "0"),
        blobSha: `blob${n}`,
        content: Buffer.from(body.content, "base64").toString("utf8"),
        message: body.message,
        date: new Date(api.clock.t).toISOString(),
      };
      list.unshift(commit);
      return reply(200, { content: { sha: commit.blobSha } });
    }
    if (contents) {
      const list = commits[contents[1]] || [];
      const ref = url.searchParams.get("ref");
      const at = /^[0-9a-f]{40}$/.test(ref) ? list.find((c) => c.sha === ref) : list[0];
      if (!at) return reply(404, {});
      return (opts.headers || {}).Accept ? reply(200, at.content) : reply(200, { sha: at.blobSha });
    }
    if (url.pathname === "/commits") {
      return reply(
        200,
        (commits[url.searchParams.get("path")] || []).map((c) => ({
          sha: c.sha,
          commit: { message: c.message, committer: { date: c.date } },
        })),
      );
    }
    return reply(404, {});
  };
  api.commits = commits;
  api.calls = calls;
  return api;
};

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "versions-"));
  const clock = { t: Date.UTC(2026, 0, 1) };
  const github = fakeGithub();
  github.clock = clock;
  const boards = { [ID]: { id: ID, name: "Roadmap", rev: 0, savedAt: -1, appState: {}, elements: [] } };
  const journalEntries = [];
  // timers run by hand: advance(ms) moves the clock and fires what's due
  let timers = [];
  const advance = async (ms) => {
    clock.t += ms;
    const due = timers.filter((t) => t.at <= clock.t);
    timers = timers.filter((t) => t.at > clock.t);
    for (const t of due) t.fn();
    await new Promise((r) => setTimeout(r, 5));
  };
  const errors = [];
  const open = () =>
    createVersions({
      github,
      file: path.join(dir, "versions.json"),
      readBoard: (id) => boards[id] || null,
      journal: { since: (id, rev) => journalEntries.filter((e) => e.rev > rev) },
      now: () => clock.t,
      setTimer: (fn, ms) => {
        const t = { fn, at: clock.t + ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        timers = timers.filter((x) => x !== t);
      },
      log: (...a) => errors.push(a.join(" ")),
    });
  // a save to the board by `author`
  const change = (versions, author, elements) => {
    const b = boards[ID];
    boards[ID] = { ...b, rev: b.rev + 1, savedAt: clock.t, elements };
    journalEntries.push({ rev: b.rev + 1, author });
    versions.schedule(ID);
  };
  const file = () => github.commits[`boards/${ID}.json`] || [];
  return { clock, github, boards, open, change, advance, file, errors, pending: () => timers.length };
};

const el = (id, version = 1, extra = {}) => ({ id, type: "rectangle", version, versionNonce: version * 7, ...extra });

test("a changed board is committed a minute later, then at most every 10 minutes, ending on its last state", async () => {
  const { open, change, advance, file } = setup();
  const versions = open();
  change(versions, "human", [el("a")]);
  await advance(MIN_DELAY_MS - 1);
  assert.equal(file().length, 0);
  await advance(1);
  assert.equal(file().length, 1);
  assert.equal(JSON.parse(file()[0].content).rev, 1);

  // five minutes of changes: one commit, ten minutes after the last
  for (let i = 0; i < 5; i++) {
    change(versions, i % 2 ? "claude" : "guest:Anna", [el("a", 2 + i)]);
    await advance(MIN);
  }
  assert.equal(file().length, 1);
  await advance(INTERVAL_MS - 5 * MIN);
  assert.equal(file().length, 2);
  assert.equal(JSON.parse(file()[0].content).rev, 6);
  assert.equal(file()[0].message.split("\n")[0], "Roadmap: rev 1 → 6, by guest:Anna, claude");

  // nothing changed: nothing more is committed
  await advance(3 * INTERVAL_MS);
  assert.equal(file().length, 2);
});

test("what's committed is the live board, without deleted elements or images", () => {
  const content = JSON.parse(
    versionContent({
      id: ID,
      name: "Roadmap",
      rev: 3,
      savedAt: 5,
      appState: { viewBackgroundColor: "#fff" },
      files: { f: { dataURL: "data:image/png;base64,AAAA" } },
      elements: [el("a"), el("gone", 4, { isDeleted: true })],
    }),
  );
  assert.deepEqual(content, {
    id: ID,
    name: "Roadmap",
    rev: 3,
    savedAt: 5,
    appState: { viewBackgroundColor: "#fff" },
    elements: [el("a")],
  });
});

test("versions are listed newest first with who changed what, and can be read back", async () => {
  const { open, change, advance } = setup();
  const versions = open();
  change(versions, "human", [el("a")]);
  await advance(MIN_DELAY_MS);
  change(versions, "guest:Anna", [el("a", 2), el("b")]);
  await advance(INTERVAL_MS);

  const list = await versions.list(ID);
  assert.deepEqual(
    list.map(({ rev, from, authors }) => ({ rev, from, authors })),
    [
      { rev: 2, from: 1, authors: ["guest:Anna"] },
      { rev: 1, from: undefined, authors: ["human"] },
    ],
  );
  assert.ok(list[0].at > list[1].at);

  const first = await versions.get(ID, list[1].sha);
  assert.deepEqual(first.elements, [el("a")]);
  assert.equal(await versions.get(ID, "f".repeat(40)), null);
  assert.equal(await versions.get(ID, "../../etc"), null);
  // another board's file isn't this board's version
  assert.equal(await versions.get("board00002", list[1].sha), null);
  assert.deepEqual(await versions.list("board00002"), []);
});

test("a restart picks up boards that changed since their last version", async () => {
  const { open, change, advance, file, boards } = setup();
  const first = open();
  change(first, "human", [el("a")]);
  await advance(MIN_DELAY_MS);
  // changed, and the server restarts before the commit is due
  boards[ID] = { ...boards[ID], rev: 2, elements: [el("a", 2)] };
  const second = open();
  second.resume([ID, "missing001"]);
  await advance(INTERVAL_MS);
  assert.equal(file().length, 2);
  assert.equal(JSON.parse(file()[0].content).rev, 2);
  // and not again after another restart
  const third = open();
  third.resume([ID]);
  await advance(INTERVAL_MS);
  assert.equal(file().length, 2);
});

test("a failed commit is tried again 10 minutes later", async () => {
  const { open, change, advance, file, github, errors } = setup();
  const versions = open();
  change(versions, "human", [el("a")]);
  github.failing = true;
  await advance(MIN_DELAY_MS);
  assert.equal(file().length, 0);
  assert.equal(errors.length, 1);
  github.failing = false;
  await advance(INTERVAL_MS - 1);
  assert.equal(file().length, 0);
  await advance(1);
  assert.equal(file().length, 1);
});

test("it commits on top of the file as it is, when that's not what it committed last", async () => {
  const { open, change, advance, file, github } = setup();
  const versions = open();
  change(versions, "human", [el("a")]);
  await advance(MIN_DELAY_MS);
  // someone commits to the file from elsewhere
  file().unshift({ ...file()[0], sha: "e".repeat(40), blobSha: "elsewhere" });
  change(versions, "human", [el("a", 2)]);
  await advance(INTERVAL_MS);
  assert.equal(file().length, 3);
  assert.equal(JSON.parse(file()[0].content).rev, 2);
  assert.ok(github.calls.some((c) => c.startsWith("GET /contents/boards/board00001.json?ref=main")));
});

test("flush commits right away, and without a token nothing happens", async () => {
  const { open, change, file, pending } = setup();
  const versions = open();
  change(versions, "human", [el("a")]);
  assert.equal(await versions.flush(ID), true);
  assert.equal(file().length, 1);
  assert.equal(pending(), 0);
  assert.equal(await versions.flush(ID), false);

  const off = createVersions({ github: null, file: "/nonexistent/versions.json", readBoard: () => null });
  assert.equal(off.enabled, false);
  off.schedule(ID);
  assert.equal(await off.flush(ID), false);
});

test("a restore's commit says which version was brought back", () => {
  const parsed = parseCommit({
    sha: "a".repeat(40),
    commit: {
      message: 'Roadmap: restored the version of 2026-01-01 00:00 UTC (rev 9)\n\nwhiteboard: {"rev":9,"from":8,"authors":["human"],"restored":{"sha":"x","at":1767225600000}}',
      committer: { date: "2026-01-02T00:00:00Z" },
    },
  });
  assert.deepEqual(parsed, {
    sha: "a".repeat(40),
    at: Date.UTC(2026, 0, 2),
    message: "Roadmap: restored the version of 2026-01-01 00:00 UTC (rev 9)",
    rev: 9,
    from: 8,
    authors: ["human"],
    restored: { at: 1767225600000 },
  });
  // a commit made by hand has no details, and still lists
  assert.equal(parseCommit({ sha: "b".repeat(40), commit: { message: "fix", author: { date: "2026-01-02T00:00:00Z" } } }).rev, undefined);
});

test("restoring merges into the board as it is now, and wins", () => {
  const old = [el("same", 3), el("changed", 2, { x: 1 }), el("deleted-since", 4, { x: 2 })];
  const current = [
    el("same", 3),
    el("changed", 9, { x: 50 }),
    el("deleted-since", 5, { isDeleted: true }),
    el("added-since", 1),
    el("long-gone", 2, { isDeleted: true }),
  ];
  const save = restoreTo(current, old, 1000);
  assert.deepEqual(save.map((e) => e.id).sort(), ["added-since", "changed", "deleted-since"]);
  const byId = Object.fromEntries(save.map((e) => [e.id, e]));
  assert.equal(byId.changed.version, 10);
  assert.equal(byId.changed.x, 1);
  assert.equal(byId["deleted-since"].version, 6);
  assert.equal(byId["deleted-since"].isDeleted, false);
  assert.equal(byId["added-since"].isDeleted, true);
  assert.equal(byId["added-since"].version, 2);
  assert.equal(byId.changed.updated, 1000);

  // merged like any save, the board shows the old version again
  const merged = mergeElements(current, save);
  const live = merged.filter((e) => !e.isDeleted);
  assert.deepEqual(live.map((e) => e.id).sort(), ["changed", "deleted-since", "same"]);
  assert.deepEqual(
    live.map(({ id, x }) => ({ id, x })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    [
      { id: "changed", x: 1 },
      { id: "deleted-since", x: 2 },
      { id: "same", x: undefined },
    ],
  );
  // restoring to what's there changes nothing
  assert.deepEqual(restoreTo(live, live), []);
});
