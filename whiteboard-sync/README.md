# whiteboard-sync

Self-hosting add-ons for whiteboard.supa.company. On the VPS they live in `/home/ubuntu/whiteboard-sync`.

- `server.js`: `/api` backend (Node, 127.0.0.1:3010). Boards are stored as JSON in `data/`, and images go to a private GitHub repo.
- `scene.js`: merges saves per element and keeps each board's journal (see "Live boards" below).
- `server-sync.js`, `boards.html`, `sw.js`: copied into the web root by `deploy-extras.sh`.
- `rebuild.sh`: builds this fork with `vite.selfhost.config.mts` and deploys it to `/var/www/excalidraw`.

## Image storage

`server.js` reads these from its environment:

- `GITHUB_TOKEN` (required): a fine-grained PAT with Contents read/write on the images repo.
- `GITHUB_REPO`: default `thefranciscook/whiteboard-images`.
- `GITHUB_BRANCH`: default `main`.

Without a token, `/api/files` answers 503 and images stay only in the browser.

## Live boards

A board can be open in several places at once: your browser tabs and devices, and Claude through the connector. Each save is merged per element on the server (`scene.js`), the way Excalidraw's collaboration rooms merge: an element's newer version wins, and deletions are kept as tombstones, so no side loses the other's work.

- `server-sync.js` pushes the open scene every 2 seconds (deleted elements included, through `window.wbGetElements` in `excalidraw-app/App.tsx`), and checks `GET /api/boards/<id>/head` every 2 seconds. When the board's `rev` moved on, it fetches the board and merges it into the open scene with `window.wbMergeRemote`. What you're editing stays as it is, and others' changes don't go into your undo history.
- Each save that changes something gets the board's next `rev` and a line in `data/journal/<id>.jsonl`: `{rev, at, author, changes: [{id, type, op, version}]}`. The author is `human` for saves from the browser and `claude` for the connector. That's the board's history: who changed which element when. The 10-minute snapshots in `data/history/` are still there to restore from.
- Deleted elements are dropped from a board a month after their deletion.

The tests (`whiteboard-sync/test/`) run with the rest of the repo's: `yarn vitest run whiteboard-sync`.

## Claude connector

`mcp/` adds a connector, so Claude can look at your boards and draw on them in claude.ai, the Claude desktop and mobile apps, and Claude Code. Paste a frame link (right-click the frame, then "Copy link to object"), or name it: "use the Hero frame on the Inspiration board", or "draw our login flow on a new board".

Claude gets these tools:

- `list_boards`: board names, ids and links.
- `list_frames`: a board's frames.
- `get_frame`: the frame rendered as an image, plus its text in reading order, links, exact hex colors, image ids, and its shapes, arrows and frames with their ids. It renders the whole board when no frame is given.
- `get_image`: one original image at full resolution.
- `get_changes`: what changed since Claude last looked, and who changed it (you, or Claude in another chat), with the changed elements outlined on a picture.
- `create_board`: a new, empty board.
- `add_elements`: draws shapes, text, arrows, sticky notes and frames, given as Excalidraw element skeletons. Arrows bind to the elements they connect, labels sit inside their shapes, and positions are relative to the frame an element is in.
- `update_elements`: moves, resizes, restyles and relabels elements by id. Bound arrows follow, and a frame takes its contents along.
- `delete_elements`: deletes elements with their labels (a frame with its contents).

The drawing tools answer with a fresh picture, so Claude can look at what it drew and fix it. They build the elements with Excalidraw's own code in headless Chromium (`render/ops.html`), so text is measured with the real fonts, and then merge them into the board as `claude`. Your open tab picks them up within about 2 seconds. Every tool's answer also lists what you changed since Claude's last look: the connector keeps the board `rev` Claude last saw in `data/claude-cursor.json` and reads the journal from there. One cursor is shared by all chats, so edits from another chat show up as "Claude, in another chat".

In claude.ai and the Claude desktop app, `get_frame`, `get_image`, `get_changes` and the drawing tools also show their picture to you in the chat, with an "Open in whiteboard" button (`mcp/view.js`, an [MCP App](https://claude.com/docs/connectors/building/mcp-apps/quickstart)). Other clients, such as Claude Code, get the same results without the view. The view needs the `@modelcontextprotocol/ext-apps` package from `npm install`; without it the server logs a warning and the tools work as before.

The connector is a remote MCP server at `https://whiteboard.supa.company/mcp`. It has its own OAuth login, which asks for `MCP_USER` and `MCP_PASSWORD` once, when you connect. It writes to boards only through the drawing tools above.

### Server setup (once)

1. Copy the updated `whiteboard-sync` folder (`server.js`, `mcp/`, `package.json`) to `/home/ubuntu/whiteboard-sync`, then install Playwright and Chromium, which render the frames:

   ```
   cd /home/ubuntu/whiteboard-sync && npm install --omit=dev
   sudo npx playwright install-deps chromium && npx playwright install chromium
   ```

2. Add the connector login to the server's environment, next to `GITHUB_TOKEN`:

   ```
   MCP_USER=<a username>
   MCP_PASSWORD=<a long password>
   ```

   These are optional:

   - `PUBLIC_URL`, default `https://whiteboard.supa.company`.
   - `WHITEBOARD_RENDER_DIR`, default `/var/www/excalidraw/render`.

3. Let the connector's paths past the site login in Caddy. Caddy runs login directives such as `forward_auth` and `basic_auth` before `handle` blocks, so move the existing login and site directives into a second `handle`:

   ```
   whiteboard.supa.company {
   	@claude path /mcp /oauth/* /.well-known/oauth-authorization-server /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/* /.well-known/openid-configuration
   	handle @claude {
   		reverse_proxy 127.0.0.1:3010
   	}
   	handle {
   		# the existing login, /api proxy and file_server go here, unchanged
   	}
   }
   ```

   `/api` stays behind the site login. The connector paths check their own tokens.

4. Run `rebuild.sh`, which also builds the render and edit pages into `/var/www/excalidraw/render/`. Then restart `server.js`. After an update that adds tools, reconnect the connector in Claude (or start a new chat) so it picks them up.

5. Check it. This should answer 401 with a `WWW-Authenticate` header:

   ```
   curl -i -X POST https://whiteboard.supa.company/mcp
   ```

Without Playwright or the render page, `get_frame` still works, but it sends the text and original images without a rendered picture. Drawing needs both Playwright and `render/ops.html`. The server log says what is missing.

### Connect Claude (once per account)

- **claude.ai and the apps**: Settings, Connectors, Add custom connector. Enter `https://whiteboard.supa.company/mcp`, click Connect, and log in with `MCP_USER`/`MCP_PASSWORD`. Then turn the connector on in a chat's tools menu. Connectors added on claude.ai also show up in the desktop and mobile apps.
- **Claude Code**:

  ```
  claude mcp add --transport http whiteboard https://whiteboard.supa.company/mcp
  ```

  Then run `/mcp` in Claude Code to log in.
- **ChatGPT** (developer mode): Settings, Apps, Create app. Enter `https://whiteboard.supa.company/mcp` as the server URL, choose OAuth, and log in with `MCP_USER`/`MCP_PASSWORD`. The login only sends you back to Claude, ChatGPT (`chatgpt.com`, `openai.com`) or loopback addresses.

Tokens last an hour and refresh automatically for 90 days. To log every client out, delete `data/oauth.json` and restart `server.js`.
