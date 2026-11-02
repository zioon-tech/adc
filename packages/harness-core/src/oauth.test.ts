import { describe, expect, it, vi } from "vitest";
import { principalKey, ScopedOAuthConnection, type OAuthState } from "./oauth.ts";

function memory() {
  let state: OAuthState = {};
  return {
    async read() {
      return structuredClone(state);
    },
    async write(next: OAuthState) {
      state = structuredClone(next);
    }
  };
}
function oauthFixture() {
  let now = 1000;
  const store = memory();
  const fetcher = vi.fn(async (input: any, init: any) => {
    if (String(input).endsWith("/register")) return Response.json({ client_id: "client_example" });
    expect(init.redirect).toBe("error");
    return Response.json({
      access_token: "scoped-test-token",
      refresh_token: "scoped-refresh",
      token_type: "Bearer",
      expires_in: 3600
    });
  });
  const oauth = new ScopedOAuthConnection(store, "https://adc.example", fetcher, () => now);
  return {
    store,
    fetcher,
    oauth,
    advance() {
      now += 3_600_000;
    }
  };
}

describe("account-scoped plugin OAuth", () => {
  it("uses unambiguous trusted user identities and maps Run grants to the same user", () => {
    const user = { kind: "account", user: { id: "user-a" }, space: { id: "space-a" } };
    const key = principalKey(user);
    expect(key).not.toBe(principalKey({ ...user, user: { id: "user-b" } }));
    expect(key).toBe(
      principalKey({
        version: 1,
        kind: "user",
        userId: "user-a",
        spaceId: "space-a",
        grantId: "grant-a"
      })
    );
    expect(() => principalKey({ accountId: "user-a" })).toThrow("Sign in");
    expect(() => principalKey({ userId: "user-a", spaceId: "space-a", kind: "user" })).toThrow();
  });

  it("binds callback origin/state/expiry and PKCE, requests scoped access, and consumes codes once", async () => {
    const { oauth, store, fetcher } = oauthFixture();
    await expect(oauth.begin("https://evil.example/", ["https://zion.example"])).rejects.toThrow(
      "origin"
    );
    const begin = await oauth.begin("https://zion.example/", ["https://zion.example"]);
    const url = new URL(begin.authorizeUrl);
    expect(url.searchParams.get("scope")).toBe("adc:tools offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).not.toBe((await store.read()).pending?.verifier);
    const state = url.searchParams.get("state")!;
    await expect(oauth.finish("code", "wrong-user-state")).rejects.toThrow("different Zion user");
    expect(await oauth.finish("one-use-code", state)).toEqual({ connected: true });
    const tokenCall = fetcher.mock.calls.at(-1)!;
    expect(tokenCall[1].body.get("code_verifier")).toBeTruthy();
    expect(tokenCall[1].body.get("redirect_uri")).toBe("https://zion.example/");
    expect(await oauth.token()).toBe("scoped-test-token");
    await expect(oauth.finish("one-use-code", state)).rejects.toThrow();
    expect((await store.read()).pending).toBeUndefined();
  });

  it("rejects expired and cross-user callbacks without exchanging a code", async () => {
    const first = oauthFixture(),
      other = oauthFixture();
    const result = await first.oauth.begin("https://zion.example/", ["https://zion.example"]);
    const state = new URL(result.authorizeUrl).searchParams.get("state")!;
    await expect(other.oauth.finish("code", state)).rejects.toThrow();
    first.advance();
    await expect(first.oauth.finish("code", state)).rejects.toThrow("expired");
    expect(first.fetcher).toHaveBeenCalledTimes(1);
    expect(other.fetcher).not.toHaveBeenCalled();
  });

  it("refreshes scoped tokens, preserves recoverable outages and clears revoked authorization", async () => {
    const fixture = oauthFixture();
    const result = await fixture.oauth.begin("https://zion.example/", ["https://zion.example"]);
    await fixture.oauth.finish("code", new URL(result.authorizeUrl).searchParams.get("state")!);
    fixture.advance();
    fixture.fetcher.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(fixture.oauth.token()).rejects.toThrow("503");
    expect((await fixture.store.read()).connection).toBeDefined();
    expect(await fixture.oauth.token()).toBe("scoped-test-token");
    expect(fixture.fetcher.mock.calls.at(-1)![1].body.get("grant_type")).toBe("refresh_token");
    fixture.advance();
    fixture.fetcher.mockResolvedValueOnce(Response.json({}, { status: 400 }));
    await expect(fixture.oauth.token()).rejects.toThrow("400");
    expect((await fixture.store.read()).connection).toBeUndefined();
  });

  it("revokes only the connected token and clears all local connection state", async () => {
    const { oauth, store, fetcher } = oauthFixture();
    const result = await oauth.begin("https://zion.example/", ["https://zion.example"]);
    await oauth.finish("code", new URL(result.authorizeUrl).searchParams.get("state")!);
    await oauth.disconnect();
    expect(fetcher.mock.calls.at(-1)![0]).toContain("/oauth2/revoke");
    expect(await store.read()).toEqual({});
  });
});
