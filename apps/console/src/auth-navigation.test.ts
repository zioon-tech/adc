import { describe, expect, it } from "vitest";
import { authNavigation } from "./auth-navigation.ts";

describe("authentication continuation", () => {
  it("preserves the CLI confirmation through registration and back to login", () => {
    const returnTo = "/cli-login?request_id=cli_example&code=ABCD-EFGH";
    const login = authNavigation(`?return_to=${encodeURIComponent(returnTo)}`);
    const register = authNavigation(login.authSearch);
    expect(register.returnTo).toBe(returnTo);
    expect(register.authSearch).toBe(login.authSearch);
    expect(register.oauth).toBe(false);
  });

  it.each([
    "https://example.com/cli-login?",
    "//example.com/cli-login?",
    "/app",
    "/cli-login?code=unsafe\\value",
    "/cli-login?code=unsafe\nvalue",
    "/cli-login?code=unsafe\rvalue"
  ])("does not retain an unsafe or unrelated destination %s", (returnTo) => {
    expect(authNavigation(`?return_to=${encodeURIComponent(returnTo)}`).authSearch).toBe("");
  });

  it("preserves signed OAuth parameters while dropping transient errors", () => {
    const result = authNavigation(
      "?client_id=client_example&sig=signature&state=state&error=expired&verification=1"
    );
    expect(result.authSearch).toBe("?client_id=client_example&sig=signature&state=state");
    expect(result.oauthSearch).toBe(result.authSearch);
    expect(result.oauth).toBe(true);
  });
});
