// Renders a board or frame on the server with the deployed render page
// (render/render.html, this fork's own exportScene) in headless Chromium, and
// builds Claude's edits with the ops page (render/ops.html).
//
// The page is loaded from a made-up origin and every request it makes is
// answered here: page files from the web root, /api/boards/:id and
// /api/files/:id from the board store. So it never goes through Caddy's
// login, and it can only read. The ops page gets the board's elements handed
// in and hands the changed ones back; saving them is up to the connector.
//
// Needs the `playwright` package and its Chromium (see README). Without them,
// render() returns { error } and the connector sends text and images only.
const fs = require("fs");
const path = require("path");

const ORIGIN = "http://whiteboard.internal";
const IDLE_CLOSE_MS = 2 * 60 * 1000;
const RENDER_TIMEOUT_MS = 90 * 1000;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

module.exports = function createRenderer({ renderDir, readBoard, getFile }) {
  let browserPromise = null;
  let idleTimer = null;
  let queue = Promise.resolve();

  const loadPlaywright = () => {
    try {
      return require("playwright");
    } catch {
      return null;
    }
  };

  const available = (page = "render.html") => {
    if (!fs.existsSync(path.join(renderDir, page))) {
      return `the render page isn't deployed in ${renderDir} (run rebuild.sh)`;
    }
    if (!loadPlaywright()) return "Playwright isn't installed on the server (see whiteboard-sync/README.md)";
    return null;
  };

  const getBrowser = () => {
    if (!browserPromise) {
      const { chromium } = loadPlaywright();
      browserPromise = chromium
        .launch({
          headless: true,
          ...(process.env.WHITEBOARD_CHROMIUM ? { executablePath: process.env.WHITEBOARD_CHROMIUM } : {}),
          args: ["--disable-dev-shm-usage", "--disable-gpu"],
        })
        .then((browser) => {
          // a crashed or killed Chromium must not be reused
          browser.on("disconnected", () => {
            if (browserPromise && browserPromise.browser === browser) browserPromise = null;
          });
          browserPromise.browser = browser;
          return browser;
        })
        .catch((e) => {
          browserPromise = null;
          throw e;
        });
    }
    return browserPromise;
  };

  // keep Chromium around for follow-up calls, then free the memory
  const scheduleClose = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      const pending = browserPromise;
      browserPromise = null;
      if (pending) (await pending.catch(() => null))?.close().catch(() => {});
    }, IDLE_CLOSE_MS);
  };

  const fulfillJSON = (route, status, body) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body ?? {}) });

  const answer = async (route) => {
    const req = route.request();
    if (req.method() !== "GET") return route.abort();
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) return route.abort();

    let m = url.pathname.match(/^\/api\/boards\/([a-z0-9]{10})$/);
    if (m) {
      const board = readBoard(m[1]);
      return board ? fulfillJSON(route, 200, board) : fulfillJSON(route, 404);
    }
    m = url.pathname.match(/^\/api\/files\/([^/]+)$/);
    if (m) {
      try {
        const file = await getFile(decodeURIComponent(m[1]));
        return file ? fulfillJSON(route, 200, file) : fulfillJSON(route, 404);
      } catch {
        return fulfillJSON(route, 502);
      }
    }
    if (url.pathname.startsWith("/render/")) {
      const file = path.resolve(renderDir, "." + decodeURIComponent(url.pathname.slice("/render".length)));
      if (file.startsWith(renderDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return route.fulfill({
          status: 200,
          contentType: CONTENT_TYPES[path.extname(file)] || "application/octet-stream",
          body: fs.readFileSync(file),
        });
      }
    }
    return route.fulfill({ status: 404, body: "" });
  };

  const withPage = (fn) => {
    const run = queue.then(async () => {
      clearTimeout(idleTimer);
      const browser = await getBrowser();
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.route("**/*", answer);
        return await fn(page);
      } finally {
        await context.close().catch(() => {});
        scheduleClose();
      }
    });
    queue = run.catch(() => {}); // one render at a time keeps memory bounded
    return run;
  };

  // -> { dataURL, mimeType, width, height, missingFiles } or { error }
  const render = async ({ boardId, frameId, maxSide, format = "jpeg", highlight }) => {
    const unavailable = available();
    if (unavailable) return { error: unavailable };
    try {
      return await withPage(async (page) => {
        const hash = new URLSearchParams({ board: boardId, max: String(maxSide), format });
        if (frameId) hash.set("frame", frameId);
        if (highlight && highlight.length) hash.set("highlight", highlight.slice(0, 500).join(","));
        await page.goto(`${ORIGIN}/render/render.html#${hash}`);
        await page.waitForFunction(() => window.__whiteboardRender, null, { timeout: RENDER_TIMEOUT_MS });
        const result = await page.evaluate(() => window.__whiteboardRender);
        if (!result.ok) return { error: result.error };
        return {
          dataURL: result.dataURL,
          mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
          width: result.width,
          height: result.height,
          missingFiles: result.missingFiles || [],
        };
      });
    } catch (e) {
      return { error: `rendering failed: ${String(e.message || e).split("\n")[0]}` };
    }
  };

  // Builds edits ({add, update, delete}, see render/ops.ts) against the
  // board's elements. -> { ok, changed, created, updated, deleted, warnings }
  // or { ok: false, error }. Throws when there's no browser to do it in.
  const runOps = async ({ elements, ops }) => {
    const unavailable = available("ops.html");
    if (unavailable) throw new Error(`Can't edit boards: ${unavailable}`);
    return withPage(async (page) => {
      await page.goto(`${ORIGIN}/render/ops.html`);
      await page.waitForFunction(() => window.__whiteboardOpsReady, null, { timeout: RENDER_TIMEOUT_MS });
      return page.evaluate(({ elements, ops }) => window.__whiteboardOps({ elements }, ops), { elements, ops });
    });
  };

  // Scales an image down to fit maxSide (and re-encodes it as JPEG) when it's
  // bigger than that or than maxBytes. -> { dataURL, mimeType, width, height }
  const shrinkImage = async ({ dataURL, maxSide, maxBytes }) => {
    if (!loadPlaywright()) return null;
    try {
      return await withPage((page) =>
        page.evaluate(
          async ({ dataURL, maxSide, maxBytes }) => {
            const img = new Image();
            img.src = dataURL;
            await img.decode();
            const w = img.naturalWidth || 1;
            const h = img.naturalHeight || 1;
            const scale = Math.min(1, maxSide / Math.max(w, h));
            if (scale === 1 && dataURL.length * 0.75 <= maxBytes) {
              return { dataURL, mimeType: dataURL.slice(5, dataURL.indexOf(";")), width: w, height: h };
            }
            // step the size down until the JPEG fits the byte budget
            let s = scale;
            for (let attempt = 0; ; attempt++) {
              const canvas = document.createElement("canvas");
              canvas.width = Math.max(1, Math.round(w * s));
              canvas.height = Math.max(1, Math.round(h * s));
              const ctx = canvas.getContext("2d");
              ctx.fillStyle = "#fff"; // JPEG has no transparency
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              const out = canvas.toDataURL("image/jpeg", 0.85);
              if (out.length * 0.75 <= maxBytes || attempt >= 8) {
                return { dataURL: out, mimeType: "image/jpeg", width: canvas.width, height: canvas.height };
              }
              s *= 0.75;
            }
          },
          { dataURL, maxSide, maxBytes },
        ),
      );
    } catch (e) {
      console.error("couldn't scale an image:", String(e.message || e).split("\n")[0]);
      return null;
    }
  };

  return { render, runOps, shrinkImage, available };
};
