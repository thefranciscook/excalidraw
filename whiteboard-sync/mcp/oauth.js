// Minimal OAuth 2.1 authorization server for the Claude connector:
// dynamic client registration, authorization code + PKCE (S256), rotating
// refresh tokens. One user, whose login is MCP_USER / MCP_PASSWORD.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   resource metadata
//   GET  /.well-known/oauth-authorization-server       server metadata
//   POST /oauth/register                               register a client (RFC 7591)
//   GET  /oauth/authorize                              login page
//   POST /oauth/authorize                              check login, redirect with a code
//   POST /oauth/token                                  code or refresh token -> tokens
//
// Tokens are stored as SHA-256 hashes in data/oauth.json.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 100;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 10;
const SCOPE = "whiteboard";

// Where clients may send the user back to: Claude's callback, and local
// clients (Claude Code, MCP Inspector) on loopback.
const isAllowedRedirect = (uri) => {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") {
    return ["claude.ai", "claude.com"].includes(u.hostname) || u.hostname.endsWith(".claude.ai") || u.hostname.endsWith(".claude.com");
  }
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
};

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
const hashToken = (t) => sha256(t).toString("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

module.exports = function createOAuth({ dataDir, publicUrl, user, password }) {
  const STORE_FILE = path.join(dataDir, "oauth.json");
  const resource = `${publicUrl}/mcp`;
  const enabled = Boolean(user && password);

  let store = { clients: {}, tokens: {} };
  try {
    store = { ...store, ...JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) };
  } catch {
    // first run
  }
  const save = () => {
    const now = Date.now();
    for (const [hash, t] of Object.entries(store.tokens)) {
      if (t.expiresAt < now) delete store.tokens[hash];
    }
    const tmp = STORE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    fs.renameSync(tmp, STORE_FILE);
  };

  const codes = new Map(); // code hash -> grant, in memory only
  const failedLogins = new Map(); // ip -> [timestamps]

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    });
    res.end(JSON.stringify(body));
  };
  const oauthError = (res, status, error, description) =>
    json(res, status, { error, error_description: description });

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > 64 * 1024) {
          reject(new Error("body too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const type = req.headers["content-type"] || "";
        try {
          resolve(type.includes("application/json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw)));
        } catch {
          resolve(null);
        }
      });
      req.on("error", reject);
    });

  const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  const tooManyFailures = (ip) => {
    const recent = (failedLogins.get(ip) || []).filter((t) => Date.now() - t < LOGIN_WINDOW_MS);
    failedLogins.set(ip, recent);
    return recent.length >= MAX_FAILED_LOGINS;
  };

  // --- metadata ------------------------------------------------------------

  const resourceMetadata = () => ({
    resource,
    authorization_servers: [publicUrl],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Whiteboard",
  });

  const serverMetadata = () => ({
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    registration_endpoint: `${publicUrl}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [SCOPE],
  });

  // --- registration --------------------------------------------------------

  const register = async (req, res) => {
    const body = await readBody(req);
    const uris = body && body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || !uris.every((u) => typeof u === "string" && isAllowedRedirect(u))) {
      return oauthError(res, 400, "invalid_redirect_uri", "Only Claude's callback and loopback redirect URIs are allowed.");
    }
    const authMethod = ["client_secret_post", "client_secret_basic"].includes(body.token_endpoint_auth_method)
      ? body.token_endpoint_auth_method
      : "none";
    const clientId = randomToken();
    const secret = authMethod === "none" ? null : randomToken();
    const now = Date.now();

    // registration is open (RFC 7591), so keep the list bounded
    const ids = Object.keys(store.clients);
    if (ids.length >= MAX_CLIENTS) {
      ids
        .sort((a, b) => (store.clients[a].lastUsedAt || 0) - (store.clients[b].lastUsedAt || 0))
        .slice(0, ids.length - MAX_CLIENTS + 1)
        .forEach((id) => delete store.clients[id]);
    }
    store.clients[clientId] = {
      redirectUris: uris,
      name: String(body.client_name || "").slice(0, 100),
      authMethod,
      secretHash: secret && hashToken(secret),
      createdAt: now,
    };
    save();
    json(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: store.clients[clientId].name || undefined,
      redirect_uris: uris,
      token_endpoint_auth_method: authMethod,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  };

  // --- authorization -------------------------------------------------------

  const AUTH_PARAMS = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"];

  const loginPage = (res, params, { error, status = 200 } = {}) => {
    const client = store.clients[params.client_id];
    const hidden = AUTH_PARAMS.filter((k) => params[k] != null)
      .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k])}">`)
      .join("");
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect to Whiteboard</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px system-ui, sans-serif; background: Canvas; color: CanvasText; }
  form { display: grid; gap: 12px; width: min(340px, calc(100vw - 32px)); }
  h1 { font-size: 1.25rem; margin: 0; }
  p { margin: 0; font-size: .9rem; opacity: .8; }
  label { display: grid; gap: 4px; font-size: .875rem; }
  input, button { font: inherit; padding: 10px 12px; border-radius: 8px; border: 1px solid #8888; }
  button { cursor: pointer; background: #6965db; color: #fff; border: 0; }
  button[value=deny] { background: transparent; color: inherit; border: 1px solid #8888; }
  .err { color: #d33; }
</style></head><body>
<form method="post" action="/oauth/authorize">
  <h1>Connect to Whiteboard</h1>
  <p><strong>${escapeHtml((client && client.name) || "An app")}</strong> wants to read your boards. It can't change them.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  ${hidden}
  <label>Username <input name="username" autocomplete="username" required autofocus></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit" name="decision" value="allow">Allow read access</button>
  <button type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
</form></body></html>`);
  };

  const errorPage = (res, status, message) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end(message);
  };

  // Checks the request against its client. Errors that can't be sent back to
  // the client (unknown client, bad redirect URI) are shown to the user.
  const checkAuthRequest = (params) => {
    const client = store.clients[params.client_id];
    if (!client) return { fatal: "Unknown client. Remove the connector and add it again." };
    if (!client.redirectUris.includes(params.redirect_uri)) return { fatal: "This redirect URI isn't registered for the client." };
    if (params.response_type !== "code") return { error: "unsupported_response_type" };
    if (!params.code_challenge || params.code_challenge_method !== "S256") return { error: "invalid_request", description: "PKCE with S256 is required." };
    if (params.resource && params.resource.replace(/\/+$/, "") !== resource) return { error: "invalid_target" };
    return { client };
  };

  const redirectBack = (res, params, query) => {
    const target = new URL(params.redirect_uri);
    for (const [k, v] of Object.entries({ ...query, state: params.state, iss: publicUrl })) {
      if (v != null) target.searchParams.set(k, v);
    }
    res.writeHead(302, { Location: target.href, "Cache-Control": "no-store" });
    res.end();
  };

  const authorize = async (req, res, url) => {
    if (!enabled) return errorPage(res, 503, "The connector isn't set up: MCP_USER and MCP_PASSWORD are not set on the server.");
    const params = req.method === "POST" ? await readBody(req) : Object.fromEntries(url.searchParams);
    if (!params) return errorPage(res, 400, "Bad request.");
    const check = checkAuthRequest(params);
    if (check.fatal) return errorPage(res, 400, check.fatal);
    if (check.error) return redirectBack(res, params, { error: check.error, error_description: check.description });

    if (req.method !== "POST") return loginPage(res, params);
    if (params.decision === "deny") return redirectBack(res, params, { error: "access_denied" });

    const ip = clientIp(req);
    if (tooManyFailures(ip)) return loginPage(res, params, { status: 429, error: "Too many attempts. Try again in 15 minutes." });
    // compare both, always, so timing doesn't tell which one was wrong
    const userOk = safeEqual(params.username || "", user);
    const passOk = safeEqual(params.password || "", password);
    if (!(userOk && passOk)) {
      failedLogins.get(ip).push(Date.now());
      return loginPage(res, params, { status: 401, error: "Wrong username or password." });
    }

    const code = randomToken();
    codes.set(hashToken(code), {
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    redirectBack(res, params, { code });
  };

  // --- tokens --------------------------------------------------------------

  const issueTokens = (clientId) => {
    const access = randomToken();
    const refresh = randomToken();
    const now = Date.now();
    store.tokens[hashToken(access)] = { type: "access", clientId, expiresAt: now + ACCESS_TTL_S * 1000 };
    store.tokens[hashToken(refresh)] = { type: "refresh", clientId, expiresAt: now + REFRESH_TTL_MS };
    if (store.clients[clientId]) store.clients[clientId].lastUsedAt = now;
    save();
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
  };

  // client authentication: public clients send only client_id
  const authenticateClient = (req, body) => {
    let clientId = body.client_id;
    let secret = body.client_secret;
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization || "");
    if (basic) {
      const [id, sec] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
      clientId = decodeURIComponent(id || "");
      secret = decodeURIComponent(sec || "");
    }
    const client = store.clients[clientId];
    if (!client) return null;
    if (client.secretHash && !(secret && safeEqual(hashToken(secret), client.secretHash))) return null;
    return { clientId, client };
  };

  const token = async (req, res) => {
    const body = await readBody(req);
    if (!body) return oauthError(res, 400, "invalid_request", "Unreadable body.");
    const auth = authenticateClient(req, body);
    if (!auth) return oauthError(res, 401, "invalid_client", "Unknown client or bad client credentials.");

    if (body.grant_type === "authorization_code") {
      const key = hashToken(String(body.code || ""));
      const grant = codes.get(key);
      codes.delete(key); // single use, even when the exchange fails
      if (!grant || grant.expiresAt < Date.now() || grant.clientId !== auth.clientId) {
        return oauthError(res, 400, "invalid_grant", "The code is invalid or expired.");
      }
      if (body.redirect_uri && body.redirect_uri !== grant.redirectUri) {
        return oauthError(res, 400, "invalid_grant", "redirect_uri doesn't match.");
      }
      const challenge = sha256(String(body.code_verifier || "")).toString("base64url");
      if (!safeEqual(challenge, grant.codeChallenge)) {
        return oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
      }
      return json(res, 200, issueTokens(auth.clientId));
    }

    if (body.grant_type === "refresh_token") {
      const key = hashToken(String(body.refresh_token || ""));
      const stored = store.tokens[key];
      if (!stored || stored.type !== "refresh" || stored.expiresAt < Date.now() || stored.clientId !== auth.clientId) {
        return oauthError(res, 400, "invalid_grant", "The refresh token is invalid or expired.");
      }
      delete store.tokens[key]; // rotate
      return json(res, 200, issueTokens(auth.clientId));
    }

    oauthError(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  };

  // --- bearer check for /mcp -------------------------------------------------

  const challenge = (error) =>
    `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"${error ? `, error="${error}"` : ""}`;

  // true when the request carries a valid access token; otherwise answers 401
  const requireToken = (req, res) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
    const stored = m && store.tokens[hashToken(m[1])];
    if (stored && stored.type === "access" && stored.expiresAt > Date.now()) return true;
    json(res, 401, { error: m ? "invalid_token" : "unauthorized" }, {
      "WWW-Authenticate": challenge(m ? "invalid_token" : null),
      "Access-Control-Expose-Headers": "WWW-Authenticate",
    });
    return false;
  };

  const handle = async (req, res, url) => {
    const p = url.pathname;
    if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") {
      return json(res, 200, resourceMetadata());
    }
    if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration") {
      return json(res, 200, serverMetadata());
    }
    if (p === "/oauth/register" && req.method === "POST") return register(req, res);
    if (p === "/oauth/authorize" && (req.method === "GET" || req.method === "POST")) return authorize(req, res, url);
    if (p === "/oauth/token" && req.method === "POST") return token(req, res);
    json(res, 404, { error: "not_found" });
  };

  return { handle, requireToken, enabled };
};
