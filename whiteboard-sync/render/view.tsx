// Public page for a board shared by link: /s/<token>
// (see shares.js and the /api/shared routes in server.js).
//
// With a view link it shows the board in Excalidraw's view mode: people can
// pan, zoom and follow links, but can't edit, export or save it. It picks up
// changes made to the board while it's open.
//
// With an edit link it's the editor: changes are saved to the board every
// couple of seconds and merged there per element with everyone else's (the
// owner's, Claude's), whose changes are merged into the open board the same
// way. Images added here are uploaded before the elements showing them are
// saved. Nothing is kept in this browser.
//
// When the link has expired or was turned off, the page says so and who to
// ask for a new one (SHARE_CONTACT on the server).
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  isElementLink,
  reconcileElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { ExcalidrawElement, Theme } from "@excalidraw/element/types";

/** an element deleted on the board: that it was, not what was in it */
type Deleted = {
  id: string;
  version: number;
  versionNonce: number;
  updated?: number;
};

type Board = {
  name: string;
  role: "view" | "edit";
  elements: ExcalidrawElement[];
  appState: { viewBackgroundColor?: string };
  rev: number;
  expiresAt: number;
  // with an edit link:
  label?: string;
  deleted?: Deleted[];
  /** the server can store images */
  images?: boolean;
};

type SaveState = "saved" | "saving" | "unsaved";

type Ended = {
  status: "expired" | "revoked" | "missing" | "unknown" | "error";
  expiresAt?: number;
  contact?: string;
};

const POLL_MS = 10 * 1000;
// with an edit link: how often changes are saved and fetched
const SYNC_MS = 2 * 1000;
// a failed image upload is tried again after this long
const UPLOAD_RETRY_MS = 30 * 1000;
const DOWNLOADS_AT_ONCE = 4;

const token = (location.pathname.match(/^\/s\/([^/]+)\/?$/) || [])[1] || "";
const API = `/api/shared/${encodeURIComponent(token)}`;

class LinkEnded extends Error {
  constructor(public ended: Ended) {
    super(ended.status);
  }
}

class HttpError extends Error {
  constructor(public status: number) {
    super(`the server answered ${status}`);
  }
}

// a request to the share API; a link that's over throws LinkEnded
const request = async (url: string, init: RequestInit = {}) => {
  const res = await fetch(url, { cache: "no-store", ...init });
  if ((res.status === 404 && !init.method) || res.status === 410) {
    const body = await res.json().catch(() => ({}));
    throw new LinkEnded({ status: "unknown", ...body });
  }
  if (!res.ok) {
    throw new HttpError(res.status);
  }
  return res.json();
};

const getJSON = (url: string) => request(url);

const putJSON = (url: string, body: unknown) =>
  request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

type Versions = Map<string, { version: number; versionNonce: number }>;

/** which version of each element the server has, going by `board` */
const versionsOf = (board: Board): Versions =>
  new Map(
    [...board.elements, ...(board.deleted ?? [])].map((el) => [
      el.id,
      { version: el.version, versionNonce: el.versionNonce },
    ]),
  );

/** is `el` something the server doesn't have (in this version)? */
const isUnsaved = (el: ExcalidrawElement, server: Versions) => {
  const saved = server.get(el.id);
  if (!saved) {
    // made and deleted here before it was ever saved
    return !el.isDeleted;
  }
  return saved.version !== el.version || saved.versionNonce !== el.versionNonce;
};

/**
 * The open scene with the server's version of the board merged in, the way
 * a collaboration room merges: per element, the newer version wins, and
 * what's being edited here stays. An element deleted elsewhere is deleted
 * here too, keeping what this page knows of it.
 */
const mergeBoard = (api: ExcalidrawImperativeAPI, board: Board) => {
  const local = api.getSceneElementsIncludingDeleted();
  const localById = new Map(local.map((el) => [el.id, el]));
  const deleted = (board.deleted ?? []).flatMap((d) => {
    const el = localById.get(d.id);
    return el
      ? [
          {
            ...el,
            isDeleted: true,
            version: d.version,
            versionNonce: d.versionNonce,
            updated: d.updated ?? el.updated,
          },
        ]
      : [];
  });
  return reconcileElements(
    local,
    [
      ...restoreElements(board.elements, local),
      ...deleted,
    ] as RemoteExcalidrawElement[],
    api.getAppState(),
  );
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

const SharedBoard = ({
  initial,
  onEnded,
}: {
  initial: Board;
  onEnded: (ended: Ended) => void;
}) => {
  const canEdit = initial.role === "edit";
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [name, setName] = useState(initial.name);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [stuckImages, setStuckImages] = useState(0);
  const rev = useRef(initial.rev);
  const loadedFiles = useRef(new Set<string>());
  // with an edit link: what the server has, and the images it's known to have
  const server = useRef<Versions>(versionsOf(initial));
  const uploadRetryAt = useRef(new Map<string, number>());
  const flush = useRef<() => void>(() => {});

  // the board's images, a few at a time, each shown as soon as it arrives
  const loadImages = useCallback(
    async (elements: readonly ExcalidrawElement[]) => {
      if (!api) {
        return;
      }
      const ids = [
        ...new Set(
          elements.flatMap((el) =>
            el.type === "image" && el.fileId && !el.isDeleted
              ? [el.fileId as string]
              : [],
          ),
        ),
        // (not the ones added here, which the server gets from this page)
      ].filter((id) => !loadedFiles.current.has(id) && !api.getFiles()[id]);
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
    document.title = canEdit ? name : `${name} (view only)`;
  }, [name, canEdit]);

  // View link: pick up changes to the board, and notice when the link runs out.
  useEffect(() => {
    if (!api || canEdit) {
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
  }, [api, canEdit, loadImages, onEnded]);

  // Edit link: every couple of seconds, fetch what changed elsewhere, upload
  // new images, and save what changed here.
  useEffect(() => {
    if (!api || !canEdit) {
      return;
    }
    let stopped = false;
    let timer: number | undefined;
    let failing = false;

    // the server's version of the board, merged into the open one
    const applyBoard = (board: Board) => {
      server.current = versionsOf(board);
      rev.current = board.rev;
      setName(board.name);
      api.updateScene({
        elements: mergeBoard(api, board),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };

    // images added here that the server doesn't have yet: fileId -> its data
    const newImages = () => {
      const files = api.getFiles();
      const pending = new Map<string, BinaryFileData>();
      for (const el of api.getSceneElements()) {
        if (
          el.type === "image" &&
          el.fileId &&
          !loadedFiles.current.has(el.fileId) &&
          files[el.fileId]?.dataURL
        ) {
          pending.set(el.fileId, files[el.fileId]);
        }
      }
      return pending;
    };

    const uploadImages = async () => {
      const pending = newImages();
      for (const [id, file] of pending) {
        if ((uploadRetryAt.current.get(id) ?? 0) > Date.now()) {
          continue;
        }
        try {
          await putJSON(`${API}/files/${encodeURIComponent(id)}`, {
            mimeType: file.mimeType,
            dataURL: file.dataURL,
          });
          loadedFiles.current.add(id);
          uploadRetryAt.current.delete(id);
          pending.delete(id);
        } catch (e) {
          if (e instanceof LinkEnded) {
            throw e;
          }
          uploadRetryAt.current.set(id, Date.now() + UPLOAD_RETRY_MS);
          console.warn(`couldn't upload image ${id}`, e);
        }
      }
      setStuckImages(pending.size);
      return pending;
    };

    // What to save: everything, deleted elements included (a missing element
    // isn't a deleted one), except images that aren't uploaded yet, which
    // nobody else could show.
    const toSave = (notUploaded: Map<string, unknown>) =>
      api
        .getSceneElementsIncludingDeleted()
        .filter(
          (el) =>
            !(
              el.type === "image" &&
              el.fileId &&
              !el.isDeleted &&
              notUploaded.has(el.fileId)
            ),
        );

    const sync = async () => {
      try {
        if (document.visibilityState === "visible") {
          const head = await getJSON(`${API}/head`);
          if (head.rev !== rev.current) {
            const board: Board = await getJSON(API);
            applyBoard(board);
            loadImages(board.elements);
          } else {
            // images that couldn't be loaded before
            loadImages(api.getSceneElements());
          }
        }
        const notUploaded = await uploadImages();
        const elements = toSave(notUploaded);
        if (elements.some((el) => isUnsaved(el, server.current))) {
          setSaveState("saving");
          const reply = await putJSON(API, { elements });
          if (reply.board) {
            // someone else changed the board in the meantime
            applyBoard(reply.board);
            loadImages(reply.board.elements);
          } else {
            for (const el of elements) {
              server.current.set(el.id, {
                version: el.version,
                versionNonce: el.versionNonce,
              });
            }
            rev.current = reply.rev;
          }
        }
        failing = false;
      } catch (e) {
        if (e instanceof LinkEnded) {
          stopped = true;
          onEnded(e.ended);
          return;
        }
        failing = true;
        console.warn("couldn't save or check the board", e);
      }
      const unsaved = api
        .getSceneElementsIncludingDeleted()
        .some((el) => isUnsaved(el, server.current));
      setSaveState(!unsaved ? "saved" : failing ? "unsaved" : "saving");
    };

    const loop = async () => {
      await sync();
      if (!stopped) {
        timer = window.setTimeout(loop, SYNC_MS);
      }
    };
    timer = window.setTimeout(loop, SYNC_MS);

    // As the page goes away: what's unsaved, in a request that outlives it.
    // Only the changed elements, since such requests must be small.
    flush.current = () => {
      const changed = toSave(newImages()).filter((el) =>
        isUnsaved(el, server.current),
      );
      if (!stopped && changed.length) {
        navigator.sendBeacon(
          API,
          new Blob([JSON.stringify({ elements: changed })], {
            type: "application/json",
          }),
        );
      }
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") {
        flush.current();
      }
    };
    const onPageHide = () => flush.current();
    // closing the tab now would lose changes that haven't been saved
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const unsaved = api
        .getSceneElementsIncludingDeleted()
        .some((el) => isUnsaved(el, server.current));
      if (!stopped && unsaved && (failing || newImages().size)) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [api, canEdit, loadImages, onEnded]);

  const status = !canEdit
    ? "View only"
    : stuckImages
    ? `${stuckImages} ${
        stuckImages === 1 ? "image isn't" : "images aren't"
      } uploaded yet`
    : {
        saved: "Saved",
        saving: "Saving…",
        unsaved: "Not saved, retrying…",
      }[saveState];

  return (
    <Excalidraw
      onExcalidrawAPI={setApi}
      viewModeEnabled={!canEdit}
      onChange={() => {
        // shown right away; the next save sets it straight
        if (canEdit && saveState === "saved" && api) {
          const unsaved = api
            .getSceneElementsIncludingDeleted()
            .some((el) => isUnsaved(el, server.current));
          if (unsaved) {
            setSaveState("saving");
          }
        }
      }}
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
          // the board's own settings stay its owner's
          changeViewBackgroundColor: false,
          clearCanvas: false,
          loadScene: false,
          saveToActiveFile: false,
          toggleTheme: true,
          ...(canEdit ? {} : { export: false, saveAsImage: false }),
        },
        tools: { image: canEdit && !!initial.images },
      }}
      renderTopRightUI={() => (
        <div
          className={`wbv-badge${
            canEdit && (stuckImages || saveState === "unsaved")
              ? " wbv-badge--warn"
              : ""
          }`}
          title={name}
        >
          <span className="wbv-badge__name">{name}</span>
          <span className="wbv-badge__mode" role="status">
            · {status}
          </span>
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
        {canEdit && <MainMenu.DefaultItems.SaveAsImage />}
        {canEdit && <MainMenu.DefaultItems.Export />}
        {canEdit && <MainMenu.DefaultItems.SearchMenu />}
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
  return <SharedBoard initial={board} onEnded={setEnded} />;
};

createRoot(document.getElementById("root")!).render(<Page />);
