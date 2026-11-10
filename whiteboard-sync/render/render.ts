// Read-only render page for whiteboard.supa.company, driven headlessly by the
// Claude connector (whiteboard-sync/mcp/render.js) and handy in a browser too.
//
//   /render/render.html#board=<id>&frame=<elementId>&max=<px>&format=png|jpeg
//                       &highlight=<id>,<id>  (outlines those elements)
//
// Loads the board and its images from /api (GET only, never saves), exports
// the frame (or the whole board without `frame`) with this fork's
// exportScene, shows it, and publishes the result on
// `window.__whiteboardRender` for headless callers.
import { arrayToMap } from "@excalidraw/common";
import {
  getCommonBounds,
  getElementBounds,
  getNonDeletedElements,
} from "@excalidraw/element";
import { exportScene } from "@excalidraw/excalidraw/scene/export";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { setGoogleFontsConfig } from "@excalidraw/excalidraw/fonts/GoogleFonts";

import type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeleted,
} from "@excalidraw/element/types";
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types";

type RenderResult =
  | {
      ok: true;
      dataURL: string;
      width: number;
      height: number;
      board: { id: string; name: string };
      frame: { id: string; name: string | null } | null;
      missingFiles: string[];
    }
  | { ok: false; error: string };

declare global {
  interface Window {
    __whiteboardRender?: RenderResult;
  }
}

// Boards can use Google Fonts, which the editor turns on (excalidraw-app
// App.tsx); without this, that text falls back to a default font.
setGoogleFontsConfig({
  cssBaseUrl:
    import.meta.env.VITE_APP_GOOGLE_FONTS_CSS_URL ||
    "https://fonts.googleapis.com",
});

const BOARD_ID_RE = /^[a-z0-9]{10}$/;
const DEFAULT_MAX_SIDE = 2400;
const MAX_SCALE = 2;

const getJSON = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`GET ${url} answered ${res.status}`);
  }
  return res.json();
};

const isFrameLike = (
  el: ExcalidrawElement,
): el is NonDeleted<ExcalidrawFrameLikeElement> =>
  el.type === "frame" || el.type === "magicframe";

// axis-aligned overlap, good enough to decide which images to download
const overlaps = (a: ExcalidrawElement, b: ExcalidrawElement) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

const HIGHLIGHT_COLOR = "#f76707";

// Outlines elements on an exported image. The export maps the scene's
// bounds (the frame's, or all elements'), plus padding, onto the image.
const drawHighlights = async (
  dataURL: string,
  format: "png" | "jpeg",
  bounds: readonly [number, number, number, number],
  padding: number,
  boxes: readonly (readonly [number, number, number, number])[],
) => {
  const img = new Image();
  img.src = dataURL;
  await img.decode();
  const [minX, minY, maxX, maxY] = bounds;
  const sx = img.naturalWidth / (maxX - minX + padding * 2 || 1);
  const sy = img.naturalHeight / (maxY - minY + padding * 2 || 1);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const pad = 6;
  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = Math.max(2, Math.round(2 * Math.min(sx, 2)));
  ctx.setLineDash([8, 5]);
  for (const [x1, y1, x2, y2] of boxes) {
    const x = (x1 - minX + padding) * sx - pad;
    const y = (y1 - minY + padding) * sy - pad;
    const w = (x2 - x1) * sx + pad * 2;
    const h = (y2 - y1) * sy + pad * 2;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, w, h, 6);
    } else {
      ctx.rect(x, y, w, h);
    }
    ctx.stroke();
  }
  return canvas.toDataURL(
    format === "jpeg" ? "image/jpeg" : "image/png",
    format === "jpeg" ? 0.88 : undefined,
  );
};

const blobToDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const readImageSize = (dataURL: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => reject(new Error("couldn't decode the export"));
    img.src = dataURL;
  });

const render = async (): Promise<RenderResult> => {
  const params = new URLSearchParams(location.hash.slice(1));
  const boardId = params.get("board") || "";
  const frameId = params.get("frame");
  const maxSide = Number(params.get("max")) || DEFAULT_MAX_SIDE;
  const format = params.get("format") === "jpeg" ? "jpeg" : "png";
  const highlight = new Set(
    (params.get("highlight") || "").split(",").filter(Boolean),
  );

  if (!BOARD_ID_RE.test(boardId)) {
    throw new Error("missing or invalid #board=<id>");
  }

  const board = await getJSON(`/api/boards/${boardId}`);
  const elements = getNonDeletedElements(
    restoreElements(board.elements || [], null),
  );

  let frame: NonDeleted<ExcalidrawFrameLikeElement> | null = null;
  if (frameId) {
    const target = elements.find((el) => el.id === frameId);
    if (!target) {
      throw new Error(`element ${frameId} isn't on board ${boardId}`);
    }
    const frameOfTarget = isFrameLike(target)
      ? target
      : elements.find((el) => el.id === target.frameId);
    if (!frameOfTarget || !isFrameLike(frameOfTarget)) {
      throw new Error(`element ${frameId} is not a frame or inside one`);
    }
    frame = frameOfTarget;
  }

  // images: inline files first (imported boards), then the image store
  const files: BinaryFiles = { ...(board.files || {}) };
  const fileIds = new Set<string>();
  for (const el of elements) {
    if (
      el.type === "image" &&
      el.fileId &&
      (!frame || el.frameId === frame.id || overlaps(el, frame))
    ) {
      fileIds.add(el.fileId);
    }
  }
  const missingFiles: string[] = [];
  await Promise.all(
    [...fileIds]
      .filter((id) => !files[id])
      .map(async (id) => {
        try {
          const file = await getJSON(`/api/files/${encodeURIComponent(id)}`);
          files[id as BinaryFileData["id"]] = {
            id: id as BinaryFileData["id"],
            mimeType: file.mimeType,
            dataURL: file.dataURL,
            created: file.created || Date.now(),
          };
        } catch {
          missingFiles.push(id);
        }
      }),
  );

  const config = {
    exportingFrame: frame,
    padding: frame ? 0 : 20,
    scale: (width: number, height: number) =>
      Math.min(MAX_SCALE, maxSide / Math.max(width, height, 1)),
  };
  const data = { elements, appState: board.appState || {}, files };
  const blob =
    format === "jpeg"
      ? await exportScene({
          type: "jpeg",
          data,
          config: { ...config, quality: 0.88 },
        })
      : await exportScene({ type: "png", data, config });
  let dataURL = await blobToDataURL(blob);

  if (highlight.size) {
    const elementsMap = arrayToMap(elements);
    const boxes = elements
      .filter((el) => highlight.has(el.id))
      .map((el) => getElementBounds(el, elementsMap));
    if (boxes.length) {
      const bounds = frame
        ? ([
            frame.x,
            frame.y,
            frame.x + frame.width,
            frame.y + frame.height,
          ] as const)
        : getCommonBounds(
            elements.filter(
              (el) => !el.frameId || !elements.some((f) => f.id === el.frameId),
            ),
          );
      dataURL = await drawHighlights(
        dataURL,
        format,
        bounds,
        config.padding,
        boxes,
      );
    }
  }
  const { width, height } = await readImageSize(dataURL);

  return {
    ok: true,
    dataURL,
    width,
    height,
    board: { id: board.id, name: board.name },
    frame: frame ? { id: frame.id, name: frame.name } : null,
    missingFiles,
  };
};

const status = document.getElementById("status")!;

render()
  .catch(
    (error): RenderResult => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  .then((result) => {
    window.__whiteboardRender = result;
    if (result.ok) {
      const title = result.frame
        ? `${result.board.name} / ${result.frame.name || "Frame"}`
        : result.board.name;
      document.title = title;
      status.textContent = `${title} (${result.width}×${result.height})`;
      const img = document.createElement("img");
      img.src = result.dataURL;
      img.alt = title;
      document.getElementById("out")!.append(img);
    } else {
      status.textContent = `Couldn't render: ${result.error}`;
    }
  });
