import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import { copyIcon, MagicIcon } from "@excalidraw/excalidraw/components/icons";
import { useCopyStatus } from "@excalidraw/excalidraw/hooks/useCopiedIndicator";
import { useRef, useState } from "react";

import "./ClaudeConnectorBanner.scss";

// the board server's Claude connector (whiteboard-sync/mcp) lives on this site
const getConnectorUrl = () => `${window.location.origin}/mcp`;

const CopyRow = ({ label, value }: { label: string; value: string }) => {
  const { copyStatus, onCopy } = useCopyStatus();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="ClaudeConnector__copyRow">
      <TextField
        ref={inputRef}
        label={label}
        readonly
        fullWidth
        value={value}
      />
      <FilledButton
        size="large"
        label="Copy"
        icon={copyIcon}
        status={copyStatus}
        onClick={async () => {
          await copyTextToSystemClipboard(value);
          onCopy();
          // the button disables itself while it shows "copied"; keep focus in
          // the dialog (so Escape still closes it) and show what was copied
          inputRef.current?.select();
        }}
      />
    </div>
  );
};

const ClaudeConnectorDialog = ({ onClose }: { onClose: () => void }) => {
  const url = getConnectorUrl();
  return (
    <Dialog
      size="small"
      title="Connect your boards to Claude"
      onCloseRequest={onClose}
      className="ClaudeConnector"
    >
      <p className="ClaudeConnector__intro">
        Claude can look at your boards and frames while you chat, for example
        while designing a website. It can only read them, never change them.
      </p>

      <CopyRow label="Connector URL" value={url} />

      <section>
        <h3>claude.ai and the Claude apps</h3>
        <ol>
          <li>
            Open{" "}
            <a
              href="https://claude.ai/settings/connectors"
              target="_blank"
              rel="noopener noreferrer"
            >
              Settings → Connectors
            </a>{" "}
            and choose <strong>Add custom connector</strong>.
          </li>
          <li>Paste the connector URL above, then add it and click Connect.</li>
          <li>
            Log in with the connector's username and password, set on the server
            as <code>MCP_USER</code> and <code>MCP_PASSWORD</code>.
          </li>
          <li>Turn the connector on in a chat's tools menu.</li>
        </ol>
        <p className="ClaudeConnector__note">
          It then works in claude.ai and the desktop and mobile apps. In
          claude.ai and the desktop app, frames also show up in the chat.
        </p>
      </section>

      <section>
        <h3>Claude Code</h3>
        <CopyRow
          label="Command"
          value={`claude mcp add --transport http whiteboard ${url}`}
        />
        <p className="ClaudeConnector__note">
          Then run <code>/mcp</code> in Claude Code to log in.
        </p>
      </section>

      <section>
        <h3>Using it</h3>
        <p>
          Right-click a frame, choose <strong>Copy link to object</strong>, and
          paste the link into the chat. Or name it: "use the Hero frame on the
          Inspiration board".
        </p>
      </section>
    </Dialog>
  );
};

export const ClaudeConnectorBanner = () => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="claude-banner"
        onClick={() => setIsOpen(true)}
      >
        <span className="claude-banner__icon">{MagicIcon}</span>
        <span className="claude-banner__text">
          <span className="claude-banner__title">Connect to Claude</span>
          <span className="claude-banner__subtitle">
            Use your boards in chats
          </span>
        </span>
      </button>
      {isOpen && <ClaudeConnectorDialog onClose={() => setIsOpen(false)} />}
    </>
  );
};
