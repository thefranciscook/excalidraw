# whiteboard-sync

Self-hosting add-ons for whiteboard.supa.company. On the VPS they live in
`/home/ubuntu/whiteboard-sync`.

- `server.js`: `/api` backend (Node, 127.0.0.1:3010). Boards are stored as JSON in `data/`, and images go to a private GitHub repo.
- `server-sync.js`, `boards.html`, `sw.js`: copied into the web root by `deploy-extras.sh`.
- `rebuild.sh`: builds this fork with `vite.selfhost.config.mts` and deploys it to `/var/www/excalidraw`.

## Image storage

`server.js` reads these from its environment:

- `GITHUB_TOKEN` (required): a fine-grained PAT with Contents read/write on the images repo.
- `GITHUB_REPO`: default `thefranciscook/whiteboard-images`.
- `GITHUB_BRANCH`: default `main`.

Without a token, `/api/files` answers 503 and images stay only in the browser.
