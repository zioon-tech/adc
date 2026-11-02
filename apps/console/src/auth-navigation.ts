export function safeAuthReturnTo(value: string | null) {
  if (!value || /[\\\x00-\x20\x7f]/.test(value)) return undefined;
  let url: URL;
  try { url = new URL(value, "https://auth.invalid"); }
  catch { return undefined; }
  if (url.origin !== "https://auth.invalid" || url.hash) return undefined;
  if (/^\/invitations\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname) && !url.search && value === url.pathname)
    return value;
  if (!["/cli-login", "/api/v1/zioon/authorize", "/api/v1/zioon/restart", "/api/v1/zioon/verify", "/api/v1/zioon/product-return"].includes(url.pathname)
    || !url.search || value !== url.pathname + url.search) return undefined;
  return value;
}

export function authNavigation(search: string) {
  const params = new URLSearchParams(search);
  const oauth = params.has("client_id") && params.has("sig");
  const oauthSearch = oauth
    ? `?${search
        .replace(/^\?/, "")
        .split("&")
        .filter((part) => !/^(error|error_description|verification)=/.test(part))
        .join("&")}`
    : "";
  const returnTo = safeAuthReturnTo(params.get("return_to"));
  const hosted = !oauth && !!returnTo && ["/api/v1/zioon/authorize", "/api/v1/zioon/restart"]
    .includes(new URL(returnTo, "https://auth.invalid").pathname);
  const authSearch = oauthSearch || (returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "");
  const recoveryReturnTo = hosted
    ? `/api/v1/zioon/restart?${new URLSearchParams({
        client_id: new URL(returnTo!, "https://auth.invalid").searchParams.get("client_id") || ""
      })}`
    : returnTo;
  const recoverySearch = oauthSearch || (recoveryReturnTo
    ? `?return_to=${encodeURIComponent(recoveryReturnTo)}` : "");
  return { oauth, oauthSearch, returnTo, authSearch, hosted, recoverySearch };
}
