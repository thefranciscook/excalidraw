# whiteboard-sync

Self-hosting add-ons for whiteboard.supa.company. On the VPS they live in `/home/ubuntu/whiteboard-sync`.

- `server.js`: `/api` backend (Node, 127.0.0.1:3010). Boards are stored as JSON in `data/`, and images go to a private GitHub repo.
- `server-sync.js`, `boards.html`, `sw.js`: copied into the web root by `deploy-extras.sh`.
- `rebuild.sh`: builds this fork with `vite.selfhost.config.mts` and deploys it to `/var/www/excalidraw`.

## Image storage

`server.js` reads these from its environment:

- `GITHUB_TOKEN` (required): a fine-grained PAT with Contents read/write on the images repo.
- `GITHUB_REPO`: default `thefranciscook/whiteboard-images`.
- `GITHUB_BRANCH`: default `main`.

Without a token, `/api/files` answers 503 and images stay only in the browser.

## Claude connector

`mcp/` adds a read-only connector, so Claude can look at your boards in claude.ai, the Claude desktop and mobile apps, and Claude Code. Paste a frame link (right-click the frame, then "Copy link to object"), or name it: "use the Hero frame on the Inspiration board".

Claude gets these tools:

- `list_boards`: board names, ids and links.
- `list_frames`: a board's frames.
- `get_frame`: the frame rendered as an image, plus its text in reading order, links, exact hex colors and image ids. It renders the whole board when no frame is given.
- `get_image`: one original image at full resolution.

In claude.ai and the Claude desktop app, `get_frame` and `get_image` also show their picture to you in the chat, with an "Open in whiteboard" button (`mcp/view.js`, an [MCP App](https://claude.com/docs/connectors/building/mcp-apps/quickstart)). Other clients, such as Claude Code, get the same results without the view. The view needs the `@modelcontextprotocol/ext-apps` package from `npm install`; without it the server logs a warning and the tools work as before.

The connector is a remote MCP server at `https://whiteboard.supa.company/mcp`. It has its own OAuth login, which asks for `MCP_USER` and `MCP_PASSWORD` once, when you connect. It never writes to boards.

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

4. Run `rebuild.sh`, which also builds the render page into `/var/www/excalidraw/render/`. Then restart `server.js`.

5. Check it. This should answer 401 with a `WWW-Authenticate` header:

   ```
   curl -i -X POST https://whiteboard.supa.company/mcp
   ```

Without Playwright or the render page, `get_frame` still works, but it sends the text and original images without a rendered picture. The server log says which one is missing.

### Connect Claude (once per account)

- **claude.ai and the apps**: Settings, Connectors, Add custom connector. Enter `https://whiteboard.supa.company/mcp`, click Connect, and log in with `MCP_USER`/`MCP_PASSWORD`. Then turn the connector on in a chat's tools menu. Connectors added on claude.ai also show up in the desktop and mobile apps.
- **Claude Code**:

  ```
  claude mcp add --transport http whiteboard https://whiteboard.supa.company/mcp
  ```

  Then run `/mcp` in Claude Code to log in.

Tokens last an hour and refresh automatically for 90 days. To log every client out, delete `data/oauth.json` and restart `server.js`.
