// Public, view-only page for a board shared by link: /s/<token>
// (see shares.js and the /api/shared routes in server.js).
//
// Shows the board in Excalidraw's view mode: people can pan, zoom and follow
// links, but can't edit, export or save it. It picks up changes made to the
// board while it's open. When the link has expired or was turned off, it
// says so and who to ask for a new one (SHARE_CONTACT on the server).
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  isElementLink,
  restoreElements,
} from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, Theme } from "@excalidraw/element/types";

type Board = {
  name: string;
  elements: ExcalidrawElement[];
  appState: { viewBackgroundColor?: string; theme?: string };
  rev: number;
  expiresAt: number;
};

type Ended = {
  status: "expired" | "revoked" | "missing" | "unknown" | "error";
  expiresAt?: number;
  contact?: string;
};

const POLL_MS = 10 * 1000;
const DOWNLOADS_AT_ONCE = 4;
// waits before retrying an image that didn't load, then it counts as failed
const RETRY_DELAYS_MS = [2000, 6000];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const token = (location.pathname.match(/^\/s\/([^/]+)\/?$/) || [])[1] || "";
const API = `/api/shared/${encodeURIComponent(token)}`;

class LinkEnded extends Error {
  constructor(public ended: Ended) {
    super(ended.status);
  }
}

// GET from the share API; a link that's over throws LinkEnded
const getJSON = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404 || res.status === 410) {
    const body = await res.json().catch(() => ({}));
    throw new LinkEnded({ status: "unknown", ...body });
  }
  if (!res.ok) {
    throw new Error(`the server answered ${res.status}`);
  }
  return res.json();
};

const formatDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

const EMAIL_RE = /[^\s<>()@]+@[^\s<>()@]+\.[^\s<>()@]+/;

// "Szilard (me@example.com)" -> the text with the address as a mailto link
const Contact = ({ contact }: { contact: string }) => {
  const m = contact.match(EMAIL_RE);
  if (!m) {
    return <strong>{contact}</strong>;
  }
  const before = contact.slice(0, m.index);
  const after = contact.slice(m.index! + m[0].length);
  return (
    <>
      {before}
      <a href={`mailto:${m[0]}`}>{m[0]}</a>
      {after}
    </>
  );
};

const EndedPage = ({ ended }: { ended: Ended }) => {
  const title = {
    expired: "This link has expired",
    revoked: "This link was turned off",
    missing: "This board isn't available anymore",
    unknown: "This link doesn't work",
    error: "The board couldn't be loaded",
  }[ended.status];
  const detail = {
    expired: ended.expiresAt
      ? `It was valid until ${formatDate(ended.expiresAt)}.`
      : null,
    revoked: null,
    missing: null,
    unknown: "Check that you copied the whole link.",
    error: "Try reloading the page in a moment.",
  }[ended.status];
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <div className="wbv-status">
      <div className="wbv-status__box">
        <h1>{title}</h1>
        {detail && <p>{detail}</p>}
        {ended.status !== "error" && (
          <p>
            To see the board, ask{" "}
            {ended.contact ? (
              <Contact contact={ended.contact} />
            ) : (
              "the person who shared it with you"
            )}{" "}
            for a new link.
          </p>
        )}
      </div>
    </div>
  );
};

// The theme the board was last edited in, so viewers see it the way its
// owner does (dark mode inverts the drawing's colours, but not its images).
const boardTheme = (board: Board): Theme =>
  board.appState.theme === "dark" ? "dark" : "light";

// image file ids, top to bottom and left to right on the board
const imageIds = (elements: readonly ExcalidrawElement[]) => {
  const at = new Map<string, [number, number]>();
  for (const el of elements) {
    if (el.type === "image" && el.fileId && !at.has(el.fileId)) {
      at.set(el.fileId, [el.y, el.x]);
    }
  }
  return [...at.keys()].sort((a, b) => {
    const [ay, ax] = at.get(a)!;
    const [by, bx] = at.get(b)!;
    return ay - by || ax - bx;
  });
};

type Progress = { total: number; done: number; failed: number };

// "Loading images 7/20", then gone; or what couldn't be loaded
const ImageProgress = ({
  progress,
  onClose,
}: {
  progress: Progress;
  onClose: () => void;
}) => {
  const { total, done, failed } = progress;
  if (!total) {
    return null;
  }
  const finished = done + failed >= total;
  if (finished && !failed) {
    return null;
  }
  return (
    <div
      className={`wbv-progress${finished ? " wbv-progress--warn" : ""}`}
      role="status"
    >
      <span>
        {finished
          ? `${failed} of ${total} image${
              total === 1 ? "" : "s"
            } couldn't be loaded. Try reloading the page.`
          : `Loading images ${done}/${total}`}
      </span>
      {finished && (
        <button type="button" aria-label="Close" onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
};

const Viewer = ({
  initial,
  onEnded,
}: {
  initial: Board;
  onEnded: (ended: Ended) => void;
}) => {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [name, setName] = useState(initial.name);
  const rev = useRef(initial.rev);
  const loadedFiles = useRef(new Set<string>());
  // images being loaded now; starts over once a batch is through
  const batch = useRef<Progress>({ total: 0, done: 0, failed: 0 });
  const [progress, setProgress] = useState<Progress>(batch.current);

  // the board's images, a few at a time, each shown as soon as it arrives
  const loadImages = useCallback(
    async (elements: readonly ExcalidrawElement[]) => {
      if (!api) {
        return;
      }
      const ids = imageIds(elements).filter(
        (id) => !loadedFiles.current.has(id),
      );
      if (!ids.length) {
        return;
      }
      ids.forEach((id) => loadedFiles.current.add(id));
      const b = batch.current;
      if (b.done + b.failed >= b.total) {
        batch.current = { total: 0, done: 0, failed: 0 };
      }
      batch.current.total += ids.length;
      const current = batch.current;
      const update = () => setProgress({ ...current });
      update();

      const load = async (id: string) => {
        for (let attempt = 0; ; attempt++) {
          try {
            const file = await getJSON(
              `${API}/files/${encodeURIComponent(id)}`,
            );
            api.addFiles([file as BinaryFileData]);
            return true;
          } catch (e) {
            if (e instanceof LinkEnded || attempt >= RETRY_DELAYS_MS.length) {
              console.warn(`couldn't load image ${id}`, e);
              return false;
            }
            await wait(RETRY_DELAYS_MS[attempt]);
          }
        }
      };
      const queue = [...ids];
      const worker = async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          if (await load(id)) {
            current.done++;
          } else {
            current.failed++;
            // tried again with the next change to the board
            loadedFiles.current.delete(id);
          }
          update();
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, ids.length) }, worker),
      );
    },
    [api],
  );

  useEffect(() => {
    loadImages(initial.elements);
  }, [loadImages, initial.elements]);

  useEffect(() => {
    document.title = `${name} (view only)`;
  }, [name]);

  // pick up changes to the board, and notice when the link runs out
  useEffect(() => {
    if (!api) {
      return;
    }
    let stopped = false;
    let timer: number | undefined;
    const check = async () => {
      if (stopped) {
        return;
      }
      try {
        if (document.visibilityState === "visible") {
          const head = await getJSON(`${API}/head`);
          if (head.rev !== rev.current) {
            const board: Board = await getJSON(API);
            rev.current = board.rev;
            setName(board.name);
            api.updateScene({
              // the board as saved, made whole the way initialData is
              elements: restoreElements(board.elements, null, {
                repairBindings: true,
              }),
              captureUpdate: CaptureUpdateAction.NEVER,
            });
            loadImages(board.elements);
          }
        }
      } catch (e) {
        if (e instanceof LinkEnded) {
          stopped = true;
          onEnded(e.ended);
          return;
        }
        console.warn("couldn't check the board for changes", e);
      }
      if (!stopped) {
        timer = window.setTimeout(check, POLL_MS);
      }
    };
    timer = window.setTimeout(check, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        window.clearTimeout(timer);
        check();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [api, loadImages, onEnded]);

  return (
    <>
      <Excalidraw
        onExcalidrawAPI={setApi}
        viewModeEnabled
        initialData={{
          elements: initial.elements,
          appState: {
            viewBackgroundColor: initial.appState.viewBackgroundColor,
            theme: boardTheme(initial),
          },
        }}
        // open with the whole board in view (zoomed out as far as needed, never in past 100%)
        initialState={{
          viewport: {
            target: initial.elements,
            fit: "scale-down",
            // clear of the menu, name badge and zoom buttons, with a margin at the sides
            offsets: { top: 72, bottom: 72, left: 32, right: 32 },
          },
        }}
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false,
            clearCanvas: false,
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            saveAsImage: false,
            toggleTheme: true,
          },
          tools: { image: false },
        }}
        renderTopRightUI={() => (
          <div className="wbv-badge" title={name}>
            <span className="wbv-badge__name">{name}</span>
            <span className="wbv-badge__mode">· View only</span>
          </div>
        )}
        onLinkOpen={(element, event) => {
          // links to other parts of this board move the view there
          if (element.link && isElementLink(element.link)) {
            event.preventDefault();
            api?.setViewport({
              target: element.link,
              fit: "scale-down",
              animation: true,
            });
          }
        }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.ToggleTheme allowSystemTheme={false} />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
      <ImageProgress
        progress={progress}
        onClose={() => setProgress({ total: 0, done: 0, failed: 0 })}
      />
    </>
  );
};

const Page = () => {
  const [board, setBoard] = useState<Board | null>(null);
  const [ended, setEnded] = useState<Ended | null>(null);

  useEffect(() => {
    getJSON(API).then(setBoard, (e) => {
      setEnded(e instanceof LinkEnded ? e.ended : { status: "error" });
    });
  }, []);

  if (ended) {
    return <EndedPage ended={ended} />;
  }
  if (!board) {
    return <div className="wbv-status">Loading the board…</div>;
  }
  return <Viewer initial={board} onEnded={setEnded} />;
};

createRoot(document.getElementById("root")!).render(<Page />);
