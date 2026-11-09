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
  appState: { viewBackgroundColor?: string };
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

const systemTheme = (): Theme =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

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

  // the board's images, a few at a time, each shown as soon as it arrives
  const loadImages = useCallback(
    async (elements: readonly ExcalidrawElement[]) => {
      if (!api) {
        return;
      }
      const ids = [
        ...new Set(
          elements.flatMap((el) =>
            el.type === "image" && el.fileId ? [el.fileId as string] : [],
          ),
        ),
      ].filter((id) => !loadedFiles.current.has(id));
      ids.forEach((id) => loadedFiles.current.add(id));
      const queue = [...ids];
      const worker = async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          try {
            const file = await getJSON(
              `${API}/files/${encodeURIComponent(id)}`,
            );
            api.addFiles([file as BinaryFileData]);
          } catch (e) {
            // try again with the next change to the board
            loadedFiles.current.delete(id);
            console.warn(`couldn't load image ${id}`, e);
          }
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
    <Excalidraw
      onExcalidrawAPI={setApi}
      viewModeEnabled
      initialData={{
        elements: initial.elements,
        appState: {
          viewBackgroundColor: initial.appState.viewBackgroundColor,
          theme: systemTheme(),
        },
        scrollToContent: true,
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
