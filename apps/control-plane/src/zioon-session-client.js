(() => {
  const source = document.currentScript;
  const product = source?.dataset.product;
  const authority = source ? new URL(source.src).origin : "";
  const endpoints = { adc: "/api/v1/me", runtime: "/v1/account/me", memory: "/console/api/me" };
  if (!authority || !endpoints[product]) return;
  let busy = false, previous = null;
  const login = () => {
    if (product === "memory") return "/account/login";
    if (product === "adc") return "/login";
    return `/v1/account/login?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  };
  async function check() {
    if (busy || document.visibilityState !== "visible") return;
    busy = true;
    try {
      const localResponse = await fetch(endpoints[product], {
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(8000)
      });
      if (![200, 401].includes(localResponse.status)) return;
      const local = localResponse.ok ? await localResponse.json() : null;
      const response = await fetch(`${authority}/api/v1/zioon/session/status`, {
        credentials: "include", cache: "no-store", signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) return;
      const shared = await response.json();
      const subject = product === "adc" ? local?.user?.id :
        product === "runtime" ? local?.accountIdentity?.subject : local?.accountSubject;
      const authenticated = !!local && shared.authenticated && subject === shared.user?.id;
      const event = new CustomEvent("zioon:session", {
        cancelable: true, detail: { authenticated, sharedAuthenticated: shared.authenticated,
          changed: previous !== null && previous !== shared.generation, local }
      });
      const proceed = window.dispatchEvent(event);
      const previouslyAuthenticated = previous !== null && previous !== "";
      previous = shared.generation || "";
      if (authenticated || !proceed) return;
      if (shared.authenticated) {
        // A failed callback must remain recoverable instead of looping silently.
        const key = `zioon.sso.${product}.${shared.generation}`;
        let last = 0;
        try { last = Number(sessionStorage.getItem(key));
          if (Date.now() - last > 15000) sessionStorage.setItem(key, String(Date.now())); } catch {}
        if (Date.now() - last > 15000) location.replace(login());
      } else if ((local || previouslyAuthenticated) && product !== "memory") {
        location.replace(login());
      }
    } catch { /* A network error is not a logout. */ }
    finally { busy = false; }
  }
  window.addEventListener("focus", check);
  window.addEventListener("online", check);
  document.addEventListener("visibilitychange", check);
  window.setInterval(check, 2500);
  void check();
})();
