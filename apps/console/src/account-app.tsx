import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { AccountSettings, AuthLayout, AuthPage, CliLogin, apiRequest, type User } from "./auth-ui.tsx";
import { authNavigation, safeAuthReturnTo } from "./auth-navigation.ts";
import { useI18n } from "./i18n.tsx";

export function AccountApp() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>();
  const [error, setError] = useState("");
  const redirecting = useRef(false);
  const redirectTo = useCallback((destination: string) => {
    if (redirecting.current) return;
    redirecting.current = true;
    window.location.replace(destination);
  }, []);
  const load = useCallback(async () => {
    const result = await apiRequest("/api/auth/get-session");
    setUser(result?.user ?? null);
  }, []);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load().catch(() => {}); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 2500);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh); };
  }, [load]);
  const logout = async () => {
    await apiRequest("/api/auth/sign-out", { method: "POST", body: "{}" });
    setUser(null);
    await navigate("/login", { replace: true });
  };
  const { oauth, returnTo } = authNavigation(location.search);
  const authPage = ["/login", "/register", "/forgot-password", "/reset-password"].includes(location.pathname);
  const continueLogin = async (destination?: string) => {
    const accepted = safeAuthReturnTo(destination ?? null);
    if (accepted) {
      redirectTo(accepted);
      return;
    }
    await load();
    await navigate("/account", { replace: true });
  };
  useEffect(() => {
    if (user && location.pathname === "/login" && !oauth && returnTo &&
      !new URLSearchParams(location.search).has("error")) redirectTo(returnTo);
  }, [user, location.pathname, location.search, oauth, returnTo, redirectTo]);
  if (user === undefined) return <AuthLayout><p className={error ? "form-error" : "description"}>
    {error || t("Loading your account…")}</p></AuthLayout>;
  if (authPage) {
    if (user && location.pathname === "/login" && !oauth && !returnTo &&
      !new URLSearchParams(location.search).has("error")) return <Navigate to="/account" replace />;
    return <AuthPage currentUser={user} onLogin={continueLogin} onSwitchAccount={logout}
      onPasswordReset={() => setUser(null)} />;
  }
  if (!user) return <Navigate to={location.pathname === "/cli-login"
    ? `/login?return_to=${encodeURIComponent(location.pathname + location.search)}` : "/login"} replace />;
  if (location.pathname === "/cli-login") return <CliLogin request={apiRequest} />;
  return <AuthLayout wide>
    <nav className="auth-links" aria-label="Zioon services">
      <a href="https://runtime.zioon.tech">Workbench</a>
      <a href="https://memory.zioon.tech/console">Memory</a>
      <a href="https://adc.zioon.tech/app">ADC</a>
    </nav>
    <AccountSettings user={user} request={apiRequest} onUpdate={load} onLogout={logout} />
  </AuthLayout>;
}
