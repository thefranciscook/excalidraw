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

## Boards in Claude Code

The `whiteboard` skill lets Claude Code look at a board or one of its frames while you work in another repo, such as a website. Paste a frame link (right-click the frame, then "Copy link to object"), or name it: "use the Hero frame on the Inspiration board".

Claude runs `claude-plugin/skills/whiteboard/whiteboard.mjs`, which reads the board through `/api` and never writes. It gets:

- the frame rendered to PNG by `render/render.html`, using this fork's `exportScene`,
- the original images in the frame,
- the frame's text in reading order, links, embeds and hex colors.

### Server

`rebuild.sh` builds the render page into `/var/www/excalidraw/render/`. It sits behind the same Caddy login and only issues GET requests. Run `rebuild.sh` once to deploy it. Until then, Claude still gets the images and text, without the composite PNG.

### Login

The site uses its login form, so the script logs in with these variables and caches the session cookie in `~/.cache/whiteboard/`:

- `WHITEBOARD_USER` and `WHITEBOARD_PASSWORD`, or `WHITEBOARD_COOKIE` with a ready `name=value` session cookie.
- `WHITEBOARD_URL`, default `https://whiteboard.supa.company`.

### Install on your computer (Claude Code CLI or desktop)

```
/plugin marketplace add thefranciscook/excalidraw
/plugin install whiteboard@supa
```

Export `WHITEBOARD_USER` and `WHITEBOARD_PASSWORD` in your shell profile. For the rendered PNG, Playwright with Chromium must be installed:

```
npm i -g playwright && npx playwright install chromium
```

Without it, you still get the images and text. Check the setup with this command:

```
node ~/.claude/plugins/marketplaces/supa/whiteboard-sync/claude-plugin/skills/whiteboard/whiteboard.mjs check
```

The path can differ between Claude Code versions. You can also ask Claude to "check the whiteboard setup".

### Install for Claude Code on the web

Cloud sessions don't load plugins, but they do load skills committed to the repo. Copy `claude-plugin/skills/whiteboard/` into the website repo as `.claude/skills/whiteboard/` and commit it. Then, in that repo's cloud environment settings:

- Allow the host `whiteboard.supa.company` in the network settings.
- Add `WHITEBOARD_USER` and `WHITEBOARD_PASSWORD` as environment variables. These are stored in plain text on the environment, so use a personal environment.

Playwright and Chromium are already installed in cloud sessions.
