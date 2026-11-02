import { createHash, randomBytes } from "node:crypto";
import { ADC_ORIGIN } from "./index.ts";

export interface OAuthConnection {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  clientId: string;
}

export interface PendingConnection {
  state: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  expiresAt: number;
}

export interface OAuthState {
  connection?: OAuthConnection;
  pending?: PendingConnection;
  selectedNodeId?: string;
  tasks?: unknown[];
}

export interface PrivateState {
  read(): Promise<OAuthState>;
  write(state: OAuthState): Promise<void>;
}

class ConnectionError extends Error {
  constructor(readonly status: number) {
    super(`ADC connection request failed (${status}). Reconnect ADC.`);
  }
}

export function principalKey(principal: any): string {
  const user =
    principal?.kind === "account"
      ? principal.user?.id
      : principal?.version === 1 &&
          ["user", "service"].includes(principal.kind) &&
          principal.grantId
        ? principal.userId
        : undefined;
  const space = principal?.kind === "account" ? principal.space?.id : principal?.spaceId;
  if (typeof user !== "string" || !user || typeof space !== "string" || !space)
    throw new Error("Sign in to Zion before connecting ADC.");
  // Base64url avoids namespace ambiguity and preserves the complete identity.
  return Buffer.from(JSON.stringify([space, user])).toString("base64url");
}

export class ScopedOAuthConnection {
  private readonly origin: string;
  constructor(
    private readonly store: PrivateState,
    origin = ADC_ORIGIN,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))
    )
      throw new Error("Configure an HTTPS ADC service origin.");
    this.origin = url.origin;
  }

  private async post(path: string, body: object | URLSearchParams) {
    const response = await this.fetcher(`${this.origin}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type":
          body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json"
      },
      body: body instanceof URLSearchParams ? body : JSON.stringify(body)
    });
    if (!response.ok) throw new ConnectionError(response.status);
    return (await response.json()) as any;
  }

  async begin(redirectUri: string, allowedOrigins: string[]) {
    const redirect = new URL(redirectUri);
    if (
      !allowedOrigins.includes(redirect.origin) ||
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      redirect.search ||
      (redirect.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(redirect.hostname))
    )
      throw new Error("The ADC callback must use the authenticated Zion Workbench origin.");
    const registration = await this.post("/api/auth/oauth2/register", {
      client_name: "ADC for Zion",
      redirect_uris: [redirect.href],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "adc:tools offline_access"
    });
    if (typeof registration.client_id !== "string")
      throw new Error("Invalid ADC client registration.");
    const verifier = randomBytes(32).toString("base64url");
    const pending: PendingConnection = {
      state: `adc_${randomBytes(32).toString("base64url")}`,
      verifier,
      redirectUri: redirect.href,
      clientId: registration.client_id,
      expiresAt: this.now() + 10 * 60_000
    };
    await this.store.write({ ...(await this.store.read()), pending });
    const url = new URL(`${this.origin}/api/auth/oauth2/authorize`);
    url.search = new URLSearchParams({
      client_id: pending.clientId,
      redirect_uri: pending.redirectUri,
      response_type: "code",
      scope: "adc:tools offline_access",
      resource: `${this.origin}/mcp`,
      state: pending.state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256"
    }).toString();
    return { authorizeUrl: url.href, expiresAt: pending.expiresAt };
  }

  async finish(code: string, state: string) {
    const current = await this.store.read();
    const pending = current.pending;
    if (!pending || pending.expiresAt <= this.now() || pending.state !== state || !code)
      throw new Error("This ADC sign-in has expired or belongs to a different Zion user.");
    // Consume state before exchanging the one-use code, including failure paths.
    const rest = { ...current };
    delete rest.pending;
    await this.store.write(rest);
    const token = await this.post(
      "/api/auth/oauth2/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
        resource: `${this.origin}/mcp`
      })
    );
    await this.store.write({
      ...rest,
      connection: this.parseToken(token, pending.clientId)
    });
    return { connected: true };
  }

  private parseToken(token: any, clientId: string): OAuthConnection {
    if (
      typeof token.access_token !== "string" ||
      token.token_type?.toLowerCase() !== "bearer" ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0
    )
      throw new Error("ADC returned an invalid scoped connection.");
    return {
      accessToken: token.access_token,
      clientId,
      expiresAt: this.now() + token.expires_in * 1000,
      ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {})
    };
  }

  async token(): Promise<string> {
    const current = await this.store.read();
    const connection = current.connection;
    if (!connection) throw new Error("Connect ADC from the Zion sidebar.");
    if (connection.expiresAt > this.now() + 30_000) return connection.accessToken;
    if (!connection.refreshToken) throw new Error("ADC authorization has expired. Reconnect ADC.");
    try {
      const token = await this.post(
        "/api/auth/oauth2/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: connection.refreshToken,
          client_id: connection.clientId,
          resource: `${this.origin}/mcp`
        })
      );
      const next = this.parseToken(token, connection.clientId);
      await this.store.write({
        ...current,
        connection: {
          ...next,
          ...(next.refreshToken ? {} : { refreshToken: connection.refreshToken })
        }
      });
      return next.accessToken;
    } catch (error) {
      if (error instanceof ConnectionError && [400, 401, 403].includes(error.status)) {
        const rest = { ...current };
        delete rest.connection;
        await this.store.write(rest);
      }
      throw error;
    }
  }

  async disconnect() {
    const current = await this.store.read();
    const connection = current.connection;
    if (connection) {
      await this.post(
        "/api/auth/oauth2/revoke",
        new URLSearchParams({
          token: connection.refreshToken ?? connection.accessToken,
          client_id: connection.clientId,
          token_type_hint: connection.refreshToken ? "refresh_token" : "access_token"
        })
      ).catch(() => {});
    }
    await this.store.write({});
    return { connected: false };
  }
}
