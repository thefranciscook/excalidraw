# Guidelines

- For new DOM/browser API usage, use `app.ownerDocument` and `app.ownerWindow` instead of globals; without `app`, derive them from the mounted node's `ownerDocument` and its `defaultView`.
- When overriding properties of an existing type, prefer `Merge<Base, Overrides>` from `@excalidraw/common/utility-types` over `Omit<Base, keyof Overrides> & Overrides`.

# This repo is public

Anyone can read this repo and its whole git history. Everything sensitive stays on the VPS, never here.

- Never commit secrets: tokens (`GITHUB_TOKEN`), logins (`MCP_USER`, `MCP_PASSWORD`, the Caddy login), password hashes, private keys, or `.env` files with real values. Code reads them from the server's environment (`process.env`); docs name the variable and use a placeholder such as `<a long password>`.
- Never commit server data: `whiteboard-sync/data/` (boards, journals, share links, OAuth tokens), the contents of the private images repo, or real board ids, share tokens and personal contact details in examples, tests and fixtures.
- Keep the VPS's real config (the Caddyfile, service files, firewall rules) on the VPS. The README may show a redacted example.
- Keep `whiteboard-sync/.gitignore` covering anything new that is written at runtime or holds a secret.
- Before committing, check the diff for the above. A secret that was pushed is leaked even if a later commit removes it: say so, so it can be rotated.

# After every commit to master

The app is deployed by a separate agent on the VPS, which only knows what it's told. After every commit that lands on `master` (a direct push or a merged pull request), give the user a prompt to pass to that deploy agent, saying how to update the app for that commit.

- Put the prompt in the chat, in a code block the user can copy. Never commit it to the repo.
- Make it complete on its own: the commit on `master` to deploy, the steps in order (for example `rebuild.sh`, `npm install` in `whiteboard-sync` when its dependencies changed, restarting `server.js`), any new or changed environment variables by name, any Caddy change, and how to check that it worked.
- Say when a step isn't needed (a docs-only commit needs no deploy), rather than leaving the prompt out.
- Follow "This repo is public" in the prompt too: name variables and use placeholders, never real values.
