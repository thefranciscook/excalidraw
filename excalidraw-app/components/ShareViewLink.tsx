import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import { copyIcon, share } from "@excalidraw/excalidraw/components/icons";
import { useCopyStatus } from "@excalidraw/excalidraw/hooks/useCopiedIndicator";
import { useCallback, useEffect, useRef, useState } from "react";

import "./ShareViewLink.scss";

// View-only links to a board on the self-hosted board server
// (whiteboard-sync/shares.js): anyone with the link can look at the board,
// nobody can edit it through the link, and the link stops working when it
// expires or is turned off.

type Share = {
  token: string;
  createdAt: number;
  expiresAt: number;
  expired: boolean;
};

type ShareList = {
  shares: Share[];
  contact: string | null;
  defaultDays: number;
  maxDays: number;
};

const EXPIRY_CHOICES = [
  { days: 1, label: "1 day" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

/** the board open in this tab (/b/<id>), or null outside a board */
export const getBoardId = () =>
  window.location.pathname.match(/^\/b\/([a-z0-9]{10})\/?$/)?.[1] ?? null;

const shareUrl = (token: string) => `${window.location.origin}/s/${token}`;

const api = async (url: string, opts: RequestInit = {}) => {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  // the site login answers with its own page instead of /api
  if (!res.ok || res.redirected) {
    throw new Error(`the server answered ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
};

const formatDate = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const CopyLink = ({ url, label }: { url: string; label?: string }) => {
  const { copyStatus, onCopy } = useCopyStatus();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="ShareViewLink__copyRow">
      <TextField ref={inputRef} label={label} readonly fullWidth value={url} />
      <FilledButton
        size="large"
        label="Copy"
        icon={copyIcon}
        status={copyStatus}
        onClick={async () => {
          await copyTextToSystemClipboard(url);
          onCopy();
          inputRef.current?.select();
        }}
      />
    </div>
  );
};

export const ShareViewLinkDialog = ({
  boardId,
  onClose,
}: {
  boardId: string;
  onClose: () => void;
}) => {
  const base = `/api/boards/${boardId}/shares`;
  const [list, setList] = useState<ShareList | null>(null);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data: ShareList = await api(base);
      setList(data);
      setError(null);
      return data;
    } catch (e: any) {
      setError(`Couldn't load this board's links (${e.message}).`);
      return null;
    }
  }, [base]);

  useEffect(() => {
    load().then((data) => data && setDays(data.defaultDays));
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const share: Share = await api(base, {
        method: "POST",
        body: JSON.stringify({ days }),
      });
      setCreated(share.token);
      await load();
    } catch (e: any) {
      setError(`Couldn't create a link (${e.message}).`);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (token: string) => {
    if (
      !window.confirm(
        "Turn this link off? Anyone who has it won't be able to see the board anymore.",
      )
    ) {
      return;
    }
    try {
      await api(`${base}/${encodeURIComponent(token)}`, { method: "DELETE" });
      if (created === token) {
        setCreated(null);
      }
      await load();
    } catch (e: any) {
      setError(`Couldn't turn the link off (${e.message}).`);
    }
  };

  const others = (list?.shares ?? []).filter((s) => s.token !== created);

  return (
    <Dialog
      size="small"
      title="Share a view-only link"
      onCloseRequest={onClose}
      className="ShareViewLink"
    >
      <p>
        Anyone with the link can look at this board, and see changes as you make
        them, but can't edit it. Links are random, so they can't be guessed.
      </p>

      {created && <CopyLink url={shareUrl(created)} label="New link" />}

      <div className="ShareViewLink__create">
        <label>
          Expires after{" "}
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            disabled={busy}
          >
            {EXPIRY_CHOICES.filter((c) => !list || c.days <= list.maxDays).map(
              (c) => (
                <option key={c.days} value={c.days}>
                  {c.label}
                </option>
              ),
            )}
          </select>
        </label>
        <FilledButton
          size="large"
          label={created ? "Create another link" : "Create link"}
          icon={share}
          status={busy ? "loading" : null}
          onClick={create}
        />
      </div>

      {error && <p className="ShareViewLink__error">{error}</p>}

      {others.length > 0 && (
        <section>
          <h3>{created ? "Other links" : "Links"}</h3>
          <ul className="ShareViewLink__list">
            {others.map((s) => (
              <li key={s.token}>
                <div className="ShareViewLink__linkMeta">
                  <code title={shareUrl(s.token)}>
                    …/s/{s.token.slice(0, 8)}…
                  </code>
                  <span
                    className={s.expired ? "ShareViewLink__expired" : undefined}
                  >
                    {s.expired
                      ? `Expired ${formatDate(s.expiresAt)}`
                      : `Expires ${formatDate(s.expiresAt)}`}
                  </span>
                </div>
                <div className="ShareViewLink__linkActions">
                  {!s.expired && (
                    <button
                      type="button"
                      onClick={() =>
                        copyTextToSystemClipboard(shareUrl(s.token))
                      }
                    >
                      Copy
                    </button>
                  )}
                  <button
                    type="button"
                    className="ShareViewLink__danger"
                    onClick={() => revoke(s.token)}
                  >
                    {s.expired ? "Remove" : "Turn off"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {list && (
        <p className="ShareViewLink__note">
          When a link has expired or is turned off, people opening it are asked
          to contact{" "}
          {list.contact ? (
            <strong>{list.contact}</strong>
          ) : (
            <>
              the person who shared it. Set <code>SHARE_CONTACT</code> on the
              server to show your name or email instead
            </>
          )}
          .
        </p>
      )}
    </Dialog>
  );
};

export const ShareViewLinkButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    className="share-view-link-button"
    onClick={onClick}
    title="Share a view-only link to this board"
  >
    {share}
    <span>Share</span>
  </button>
);
