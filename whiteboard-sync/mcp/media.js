// Images and SVGs Claude puts on a board (add_elements): fetched from a URL,
// or given inline as a data URL or SVG markup, or an image already on the
// board by its file_id. Images get Excalidraw's file id (the SHA-1 of their
// bytes), so the same picture is stored once.
//
// URLs are fetched from this server, so only public http(s) addresses are:
// no loopback, private, link-local or otherwise internal ones, checked again
// at every redirect.
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20 * 1000;
const MAX_REDIRECTS = 4;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp"];

class MediaError extends Error {}

// IPv4 and IPv6 ranges that aren't the public internet
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
]) {
  BLOCKED.addSubnet(addr, prefix, "ipv4");
}
// (IPv4-mapped addresses, ::ffff:a.b.c.d, are checked as the IPv4 address)
for (const [addr, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  BLOCKED.addSubnet(addr, prefix, "ipv6");
}

const isPublicAddress = (address) => {
  const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
  if (!family) return false;
  if (family === "ipv6") {
    // IPv4-mapped, as ::ffff:127.0.0.1 or (as URLs write it) ::ffff:7f00:1
    const dotted = address.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (dotted) return isPublicAddress(dotted[1]);
    const hex = address.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hex) {
      const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
  }
  return !BLOCKED.check(address, family);
};

const checkHost = async (url) => {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MediaError(`Only http(s) links can be fetched, not ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new MediaError(`Couldn't find the server ${url.hostname}.`);
  if (!addresses.every((a) => isPublicAddress(a.address))) {
    throw new MediaError(`${url.hostname} isn't a public address, so it can't be fetched from here.`);
  }
};

// GET a public URL -> { bytes, contentType }, at most maxBytes
const fetchPublic = async (href, maxBytes) => {
  let url;
  try {
    url = new URL(href);
  } catch {
    throw new MediaError(`"${String(href).slice(0, 100)}" isn't a link.`);
  }
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    await checkHost(url);
    let res;
    try {
      res = await fetch(url, { redirect: "manual", signal, headers: { "User-Agent": "whiteboard-sync", Accept: "image/*,*/*;q=0.5" } });
    } catch (e) {
      throw new MediaError(`Couldn't fetch ${url.href.slice(0, 100)}: ${e.cause?.message || e.message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new MediaError(`${url.href.slice(0, 100)} redirects too many times.`);
      url = new URL(res.headers.get("location"), url);
      continue;
    }
    if (!res.ok) throw new MediaError(`${url.href.slice(0, 100)} answered ${res.status}.`);
    const declared = Number(res.headers.get("content-length"));
    if (declared > maxBytes) throw new MediaError(`${url.href.slice(0, 100)} is too large (over ${maxBytes / 1024 / 1024} MB).`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) throw new MediaError(`${url.href.slice(0, 100)} is too large (over ${maxBytes / 1024 / 1024} MB).`);
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), contentType: (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() };
  }
};

const looksLikeSvg = (bytes) => /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(bytes.subarray(0, 4096).toString("utf8"));

// the image type, from its first bytes (servers often say octet-stream)
const sniff = (bytes, declared) => {
  const hex = bytes.subarray(0, 12).toString("hex");
  if (hex.startsWith("89504e47")) return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("47494638")) return "image/gif";
  if (hex.startsWith("52494646") && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (bytes.subarray(4, 12).toString() === "ftypavif") return "image/avif";
  if (hex.startsWith("424d")) return "image/bmp";
  if (looksLikeSvg(bytes)) return "image/svg+xml";
  return IMAGE_TYPES.includes(declared) ? declared : null;
};

const fileFromBytes = (bytes, mimeType) => ({
  id: crypto.createHash("sha1").update(bytes).digest("hex"),
  mimeType,
  dataURL: `data:${mimeType};base64,${bytes.toString("base64")}`,
});

const fromDataURL = (dataURL) => {
  const m = dataURL.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) throw new MediaError("That data URL can't be read.");
  const bytes = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  return { bytes, contentType: (m[1] || "").toLowerCase() };
};

/**
 * Loads what image and svg skeletons point at, in place: images get a
 * `fileId`, svgs their markup in `svg`. -> { files: {id: {mimeType, dataURL}},
 * newFiles: [{id, mimeType, dataURL}] } (newFiles: to be stored).
 */
async function loadMedia(skeletons, { getFile, board }) {
  const files = {};
  const newFiles = new Map();
  for (const s of skeletons) {
    if (!s || typeof s !== "object") continue;

    if (s.type === "svg" && typeof s.svg !== "string") {
      if (typeof s.src !== "string") throw new MediaError('An svg element needs "svg" (SVG markup) or "src" (its URL).');
      const { bytes } = s.src.startsWith("data:") ? fromDataURL(s.src) : await fetchPublic(s.src, MAX_SVG_BYTES);
      if (!looksLikeSvg(bytes)) throw new MediaError(`${s.src.slice(0, 100)} isn't an SVG.`);
      s.svg = bytes.toString("utf8");
      delete s.src;
      continue;
    }

    if (s.type !== "image") continue;
    let file;
    const fileId = s.file_id ?? s.fileId;
    if (typeof s.svg === "string") {
      const bytes = Buffer.from(s.svg, "utf8");
      if (!looksLikeSvg(bytes)) throw new MediaError('An image\'s "svg" must be SVG markup (<svg …>…</svg>).');
      file = fileFromBytes(bytes, "image/svg+xml");
      newFiles.set(file.id, file);
    } else if (typeof s.src === "string") {
      const { bytes, contentType } = s.src.startsWith("data:") ? fromDataURL(s.src) : await fetchPublic(s.src, MAX_IMAGE_BYTES);
      if (bytes.length > MAX_IMAGE_BYTES) throw new MediaError(`That image is too large (over ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`);
      const mimeType = sniff(bytes, contentType);
      if (!mimeType) throw new MediaError(`${s.src.startsWith("data:") ? "That data URL" : s.src.slice(0, 100)} isn't a PNG, JPEG, GIF, WebP, AVIF, BMP or SVG image.`);
      file = fileFromBytes(bytes, mimeType);
      newFiles.set(file.id, file);
    } else if (typeof fileId === "string" && fileId) {
      const stored = (board && board.files && board.files[fileId]) || (await getFile(fileId).catch(() => null));
      if (!stored || !stored.dataURL) throw new MediaError(`There's no image with file_id ${fileId}.`);
      file = { id: fileId, mimeType: stored.mimeType, dataURL: stored.dataURL };
    } else {
      throw new MediaError('An image needs "src" (an image URL or data URL), "svg" (SVG markup), or "file_id" (an image on the board).');
    }
    files[file.id] = { mimeType: file.mimeType, dataURL: file.dataURL };
    s.fileId = file.id;
    delete s.src;
    delete s.svg;
    delete s.file_id;
  }
  return { files, newFiles: [...newFiles.values()] };
}

module.exports = { loadMedia, fetchPublic, isPublicAddress, MediaError };
