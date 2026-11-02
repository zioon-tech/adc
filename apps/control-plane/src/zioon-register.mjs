import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createAccountProvider, registerAccountRoutes } from "./zioon-provider.mjs";

export async function registerZioonAccounts(app, access, { consoleDirectory } = {}) {
  if (!process.env.ZIOON_ACCOUNT_ISSUER) return;
  const nativeAuth = access.accountAuthentication || access.authentication;
  const authority = nativeAuth.origin;
  const allowedOrigins = new Set([authority, access.origin,
    "https://runtime.zioon.tech", "https://memory.zioon.tech"]);
  const browserHeaders = (request) => {
    const headers = new Headers();
    if (request.headers.cookie) headers.set("cookie", request.headers.cookie);
    headers.set("x-adc-client-ip", request.ip);
    return headers;
  };
  const readSession = (request) => nativeAuth.auth.api.getSession({ headers: browserHeaders(request) });
  const base = "/api/v1/zioon";
  const shell = consoleDirectory
    ? await readFile(`${consoleDirectory}/.adc-app-shell.html`, "utf8") : "";
  const assets = (shell.match(/<script\b[^>]*src="\/assets\/[^"]+"[^>]*><\/script>|<link\b[^>]*(?:rel="stylesheet"|rel="modulepreload")[^>]*>/g) || []).join("\n");
  const accountShell = `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="zioon-account-app" content="true"><title>Zioon Account</title>
    <meta name="description" content="One account for all Zioon services.">
    <meta name="robots" content="noindex,nofollow"><link rel="icon" href="/account-favicon.svg">
    ${assets}</head><body><div id="root"></div></body></html>`;
  app.addHook("onRequest", async (request, reply) => {
    const url = new URL(request.url, access.origin);
    if (request.headers.host === new URL(access.origin).host && !request.headers.authorization) {
      const cookies = String(request.headers.cookie || "");
      const legacy = cookies.match(/(?:^|;\s*)(__Secure-adc\.session_token)=([^;]+)/);
      const common = /(?:^|;\s*)__Secure-zioon\.session_token=/.test(cookies);
      if (legacy && access.authentication.legacyAuth) {
        const session = common ? null : await access.authentication.legacyAuth?.api.getSession({
          headers: new Headers({ cookie: `${legacy[1]}=${legacy[2]}` })
        });
        const changes = [`${legacy[1]}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`];
        if (session?.session?.id) {
          // Signature is value-bound, not name-bound; only copy a cookie the SDK verified.
          changes.push(`__Secure-zioon.session_token=${legacy[2]}; Domain=${access.authentication.auth.options.advanced.crossSubDomainCookies.domain}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((new Date(session.session.expiresAt)-Date.now())/1000))}`);
          request.headers.cookie = `${cookies}; __Secure-zioon.session_token=${legacy[2]}`;
        }
        reply.header("set-cookie", changes);
      }
      if (["/login", "/register", "/forgot-password", "/reset-password"].includes(url.pathname)
        && ["GET", "HEAD"].includes(request.method)) {
        const params = new URLSearchParams(url.search);
        if (!(params.has("client_id") && params.has("sig"))) {
          const target = params.get("return_to") || "/app";
          const safe = target.startsWith("/") && !target.startsWith("//") && !/[\\\x00-\x20]/.test(target)
            ? target : "/app";
          params.set("return_to", `${base}/product-return?product=adc&path=${encodeURIComponent(safe)}`);
        }
        return reply.redirect(`${authority}${url.pathname}?${params}`);
      }
    }
    if (request.headers.host === new URL(authority).host && url.pathname === "/") {
      return reply.redirect("/account");
    }
    if (request.headers.host === new URL(authority).host && url.pathname === "/authorize") {
      return reply.redirect(`${access.origin}/authorize${url.search}`);
    }
    if (url.pathname === `${base}/session/status`) {
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: "invalid_origin" });
      if (origin) reply.header("access-control-allow-origin", origin).header("access-control-allow-credentials", "true").header("vary", "Origin");
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.statusCode !== 200 || !String(reply.getHeader("content-type") || "").includes("text/html")) return payload;
    const pathname = new URL(request.url, access.origin).pathname;
    if (request.headers.host === new URL(authority).host &&
      ["/account", "/app/settings", "/login", "/register", "/forgot-password", "/reset-password", "/cli-login"].includes(pathname)) {
      reply.header("cache-control", "no-store").header("referrer-policy", "same-origin");
      return accountShell;
    }
    if (request.headers.host === new URL(access.origin).host && (pathname === "/" || pathname.startsWith("/app"))) {
      const policy = String(reply.getHeader("content-security-policy") || "");
      if (policy) reply.header("content-security-policy", policy
        .replace("script-src 'self'", `script-src 'self' ${authority}`)
        .replace("connect-src 'self'", `connect-src 'self' ${authority}`));
      return String(payload).replace("</head>", `<script defer src="${authority}/session-client.js" data-product="adc"></script></head>`);
    }
    return payload;
  });
  app.get(`${base}/product-return`, async (request, reply) => {
    const path = String(request.query.path || "/app");
    if (request.query.product !== "adc" || !path.startsWith("/") || path.startsWith("//")
      || /[\\\x00-\x20]/.test(path) || /^\/(?:login|register|forgot-password|reset-password)(?:[/?]|$)/.test(path)) {
      return reply.code(400).send({ error: "invalid_return_to" });
    }
    if (!await readSession(request)) return reply.redirect(`${authority}/login?return_to=${encodeURIComponent(request.url)}`);
    return reply.redirect(`${access.origin}${path}`);
  });
  app.get(`${base}/session/status`, async (request, reply) => {
    const session = await readSession(request);
    reply.header("cache-control", "no-store");
    return session ? { authenticated: true, user: { id: session.user.id },
      generation: createHash("sha256").update(session.session.id).digest("hex") }
      : { authenticated: false };
  });
  app.post(`${base}/session/logout`, async (request, reply) => {
    if (request.headers.origin !== authority) return reply.code(403).send({ error: "invalid_origin" });
    const headers = browserHeaders(request);
    headers.set("origin", authority); headers.set("content-type", "application/json");
    const result = await nativeAuth.handle(new Request(`${authority}/api/auth/sign-out`, {
      method: "POST", headers, body: "{}"
    }));
    const input = request.body || {};
    // Old product sessions may predate the common cookie. Revoke their parent
    // without converting a scoped grant into a full account login.
    if (typeof input.token === "string" && typeof input.client_id === "string") {
      await access.identity.pool.query(`DELETE FROM adc_auth_sessions WHERE id IN
        (SELECT session_id FROM zioon_access_tokens WHERE hash=$1 AND client_id=$2 AND expires_at>$3)`,
      [createHash("sha256").update(input.token).digest("hex"), input.client_id, Date.now()]);
    }
    const cookies = result.headers.getSetCookie();
    if (cookies.length) reply.header("set-cookie", cookies);
    return reply.code(result.status).header("cache-control", "no-store").send({ loggedOut: result.ok });
  });
  app.get("/session-client.js", async (_request, reply) =>
    reply.type("application/javascript").header("cache-control", "no-cache")
      .send(await readFile(new URL("./zioon-session-client.js", import.meta.url), "utf8")));
  const { adapter } = await access.authentication.auth.$context;
  const provider = await createAccountProvider({
    pool: access.identity.pool,
    issuer: process.env.ZIOON_ACCOUNT_ISSUER,
    adcOrigin: access.origin,
    clients: JSON.parse(await readFile(process.env.ZIOON_ACCOUNT_CLIENTS_FILE, "utf8")),
    privateKey: await readFile(process.env.ZIOON_ACCOUNT_SIGNING_KEY_FILE, "utf8"),
    async getSession(sessionId) {
      const session = await adapter.findOne({ model: "session", where: [{ field: "id", value: sessionId }] });
      if (!session) return null;
      const user = await adapter.findOne({ model: "user", where: [{ field: "id", value: session.userId }] });
      return user ? { session, user } : null;
    }
  });
  registerAccountRoutes(app, provider, {
    nativeAuth,
    authenticate: (request) => access.authenticate(request),
    readSession
  });
}
