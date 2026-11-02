import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const challenge = (value) => createHash("sha256").update(value).digest("base64url");
const secret = () => randomBytes(32).toString("base64url");
const error = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const scopes = new Set(["openid", "profile", "email", "memory.read", "memory.write", "zion.api"]);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const escape = (value) => String(value).replace(/[&<>"']/g, (char) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export const ACCOUNT_SCHEMA = `
CREATE TABLE IF NOT EXISTS zioon_login_codes (
  hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL, nonce TEXT NOT NULL, scopes TEXT NOT NULL,
  session_id TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS zioon_access_tokens (
  hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, scopes TEXT NOT NULL,
  session_id TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS zioon_device_flows (
  hash TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, client_id TEXT NOT NULL,
  scopes TEXT NOT NULL, session_id TEXT, denied BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at BIGINT NOT NULL, next_poll_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS zioon_auth_rate_limits (
  hash TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS zioon_access_expiry ON zioon_access_tokens(expires_at);
`;

/** The shared account directory is authoritative. Only a live account session can issue codes
 * or redeem tokens; neither passwords nor a second user directory are stored. */
export async function createAccountProvider({
  pool, issuer, adcOrigin, clients, privateKey, getSession, now = Date.now
}) {
  const authority = new URL(issuer);
  const adc = new URL(adcOrigin);
  for (const url of [authority, adc]) {
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password
      || (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname))) {
      throw new Error("Account endpoints require HTTPS origins");
    }
  }
  const registered = new Map(clients.map((client) => {
    if (!client.id || !client.redirectUris?.length) throw new Error("Register exact account callbacks");
    for (const value of client.redirectUris) {
      const uri = new URL(value);
      if (uri.username || uri.password || uri.hash || uri.search
        || (uri.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(uri.hostname))) {
        throw new Error("Invalid registered callback");
      }
    }
    if (client.loginUri) {
      const login = new URL(client.loginUri);
      if (login.search || login.hash || login.username || login.password
        || login.origin !== new URL(client.redirectUris[0]).origin || login.pathname !== "/account/login") {
        throw new Error("Invalid registered login page");
      }
    }
    return [client.id, client];
  }));
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error("Account signing key must be RSA with at least 2048 bits");
  }
  const jwk = createPublicKey(key).export({ format: "jwk" });
  const kid = digest(JSON.stringify(jwk)).slice(0, 24);
  await pool.query(ACCOUNT_SCHEMA);
  function client(input) {
    const value = registered.get(input.client_id);
    if (!value) throw error("invalid_client");
    return value;
  }
  function scope(input, value) {
    const requested = String(input.scope || "openid profile email").split(" ").filter(Boolean);
    if (!requested.includes("openid") || requested.some((item) =>
      !scopes.has(item) || !value.scopes.includes(item))) throw error("invalid_scope");
    return [...new Set(requested)].join(" ");
  }
  function authorization(input) {
    const value = client(input);
    if (input.response_type !== "code" || !value.redirectUris.includes(input.redirect_uri)
      || input.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge || "")
      || !/^[A-Za-z0-9_.~-]{16,256}$/.test(input.state || "")
      || !/^[A-Za-z0-9_.~-]{16,256}$/.test(input.nonce || "")) throw error("invalid_request");
    return { value, granted: scope(input, value) };
  }
  async function active(sessionId) {
    const result = await getSession(sessionId);
    if (!result?.user?.id || !result.session?.id || result.session.id !== sessionId
      || Number(new Date(result.session.expiresAt)) <= now()) throw error("invalid_grant", 401);
    return result;
  }
  async function issue(sessionId, clientId, granted, nonce = "") {
    const session = await active(sessionId);
    const expiresAt = Math.min(now() + 7 * 86_400_000, Number(new Date(session.session.expiresAt)));
    const accessToken = `zioon_at_${secret()}`;
    await pool.query(`INSERT INTO zioon_access_tokens
      (hash,client_id,scopes,session_id,expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [digest(accessToken), clientId, granted, sessionId, expiresAt]);
    const body = encode({
      iss: authority.origin, sub: session.user.id, aud: clientId,
      iat: Math.floor(now() / 1000), exp: Math.floor(Math.min(expiresAt, now() + 300_000) / 1000),
      ...(nonce ? { nonce } : {}),
      ...(granted.includes("profile") ? { name: session.user.name } : {}),
      ...(granted.includes("email") ? {
        email: session.user.email, email_verified: session.user.emailVerified === true
      } : {})
    });
    const message = `${encode({ alg: "RS256", typ: "JWT", kid })}.${body}`;
    return { access_token: accessToken, token_type: "Bearer", expires_in: Math.floor((expiresAt - now()) / 1000),
      scope: granted, id_token: `${message}.${sign("RSA-SHA256", Buffer.from(message), key).toString("base64url")}` };
  }
  async function cleanup() {
    for (const table of ["zioon_login_codes", "zioon_access_tokens", "zioon_device_flows", "zioon_auth_rate_limits"]) {
      await pool.query(`DELETE FROM ${table} WHERE expires_at <= $1`, [now()]);
    }
  }
  let lastCleanup = 0;
  return {
    issuer: authority.origin,
    adcOrigin: authority.origin,
    metadata: {
      issuer: authority.origin,
      authorization_endpoint: `${authority.origin}/api/v1/zioon/authorize`,
      token_endpoint: `${authority.origin}/token`,
      userinfo_endpoint: `${authority.origin}/userinfo`,
      jwks_uri: `${authority.origin}/jwks`,
      revocation_endpoint: `${authority.origin}/revoke`,
      device_authorization_endpoint: `${authority.origin}/device_authorization`,
      response_types_supported: ["code"], grant_types_supported: [
        "authorization_code", "urn:ietf:params:oauth:grant-type:device_code"
      ],
      subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [...scopes]
    },
    jwks: { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] },
    validateAuthorization: authorization,
    loginContext(input) {
      const value = input.response_type ? authorization(input).value : client(input);
      if (!input.response_type || value.showReturnLink === false) {
        return { name: value.name || value.id };
      }
      const cancel = new URL(input.redirect_uri);
      cancel.search = new URLSearchParams({
        error: "access_denied", state: input.state, iss: authority.origin
      }).toString();
      return { name: value.name || value.id, cancelUrl: cancel.href };
    },
    loginUri(clientId) {
      const value = client({ client_id: clientId });
      if (!value.loginUri) throw error("invalid_client");
      return value.loginUri;
    },
    async authorize(input, sessionId) {
      const { value, granted } = authorization(input);
      await active(sessionId);
      const code = secret();
      await pool.query(`INSERT INTO zioon_login_codes
        (hash,client_id,redirect_uri,challenge,nonce,scopes,session_id,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [digest(code), value.id, input.redirect_uri, input.code_challenge, input.nonce, granted, sessionId, now() + 60_000]);
      const redirect = new URL(input.redirect_uri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", input.state);
      redirect.searchParams.set("iss", authority.origin);
      return redirect.href;
    },
    async token(input) {
      const value = client(input);
      if (input.grant_type === "authorization_code") {
        if (!value.redirectUris.includes(input.redirect_uri)
          || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier || "")) throw error("invalid_grant");
        const result = await pool.query(`DELETE FROM zioon_login_codes
          WHERE hash=$1 AND client_id=$2 AND redirect_uri=$3 AND challenge=$4 AND expires_at>$5 RETURNING *`,
        [digest(String(input.code || "")), value.id, input.redirect_uri, challenge(input.code_verifier), now()]);
        const code = result.rows[0];
        if (!code) throw error("invalid_grant");
        return issue(code.session_id, value.id, code.scopes, code.nonce);
      }
      if (input.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") throw error("unsupported_grant_type");
      const result = await pool.query(`UPDATE zioon_device_flows SET next_poll_at=$1
        WHERE hash=$2 AND client_id=$3 AND expires_at>$4 AND next_poll_at<=$4 RETURNING *`,
      [now() + 5000, digest(String(input.device_code || "")), value.id, now()]);
      const flow = result.rows[0];
      if (!flow) {
        const current = await pool.query("SELECT expires_at FROM zioon_device_flows WHERE hash=$1 AND client_id=$2",
          [digest(String(input.device_code || "")), value.id]);
        throw error(Number(current.rows[0]?.expires_at || 0) > now() ? "slow_down" : "expired_token");
      }
      if (flow.denied) throw error("access_denied");
      if (!flow.session_id) throw error("authorization_pending");
      const consumed = await pool.query("DELETE FROM zioon_device_flows WHERE hash=$1 RETURNING hash", [flow.hash]);
      if (!consumed.rowCount) throw error("invalid_grant");
      return issue(flow.session_id, value.id, flow.scopes);
    },
    async device(input) {
      const value = client(input);
      const granted = scope(input, value);
      const deviceCode = secret();
      const userCode = randomBytes(6).toString("hex").toUpperCase();
      await pool.query(`INSERT INTO zioon_device_flows
        (hash,user_code,client_id,scopes,expires_at,next_poll_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [digest(deviceCode), userCode, value.id, granted, now() + 600_000, now()]);
      return { device_code: deviceCode, user_code: userCode, expires_in: 600, interval: 5,
        verification_uri: `${authority.origin}/api/v1/zioon/verify`,
        verification_uri_complete: `${authority.origin}/api/v1/zioon/verify?user_code=${userCode}` };
    },
    async inspectDevice(userCode) {
      const result = await pool.query(`SELECT client_id FROM zioon_device_flows
        WHERE user_code=$1 AND expires_at>$2 AND session_id IS NULL AND denied=FALSE`, [userCode, now()]);
      const flow = result.rows[0];
      if (!flow) throw error("expired_token");
      return registered.get(flow.client_id);
    },
    async approve(userCode, sessionId, denied = false) {
      await active(sessionId);
      const result = await pool.query(`UPDATE zioon_device_flows SET session_id=$1,denied=$2
        WHERE user_code=$3 AND expires_at>$4 AND session_id IS NULL AND denied=FALSE RETURNING hash`,
      [sessionId, denied, userCode, now()]);
      if (!result.rowCount) throw error("expired_token");
    },
    async approveWithToken(userCode, token, denied = false) {
      const result = await pool.query(`SELECT t.session_id,t.scopes,d.scopes AS requested_scopes FROM zioon_access_tokens t
        JOIN zioon_device_flows d ON d.client_id=t.client_id
        WHERE t.hash=$1 AND t.expires_at>$2 AND d.user_code=$3 AND d.expires_at>$2`,
      [digest(token), now(), userCode]);
      const grant = result.rows[0];
      if (!grant || !grant.requested_scopes.split(" ").every((item) => grant.scopes.split(" ").includes(item))) {
        throw error("invalid_token", 401);
      }
      await this.approve(userCode, grant.session_id, denied);
    },
    async userinfo(token, browserSessionId = "") {
      const result = await pool.query("SELECT * FROM zioon_access_tokens WHERE hash=$1 AND expires_at>$2",
        [digest(token), now()]);
      const grant = result.rows[0];
      if (!grant || (browserSessionId && grant.session_id !== browserSessionId)) throw error("invalid_token", 401);
      const { user } = await active(grant.session_id);
      return { sub: user.id, iss: authority.origin, aud: grant.client_id, scope: grant.scopes,
        ...(grant.scopes.includes("profile") ? { name: user.name } : {}),
        ...(grant.scopes.includes("email") ? { email: user.email, email_verified: user.emailVerified === true } : {}) };
    },
    async revoke(token, clientId) {
      if (!registered.has(clientId)) throw error("invalid_client");
      await pool.query("DELETE FROM zioon_access_tokens WHERE hash=$1 AND client_id=$2", [digest(token), clientId]);
    },
    async sweep() {
      if (now() - lastCleanup > 60_000) { lastCleanup = now(); await cleanup(); }
    },
    async limit(ip) {
      const bucket = digest(`${ip}:${Math.floor(now() / 60_000)}`);
      const result = await pool.query(`INSERT INTO zioon_auth_rate_limits (hash,count,expires_at)
        VALUES ($1,1,$2) ON CONFLICT(hash) DO UPDATE SET count=zioon_auth_rate_limits.count+1 RETURNING count`,
      [bucket, now() + 120_000]);
      if (result.rows[0].count > 60) throw error("too_many_login_requests", 429);
    }
  };
}

/** Mount on ADC. The auth hostname proxies ONLY this namespace. */
export function registerAccountRoutes(app, provider, { authenticate, readSession, nativeAuth }) {
  const base = "/api/v1/zioon";
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith(base)) {
      await provider.sweep();
      if (request.url.startsWith(`${base}/authorize`) || request.url.startsWith(`${base}/verify`)
        || request.url.startsWith(`${base}/device_authorization`) || request.url.startsWith(`${base}/token`)
        || request.url.startsWith(`${base}/social`) || request.url.startsWith(`${base}/device-`)) {
        try { await provider.limit(request.ip); }
        catch (value) {
          if (!value.statusCode) throw value;
          return reply.code(value.statusCode).header("retry-after", "60").send({ error: value.code });
        }
      }
    }
  });
  async function run(reply, action) {
    reply.header("cache-control", "no-store");
    try { return await action(); }
    catch (value) {
      if (!value.statusCode) throw value;
      return reply.code(value.statusCode).send({ error: value.code });
    }
  }
  app.get(`${base}/.well-known/openid-configuration`, async () => provider.metadata);
  app.get(`${base}/jwks`, async () => provider.jwks);
  app.get(`${base}/login-context`, (request, reply) =>
    run(reply, async () => provider.loginContext(request.query)));
  app.get(`${base}/restart`, (request, reply) =>
    run(reply, async () => reply.redirect(provider.loginUri(request.query.client_id))));
  for (const method of ["token", "device"]) {
    app.post(`${base}/${method === "device" ? "device_authorization" : method}`, async (request, reply) =>
      run(reply, () => provider[method](typeof request.body === "string"
        ? Object.fromEntries(new URLSearchParams(request.body)) : request.body || {})));
  }
  app.get(`${base}/userinfo`, async (request, reply) => run(reply, async () =>
    provider.userinfo(String(request.headers.authorization || "").replace(/^Bearer /, ""),
      request.query.browser === "1" ? (await readSession(request))?.session?.id || "missing" : "")));
  app.post(`${base}/revoke`, async (request, reply) => run(reply, async () => {
    const input = typeof request.body === "string" ? Object.fromEntries(new URLSearchParams(request.body)) : request.body || {};
    await provider.revoke(String(input.token || ""), String(input.client_id || ""));
    return {};
  }));
  if (nativeAuth) {
    app.get(`${base}/login-config`, () => ({
      githubEnabled: nativeAuth.githubEnabled, registrationEnabled: nativeAuth.registrationEnabled
    }));
    app.get(`${base}/return`, (request, reply) => run(reply, async () => {
      const url = new URL(provider.loginUri(request.query.client_id));
      url.searchParams.set(request.query.error ? "error" : "verified",
        request.query.error ? "social_login_failed" : "1");
      return reply.redirect(url.href);
    }));
    app.get(`${base}/social/start`, (request, reply) => run(reply, async () => {
      if (!nativeAuth.githubEnabled) throw error("social_login_unavailable", 503);
      const input = request.query;
      provider.validateAuthorization(input);
      const callback = new URL(`${base}/authorize`, provider.adcOrigin);
      callback.search = new URLSearchParams(input).toString();
      const errorCallback = new URL(`${base}/return`, provider.adcOrigin);
      errorCallback.search = new URLSearchParams({ client_id: input.client_id, error: "social_login_failed" }).toString();
      // BetterAuth owns state, PKCE and its cookies on its existing hostname.
      const result = await nativeAuth.handle(new Request(`${provider.adcOrigin}/api/auth/sign-in/social`, {
        method: "POST", headers: { "content-type": "application/json", origin: provider.adcOrigin,
          "x-adc-client-ip": request.ip },
        body: JSON.stringify({ provider: "github", callbackURL: callback.href, errorCallbackURL: errorCallback.href })
      }));
      const value = await result.json().catch(() => ({}));
      if (!result.ok || !value.url || new URL(value.url).origin !== "https://github.com") {
        throw error("social_login_failed", result.status === 429 ? 429 : 503);
      }
      const cookies = result.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.redirect(value.url);
    }));
  }
  app.get(`${base}/device-info`, (request, reply) => run(reply, async () => {
    const value = await provider.inspectDevice(request.query.user_code);
    return { name: value.name };
  }));
  app.post(`${base}/device-approve`, (request, reply) => run(reply, async () => {
    const input = request.body || {};
    // The native Memory BFF holds the scoped grant; this endpoint never trusts cookies.
    const token = String(request.headers.authorization || "").replace(/^Bearer /, "");
    await provider.approveWithToken(input.user_code, token, input.decision !== "approve");
    return { approved: input.decision === "approve" };
  }));
  async function loggedIn(request, reply) {
    const session = await readSession(request);
    if (!session?.session?.id) {
      reply.redirect(`${provider.adcOrigin}/login?return_to=${encodeURIComponent(request.url)}`);
      return null;
    }
    return session;
  }
  app.get(`${base}/authorize`, async (request, reply) => run(reply, async () => {
    // Validate exact registered callbacks and PKCE before entering a login page.
    provider.validateAuthorization(request.query);
    const session = await loggedIn(request, reply);
    if (!session) return;
    return reply.redirect(await provider.authorize(request.query, session.session.id));
  }));
  app.get(`${base}/verify`, async (request, reply) => run(reply, async () => {
    const session = await loggedIn(request, reply);
    if (!session) return;
    const value = await provider.inspectDevice(request.query.user_code);
    const nonce = secret();
    reply.header("set-cookie", `__Host-zioon_verify=${nonce}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`);
    reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    return reply.type("text/html").send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>登录 ${escape(value.name)}</title><style>body{font:16px system-ui;background:#f5f3ee;color:#1d2926;margin:0}main{max-width:440px;margin:15vh auto;padding:32px}h1{font-size:32px}code{display:block;margin:32px 0;font-size:28px;letter-spacing:3px}button{background:#195c4c;color:white;border:0;padding:14px 22px;cursor:pointer}</style><main><p>ZIOON ACCOUNT</p><h1>登录 ${escape(value.name)}</h1><p>当前账号：${escape(session.user.email || session.user.name)}。请确认验证码与发起登录的设备一致。</p><code>${escape(request.query.user_code)}</code><form method="post"><input type="hidden" name="user_code" value="${escape(request.query.user_code)}"><input type="hidden" name="csrf" value="${nonce}"><button name="decision" value="approve">确认登录</button> <button name="decision" value="deny">取消</button></form></main></html>`);
  }));
  app.post(`${base}/verify`, async (request, reply) => run(reply, async () => {
    if (request.headers.origin !== provider.adcOrigin) throw error("invalid_origin", 403);
    const input = typeof request.body === "string" ? Object.fromEntries(new URLSearchParams(request.body)) : request.body || {};
    const cookie = String(request.headers.cookie || "").match(/(?:^|;\s*)__Host-zioon_verify=([A-Za-z0-9_-]+)/)?.[1];
    if (!cookie || input.csrf !== cookie) throw error("invalid_csrf", 403);
    const session = await loggedIn(request, reply);
    if (!session) return;
    await provider.approve(input.user_code, session.session.id, input.decision !== "approve");
    reply.header("set-cookie", "__Host-zioon_verify=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0");
    return reply.type("text/html").send("<!doctype html><meta charset=utf-8><title>登录已处理</title><p>登录请求已处理，可以关闭此页面。</p>");
  }));
}
