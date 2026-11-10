// part of the repo's vitest suite (yarn test)
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { loadMedia, isPublicAddress, MediaError } from "../mcp/media";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP4z8Dwn4GBgYEBAB0EAv/0RQZDAAAAAElFTkSuQmCC";
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const noFiles = { getFile: async () => null, board: { files: {} } };

test("only public addresses are fetched", () => {
  for (const a of [
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "::ffff:808:808",
  ])
    assert.equal(isPublicAddress(a), true, a);
  for (const a of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:a00:1",
    "::ffff:a9fe:a9fe",
    "localhost",
  ]) {
    assert.equal(isPublicAddress(a), false, a);
  }
});

test("internal URLs are refused before anything is fetched", async () => {
  for (const src of [
    "http://127.0.0.1/x.png",
    "http://[::1]/x.png",
    "http://[::ffff:127.0.0.1]/x.png",
    "http://0x7f000001/x.png",
    "http://169.254.169.254/latest",
    "file:///etc/passwd",
    "not a url",
  ]) {
    await assert.rejects(
      loadMedia([{ type: "image", src }], noFiles),
      MediaError,
      src,
    );
  }
});

test("data URLs and SVG markup become files named by their SHA-1", async () => {
  const skeletons = [
    { type: "image", src: `data:application/octet-stream;base64,${PNG}` },
    { type: "image", svg: SVG },
    { type: "image", svg: SVG },
  ];
  const { files, newFiles } = await loadMedia(skeletons, noFiles);
  const pngId = crypto
    .createHash("sha1")
    .update(Buffer.from(PNG, "base64"))
    .digest("hex");
  assert.equal(skeletons[0].fileId, pngId);
  assert.equal(files[pngId].mimeType, "image/png"); // sniffed, not what the URL said
  assert.equal(skeletons[1].fileId, skeletons[2].fileId); // the same picture once
  assert.equal(files[skeletons[1].fileId].mimeType, "image/svg+xml");
  assert.equal(newFiles.length, 2);
  for (const s of skeletons) assert.ok(!("src" in s) && !("svg" in s));
});

test("an image already on the board is reused, not stored again", async () => {
  const stored = {
    mimeType: "image/png",
    dataURL: `data:image/png;base64,${PNG}`,
  };
  const skeletons = [{ type: "image", file_id: "abcdef0123" }];
  const { files, newFiles } = await loadMedia(skeletons, {
    getFile: async (id) => (id === "abcdef0123" ? stored : null),
  });
  assert.equal(skeletons[0].fileId, "abcdef0123");
  assert.equal(files.abcdef0123.dataURL, stored.dataURL);
  assert.equal(newFiles.length, 0);
  await assert.rejects(
    loadMedia([{ type: "image", file_id: "nope000000" }], noFiles),
    /no image with file_id/,
  );
});

test("what isn't an image is refused", async () => {
  await assert.rejects(
    loadMedia(
      [{ type: "image", src: "data:text/plain;base64,aGVsbG8=" }],
      noFiles,
    ),
    /isn't a PNG/,
  );
  await assert.rejects(loadMedia([{ type: "image" }], noFiles), /needs "src"/);
  await assert.rejects(
    loadMedia([{ type: "image", svg: "<div/>" }], noFiles),
    /SVG markup/,
  );
});

test("svg elements get their markup from a data URL, and keep inline markup", async () => {
  const fromURL = {
    type: "svg",
    src: `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`,
  };
  const inline = { type: "svg", svg: SVG };
  await loadMedia([fromURL, inline], noFiles);
  assert.equal(fromURL.svg, SVG);
  assert.equal(inline.svg, SVG);
  await assert.rejects(
    loadMedia([{ type: "svg", src: "data:text/plain,hello" }], noFiles),
    /isn't an SVG/,
  );
});
