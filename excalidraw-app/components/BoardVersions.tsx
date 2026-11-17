import { exportScene, restoreElements } from "@excalidraw/excalidraw";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { useEffect, useRef, useState } from "react";

import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
  Theme,
} from "@excalidraw/element/types";

import { api } from "./ShareViewLink";

import "./BoardVersions.scss";

// Earlier versions of a board on the self-hosted board server
// (whiteboard-sync/versions.js). The server commits the board to the images
// repo while it changes, at most every 10 minutes; this lists those versions,
// shows one, and brings it back or opens it as a new board.

type Version = {
  sha: string;
  at: number;
  message: string;
  rev?: number;
  from?: number;
  /** "human", "claude", "guest", "guest:<name>" */
  authors?: string[];
  /** set when this version is an earlier one brought back */
  restored?: { at: number };
};

type VersionScene = {
  name: string;
  rev: number;
  elements: ExcalidrawElement[];
  appState: { viewBackgroundColor?: string };
};

const formatDateTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const whoIs = (author: string) => {
  if (author === "human") {
    return "you";
  }
  if (author === "claude") {
    return "Claude";
  }
  const guest = /^guest(?::(.+))?$/.exec(author);
  return guest ? guest[1] || "a guest" : author;
};

const listOf = (names: string[]) =>
  names.length > 1
    ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
    : names[0];

/** what a version is, in a line: who changed the board, or what was restored */
const describe = (v: Version) => {
  if (v.restored) {
    return v.restored.at > 0
      ? `Restored the version of ${formatDateTime(v.restored.at)}`
      : "Restored an earlier version";
  }
  if (v.authors?.length) {
    return `Changed by ${listOf(v.authors.map(whoIs))}`;
  }
  // a commit made by hand, or by an older server
  return v.message;
};

const Preview = ({
  scene,
  files,
  theme,
}: {
  scene: VersionScene;
  files: BinaryFiles;
  theme: Theme;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const elements = restoreElements(scene.elements, null).filter(
      (el) => !el.isDeleted,
    ) as NonDeletedExcalidrawElement[];
    exportScene({
      type: "svg",
      data: {
        elements,
        appState: { viewBackgroundColor: scene.appState.viewBackgroundColor },
        files,
      },
      config: { padding: 16, theme },
    }).then(
      (svg) => {
        if (cancelled || !ref.current) {
          return;
        }
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        ref.current.replaceChildren(svg);
      },
      (e) => {
        console.error("couldn't draw the version", e);
        if (!cancelled) {
          setFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scene, files, theme]);

  if (!scene.elements.length) {
    return <p className="BoardVersions__empty">The board was empty.</p>;
  }
  if (failed) {
    return (
      <p className="BoardVersions__empty">This version couldn't be drawn.</p>
    );
  }
  return <div className="BoardVersions__svg" ref={ref} />;
};

export const BoardVersionsDialog = ({
  boardId,
  getFiles,
  theme,
  onClose,
}: {
  boardId: string;
  /** the images the open board has, to show in the versions */
  getFiles: () => BinaryFiles;
  theme: Theme;
  onClose: () => void;
}) => {
  const base = `/api/boards/${boardId}/versions`;
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [minutes, setMinutes] = useState(10);
  const [selected, setSelected] = useState<string | null>(null);
  const [scene, setScene] = useState<VersionScene | null>(null);
  const [busy, setBusy] = useState<"restore" | "copy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [files] = useState(getFiles);

  useEffect(() => {
    api(base).then(
      (data: { versions: Version[]; minutes?: number }) => {
        setVersions(data.versions);
        if (data.minutes && data.minutes >= 1) {
          setMinutes(Math.round(data.minutes));
        }
        setSelected(data.versions[0]?.sha ?? null);
      },
      (e) => {
        setVersions([]);
        setError(
          e.message.includes("503")
            ? "Versions aren't set up on this server (it needs GITHUB_TOKEN)."
            : `Couldn't load this board's versions (${e.message}).`,
        );
      },
    );
  }, [base]);

  useEffect(() => {
    if (!selected) {
      return;
    }
    let cancelled = false;
    setScene(null);
    api(`${base}/${selected}`).then(
      (data: VersionScene) => {
        if (!cancelled) {
          setScene(data);
          setError(null);
        }
      },
      (e) => {
        if (!cancelled) {
          setError(`Couldn't load that version (${e.message}).`);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [base, selected]);

  const version = versions?.find((v) => v.sha === selected);
  const isLatest = !!versions && versions[0]?.sha === selected;

  const restore = async () => {
    if (
      !version ||
      !window.confirm(
        `Bring back the version of ${formatDateTime(
          version.at,
        )}? The board changes for everyone who has it open. The board as it is now is kept as a version, so you can go back.`,
      )
    ) {
      return;
    }
    setBusy("restore");
    try {
      await api(`${base}/${version.sha}/restore`, { method: "POST" });
      // the open board picks the change up like any other (server-sync.js)
      onClose();
    } catch (e: any) {
      setError(`Couldn't restore that version (${e.message}).`);
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!version) {
      return;
    }
    setBusy("copy");
    try {
      const board: { id: string } = await api(`${base}/${version.sha}/copy`, {
        method: "POST",
      });
      window.location.assign(`/b/${board.id}`);
    } catch (e: any) {
      setError(`Couldn't make a board from that version (${e.message}).`);
      setBusy(null);
    }
  };

  return (
    <Dialog
      size="wide"
      title="Version history"
      onCloseRequest={onClose}
      className="BoardVersions"
    >
      <p>
        A version of this board is saved while it changes, at most every{" "}
        {minutes === 1 ? "minute" : `${minutes} minutes`}. Restoring one changes
        the board for everyone who has it open.
      </p>

      {error && <p className="BoardVersions__error">{error}</p>}

      {versions === null ? (
        <p className="BoardVersions__empty">Loading…</p>
      ) : versions.length === 0 ? (
        !error && (
          <p className="BoardVersions__empty">
            No versions yet. The first one is saved about a minute after the
            board changes.
          </p>
        )
      ) : (
        <div className="BoardVersions__body">
          <ul className="BoardVersions__list" aria-label="Versions">
            {versions.map((v, i) => (
              <li key={v.sha}>
                <button
                  type="button"
                  aria-current={v.sha === selected}
                  onClick={() => setSelected(v.sha)}
                >
                  <strong>
                    {formatDateTime(v.at)}
                    {i === 0 && <span> · latest</span>}
                  </strong>
                  <small>{describe(v)}</small>
                </button>
              </li>
            ))}
          </ul>

          <div className="BoardVersions__detail">
            <div className="BoardVersions__preview">
              {scene ? (
                <Preview scene={scene} files={files} theme={theme} />
              ) : (
                !error && <p className="BoardVersions__empty">Loading…</p>
              )}
            </div>
            <div className="BoardVersions__actions">
              <FilledButton
                size="large"
                variant="outlined"
                label="Open as a new board"
                status={busy === "copy" ? "loading" : null}
                onClick={copy}
              />
              <FilledButton
                size="large"
                label="Restore this version"
                status={busy === "restore" ? "loading" : null}
                onClick={restore}
              />
            </div>
            {isLatest && (
              <p className="BoardVersions__note">
                This is the latest saved version. Changes from the last few
                minutes may not be in it yet.
              </p>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
};
