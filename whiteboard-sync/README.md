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
- Each save that changes something gets the board's next `rev` and a line in `data/journal/<id>.jsonl`: `{rev, at, author, changes: [{id, type, op, version}]}`. The author is `human` for saves from your browser, `claude` for the connector, and `guest` or `guest:<name>` for someone with an edit link. That's the board's history: who changed which element when. The 10-minute snapshots in `data/history/` are still there to restore from.
- Deleted elements are dropped from a board a month after their deletion.

## Messages on a board

An open board shows messages under the toolbar (`server-sync.js`), each with a close button:

- Image progress ("Loading images 3/10", "Uploading 2 images…", "Images saved") goes away on its own.
- Warnings about images (couldn't be saved on this device, couldn't be uploaded, never reached the server) stay until they're resolved or closed. A closed warning comes back when what it says changes, for example when more images are affected. "Never reached the server" stays closed across reloads, since there's nothing to do about it on that device.
- "Anna is on this board" shows while someone has the board open through an edit link.
- "Claude is drawing on this board…" (or "looking at") shows for 30 seconds after the connector last drew on or read the board. `GET /api/boards/<id>/head` says how long ago that was, in `claude: {drewAgo, lookedAgo}`. The server only remembers this in memory, for a minute.

The tests (`whiteboard-sync/test/`) run with the rest of the repo's: `yarn vitest run whiteboard-sync`.

## Sharing a board by link

The **Share** button at the top right of a board (or "Share board" in the menu, on phones) makes a link anyone can open without logging in: `https://whiteboard.supa.company/s/<token>`. A link is one of two kinds:

- **Can view.** People with the link can pan, zoom and follow links, and they see your changes within about 10 seconds. They can't edit, export or save the board.
- **Can edit.** People with the link get the editor on that board, and work on it together with you: their changes are saved every 2 seconds and reach your open board within about 2 seconds, and yours reach theirs. They can add images, export the board and save it as an image. They can't rename or delete the board, change its background, see your other boards, or make links.

Either way, the link doesn't open any other board or image.

- **Links can't be guessed.** The token is 24 random bytes (192 bits), unrelated to the board's id or name. The person never learns the board's id. Images are only served if they're on that board.
- **Links expire**: view links after 30 days and edit links after 7, unless you pick 1 day, 7 days, 30 days, 90 days or 1 year when you make one. You can turn a link off early in the same dialog. A board can have several links, each with its own expiry.
- **A link can have a name**, who it's for. Make one edit link per person: you can then turn off just theirs, and their name is on their changes.
- **When a link has expired or was turned off**, the page says so and asks the person to contact you for a new one. Set who they should contact with `SHARE_CONTACT` in the server's environment, e.g. `SHARE_CONTACT=Szilard (you@example.com)`. An email address in it becomes a mailto link. Without it, the page says to ask the person who shared the link.
- Links are kept in `data/shares.json`. Expired and turned-off links are forgotten 6 months after they ended (after that, the page just says the link doesn't work).

The page is `render/view.html`, built with the render pages by `rebuild.sh`. `server.js` serves it at `/s/<token>`, and the board's data at `/api/shared/<token>`.

### Editing through a link

An edit link is as good as a login to that one board, for anyone who gets hold of it, until it expires or you turn it off. Give it to people you trust.

- **Their saves are merged like yours** (`scene.js`): per element, the newer version wins, so you can both work on the board at once. There are no live cursors; you see each other's changes a couple of seconds after they're made.
- **You can see who's there and what they did.** While someone has the board open through an edit link, your board says "Anna is on this board" (by the link's name). Their changes are in the board's journal as `guest:Anna` (`guest` for a link without a name), and Claude's `get_changes` says they're by Anna, a guest.
- **To undo what someone did**, use the 10-minute snapshots in `data/history/<id>/`.
- **What you deleted stays deleted.** Someone with an edit link is told which elements were deleted, so the deletion reaches their open board, but not what was in them.
- **Images** they add go to the images repo like yours: up to 8 MB each, and at most 120 per link an hour. Without `GITHUB_TOKEN` they can't add images.
- **Nothing is kept in their browser.** If they close the tab while offline, changes that weren't saved yet are lost (the page asks before closing).

### Server setup (once)

Let the share paths past the site login in Caddy, next to the connector's (`/render/*` holds the viewer's scripts and fonts; the render pages there only read through `/api`, which stays behind the login):

```
whiteboard.supa.company {
	@claude path /mcp /oauth/* /.well-known/oauth-authorization-server /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/* /.well-known/openid-configuration
	handle @claude {
		reverse_proxy 127.0.0.1:3010
	}
	@shared path /s/* /api/shared/*
	handle @shared {
		reverse_proxy 127.0.0.1:3010
	}
	handle /render/* {
		root * /var/www/excalidraw
		file_server
	}
	handle {
		# the existing login, /api proxy and file_server go here, unchanged
	}
}
```

Then run `rebuild.sh`, add `SHARE_CONTACT` to the environment, and restart `server.js`. To check it: `curl -i https://whiteboard.supa.company/api/shared/x` (in a private window, or without your login cookie) should answer 404 with JSON, not the login page. Edit links need nothing more: they use the same paths.

## Claude connector

`mcp/` adds a connector, so Claude can look at your boards and draw on them in claude.ai, the Claude desktop and mobile apps, and Claude Code. Paste a frame link (right-click the frame, then "Copy link to object"), or name it: "use the Hero frame on the Inspiration board", or "draw our login flow on a new board".

Claude gets these tools:

- `list_boards`: board names, ids and links.
- `list_frames`: a board's frames.
- `get_frame`: the frame rendered as an image, plus its text in reading order, links, exact hex colors, image ids, and its shapes, arrows and frames with their ids. It renders the whole board when no frame is given.
- `get_image`: one original image at full resolution.
- `get_changes`: what changed since Claude last looked, and who changed it (you, or Claude in another chat), with the changed elements outlined on a picture.
- `create_board`: a new, empty board.
- `add_elements`: draws shapes, text, arrows, sticky notes and frames, given as Excalidraw element skeletons. Arrows bind to the elements they connect, labels sit inside their shapes, and positions are relative to the frame an element is in. For more precise, designed work it also takes:
  - corner radii (`cornerRadius`), any stroke width, every arrowhead Excalidraw has, curved lines through points, and closed lines filled as polygons;
  - `path`: SVG path data (Bézier curves, arcs), flattened into lines and filled polygons (`render/vector.ts`);
  - `svg`: SVG markup or a link to one, turned into editable rectangles, ellipses, lines, polygons and texts, grouped (`render/svgImport.ts`). Gradients become one color; filters, masks and bitmaps inside are left out;
  - `image`: a PNG, JPEG, GIF, WebP or SVG picture from a link, a data URL or SVG markup, or an image already on the board;
  - text: bold, italic and underline (all of it or parts), line height, any font size, all of Excalidraw's fonts, and fixed-width text boxes that wrap;
  - groups (`group`) and a place in the stacking order (`z`, `above`, `below`).
- `update_elements`: moves, resizes, restyles, relabels, regroups and restacks elements by id. A group id stands for all its elements, and moves them as one. Bound arrows follow, and a frame takes its contents along.
- `delete_elements`: deletes elements with their labels (a frame with its contents, a group id all of its elements).
- `arrange_elements`: aligns elements or groups (left, center, right, top, middle, bottom) and spaces them evenly or by a set gap, within the box around them or within their frame.

Images Claude adds are stored in the images repo like any other (so they need `GITHUB_TOKEN`), named by the SHA-1 of their bytes, before the elements showing them are saved. Links are fetched by the server: only public http(s) addresses (no loopback, private or link-local ones, checked again at each redirect), up to 8 MB, within 20 seconds (`mcp/media.js`).

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
