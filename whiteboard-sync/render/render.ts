// Read-only render page for whiteboard.supa.company, used by the Claude Code
// "whiteboard" plugin (and handy in a browser too).
//
//   /render/render.html#board=<id>&frame=<elementId>&max=<px>
//
// Loads the board and its images from /api (GET only, never saves), exports
// the frame (or the whole board without `frame`) to PNG with this fork's
// exportScene, shows it, and publishes the result on
// `window.__whiteboardRender` for headless callers.
import { getNonDeletedElements } from "@excalidraw/element";
import { exportScene } from "@excalidraw/excalidraw/scene/export";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";

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

  const blob = await exportScene({
    type: "png",
    data: { elements, appState: board.appState || {}, files },
    config: {
      exportingFrame: frame,
      padding: frame ? 0 : 20,
      scale: (width, height) =>
        Math.min(MAX_SCALE, maxSide / Math.max(width, height, 1)),
    },
  });
  const dataURL = await blobToDataURL(blob);
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
