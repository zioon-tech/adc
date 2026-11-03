import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Cable, CircleUserRound, Github, LoaderCircle, MailCheck, RotateCw } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { analyticsEventForRequest, trackAnalytics } from "./analytics.tsx";
import { LanguageSelector, translateError, useI18n, type Message } from "./i18n.tsx";
import { authNavigation } from "./auth-navigation.ts";

export type Request = (path: string, init?: RequestInit) => Promise<any>;
export interface User {
  id: string;
  name: string;
  email: string;
}
interface ApiRequestError extends Error {
  status: number;
  code?: string;
  rawMessage: string;
  retryAfter?: number;
}
interface AuthConfig {
  registrationEnabled: boolean;
  passwordResetEnabled: boolean;
  requireEmailVerification: boolean;
  githubEnabled: boolean;
}
const VERIFICATION_RESEND_SECONDS = 60;

export function maskEmail(email: string) {
  const separator = email.lastIndexOf("@");
  if (separator < 1) return email;
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  if (!domain) return email;
  if (local.length === 1) return `*@${domain}`;
  if (local.length === 2) return `${local[0]}*@${domain}`;
  return `${local[0]}***${local.at(-1)}@${domain}`;
}

export function isApiErrorCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && (error as ApiRequestError).code === code;
}

export function authQueryError(
  error: string | null,
  verification: boolean,
  mode: "login" | "register" | "forgot" | "reset"
): Message | undefined {
  if (!error) return undefined;
  if (error === "signup_disabled")
    return "New account registration is disabled. Existing users can still sign in.";
  if (
    verification &&
    ["TOKEN_EXPIRED", "INVALID_TOKEN", "USER_NOT_FOUND", "INVALID_USER"].includes(error)
  )
    return "This verification link is invalid or expired. Sign in to request a new one.";
  if (mode !== "login") return "This link is invalid or expired. Please try again.";
  if (error === "invalid_login_transaction")
    return "This sign-in request has expired. Start a new sign-in request to continue.";
  if (error === "login_cancelled") return "Sign-in was cancelled. You can try again.";
  if (error === "account_disabled") return "This account is disabled. Contact the administrator.";
  if (["account_service_unavailable", "workspace_unavailable"].includes(error))
    return "The service could not open your workspace. Please try again shortly.";
  if (["login_rate_limited", "too_many_login_requests"].includes(error))
    return "Too many sign-in attempts. Please wait before trying again.";
  if (["social_login_failed", "provider_error"].includes(error) || /github|oauth|email_not_found|unable_to_link_account/i.test(error))
    return "GitHub sign-in could not finish. Verify your GitHub email and try again. Existing email accounts can link GitHub from Account.";
  return "Sign-in could not finish. Please try again.";
}

export async function apiRequest(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init.headers }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const rawMessage =
      body.error?.message ?? body.message ?? body.error_description ?? `HTTP ${response.status}`;
    const error = new Error(translateError(rawMessage));
    const retryHeader = response.headers.get("retry-after") ?? response.headers.get("x-retry-after");
    const retrySeconds = retryHeader === null ? NaN : /^\d+$/.test(retryHeader)
      ? Number(retryHeader) : (Date.parse(retryHeader) - Date.now()) / 1000;
    Object.assign(error, {
      status: response.status,
      code: body.error?.code ?? body.code ?? (typeof body.error === "string" ? body.error : undefined),
      rawMessage,
      ...(response.status === 429 ? {
        retryAfter: Number.isFinite(retrySeconds) ? Math.max(0, Math.ceil(retrySeconds)) : 60
      } : {})
    });
    throw error;
  }
  const analyticsEvent = analyticsEventForRequest(path, init.method);
  if (analyticsEvent) trackAnalytics(analyticsEvent);
  return body;
}
export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="Agent Device Cloud">
      <Cable size={25} strokeWidth={1.5} aria-hidden="true" />
      <span>Agent Device Cloud</span>
    </Link>
  );
}
export function AuthLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="auth-layout">
      <header className="public-header">
        <div className="brand" aria-label={t("Zioon Account")}>
          <CircleUserRound size={25} strokeWidth={1.5} aria-hidden="true" />
          <span>{t("Zioon Account")}</span>
        </div>
        <LanguageSelector />
      </header>
      <main className={`login ${wide ? "consent" : ""}`}>{children}</main>
      <footer className="auth-footer">{t("Zioon · Unified account service")}</footer>
    </div>
  );
}

export function CliLogin({ request }: { request: Request }) {
  const { t } = useI18n();
  const location = useLocation();
  const userCode = new URLSearchParams(location.search).get("user_code") ?? "";
  const invalidRequestMessage = t("This device login request is invalid or expired.");
  const [status, setStatus] = useState<
    "loading" | "pending" | "approved" | "denied" | "error" | "invalid" | "other-account"
  >("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retryAt, setRetryAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const deciding = useRef(false);
  const currentCode = useRef(userCode);
  currentCode.current = userCode;
  useEffect(() => {
    let active = true;
    setError("");
    setRetryAt(0);
    setRemaining(0);
    if (!userCode) {
      setStatus("invalid");
      return;
    }
    setStatus("loading");
    request(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`)
      .then((result) => {
        if (!active) return;
        // The provider includes client_id only for the account owning this
        // request. An approved code alone does not prove this account logged in.
        if (!["adc-cli", "adc-android"].includes(result.client_id)) {
          setStatus("other-account");
        } else if (["pending", "approved", "denied"].includes(result.status)) {
          setStatus(result.status);
        } else {
          setStatus("invalid");
        }
      })
      .catch((error: ApiRequestError) => {
        if (!active) return;
        if (["invalid_request", "expired_token"].includes(error.code ?? "")) {
          setStatus("invalid");
          return;
        }
        setStatus("error");
        setError(error.message);
        if (error.status === 429) {
          const seconds = error.retryAfter ?? 60;
          setRemaining(seconds);
          setRetryAt(Date.now() + seconds * 1000);
        }
      });
    return () => { active = false; };
    // The translated string is stable across renders; useI18n's t function is
    // recreated on every render and must not trigger another network request.
  }, [request, userCode, attempt, invalidRequestMessage]);
  useEffect(() => {
    if (!retryAt) return;
    const update = () => setRemaining(Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);
  const decide = async (decision: "approve" | "deny") => {
    if (deciding.current || remaining > 0) return;
    deciding.current = true;
    setBusy(true);
    setError("");
    try {
      await request(`/api/auth/device/${decision}`, {
        method: "POST",
        body: JSON.stringify({ userCode })
      });
      if (currentCode.current !== userCode) return;
      setStatus(decision === "approve" ? "approved" : "denied");
    } catch (error) {
      if (currentCode.current !== userCode) return;
      const failure = error as ApiRequestError;
      if (["invalid_request", "expired_token"].includes(failure.code ?? "")) {
        setStatus("invalid");
      } else {
        setError(failure.message);
        if (failure.status === 429) {
          const seconds = failure.retryAfter ?? 60;
          setRemaining(seconds);
          setRetryAt(Date.now() + seconds * 1000);
        }
      }
    } finally {
      deciding.current = false;
      setBusy(false);
    }
  };
  return (
    <AuthLayout>
      <h1>{t("Connect your device")}</h1>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {status === "loading" ? (
        <p className="description" role="status">
          {t("Checking this login request…")}
        </p>
      ) : status === "approved" ? (
        <>
          <p className="notice" role="status">
            {t("Login approved. Return to the app or terminal to finish.")}
          </p>
          <code>{userCode}</code>
        </>
      ) : status === "denied" ? (
        <p className="description" role="status">
          {t("Device login denied. You can close this tab.")}
        </p>
      ) : status === "invalid" || status === "other-account" ? (
        <p className="description" role="status">
          {status === "other-account"
            ? t("This login request belongs to another account. Start login again on your own device.")
            : invalidRequestMessage}
        </p>
      ) : status === "error" ? (
        <>
          {remaining > 0 ? <p className="description" role="status">
            {t("Try again in {seconds} seconds.", { seconds: remaining })}
          </p> : null}
          <button className="secondary" disabled={remaining > 0}
            onClick={() => setAttempt((value) => value + 1)}>{t("Retry")}</button>
        </>
      ) : (
        <>
          <p className="description">
            {t("Confirm that this code matches the one shown in your app or terminal.")}
          </p>
          <div className="token-value">
            <code>{userCode}</code>
          </div>
          <div className="row-actions">
            <button className="primary" disabled={busy || remaining > 0} onClick={() => void decide("approve")}>
              {t("Approve login")}
            </button>
            <button className="secondary" disabled={busy || remaining > 0} onClick={() => void decide("deny")}>
              {t("Deny")}
            </button>
          </div>
          {remaining > 0 ? <p className="description" role="status">
            {t("Try again in {seconds} seconds.", { seconds: remaining })}
          </p> : null}
        </>
      )}
    </AuthLayout>
  );
}

export function AuthPage({
  onLogin,
  onSwitchAccount,
  onPasswordReset,
  currentUser
}: {
  onLogin: (returnTo?: string) => Promise<void>;
  onSwitchAccount: () => Promise<void>;
  onPasswordReset?: () => void;
  currentUser: User | null;
}) {
  const { t } = useI18n();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const { oauth, oauthSearch, returnTo, authSearch, hosted, recoverySearch } = authNavigation(location.search);
  const mode =
    location.pathname === "/register"
      ? "register"
      : location.pathname === "/forgot-password"
        ? "forgot"
        : location.pathname === "/reset-password"
          ? "reset"
          : "login";
  const [config, setConfig] = useState<AuthConfig>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const [githubPending, setGithubPending] = useState(false);
  const [verificationEmail, setVerificationEmail] = useState("");
  const [verificationSent, setVerificationSent] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resetEmail, setResetEmail] = useState("");
  const [passwordResetComplete, setPasswordResetComplete] = useState(false);
  const [loginContext, setLoginContext] = useState<{ name: string; cancelUrl?: string }>();
  const [contextError, setContextError] = useState(false);
  useEffect(() => {
    if (!hosted || !returnTo) return;
    let active = true;
    setLoginContext(undefined);
    setContextError(false);
    apiRequest(`/api/v1/zioon/login-context${new URL(returnTo, window.location.origin).search}`)
      .then((context) => { if (active) setLoginContext(context); })
      .catch(() => { if (active) setContextError(true); });
    return () => { active = false; };
  }, [hosted, returnTo]);
  useEffect(() => {
    apiRequest("/api/v1/auth/config")
      .then(setConfig)
      .catch((error) => setError(error.message));
  }, []);
  useEffect(() => {
    setError("");
    setNotice(undefined);
    setGithubPending(false);
    setVerificationEmail("");
    setVerificationSent(false);
    setResendCooldown(0);
    setResetEmail("");
    setPasswordResetComplete(false);
  }, [location.pathname]);
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = window.setInterval(
      () => setResendCooldown((seconds) => Math.max(0, seconds - 1)),
      1_000
    );
    return () => window.clearInterval(timer);
  }, [resendCooldown > 0]);
  const callbackURL = `${window.location.origin}${oauth ? `/login${oauthSearch}` : (returnTo ??
    (document.querySelector('meta[name="zioon-account-app"]') ? "/account" : "/app"))}`;
  const verificationCallbackURL = `${window.location.origin}${
    oauth
      ? `/login${oauthSearch}&verification=1`
      : `/login?verification=1${returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ""}`
  }`;
  const continueOAuth = async (created = false) => {
    const result = await apiRequest("/api/auth/oauth2/continue", {
      method: "POST",
      body: JSON.stringify({
        oauth_query: oauthSearch.slice(1),
        postLogin: true,
        ...(created ? { created } : {})
      })
    });
    window.location.assign(result.url);
  };
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const social = async () => {
    setBusy(true);
    setGithubPending(true);
    setError("");
    setNotice(undefined);
    try {
      const result = await apiRequest("/api/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({
          provider: "github",
          callbackURL,
          newUserCallbackURL: callbackURL,
          errorCallbackURL: `${window.location.origin}/login${
            oauth ? oauthSearch : returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ""
          }`,
          disableRedirect: true
        })
      });
      window.location.assign(result.url);
    } catch (error) {
      setError((error as Error).message);
      setGithubPending(false);
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "")
      .trim()
      .toLowerCase();
    const password = String(data.get("password") ?? "");
    setNotice(undefined);
    await action(async () => {
      if (mode === "forgot") {
        await apiRequest("/api/auth/request-password-reset", {
          method: "POST",
          body: JSON.stringify({ email, redirectTo: `${window.location.origin}/reset-password${recoverySearch}` })
        });
        setResetEmail(email);
      } else if (mode === "reset") {
        if (!params.get("token"))
          throw new Error(t("This reset link is missing its token. Request a new link."));
        await apiRequest("/api/auth/reset-password", {
          method: "POST",
          body: JSON.stringify({ token: params.get("token"), newPassword: password })
        });
        onPasswordReset?.();
        setPasswordResetComplete(true);
      } else {
        try {
          await apiRequest(
            mode === "register" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email",
            {
              method: "POST",
              body: JSON.stringify({
                email,
                password,
                callbackURL:
                  mode === "register" && config?.requireEmailVerification
                    ? verificationCallbackURL
                    : callbackURL,
                ...(mode === "register" ? { name: String(data.get("name") ?? "").trim() } : {})
              })
            }
          );
        } catch (error) {
          if (
            config?.requireEmailVerification &&
            mode === "login" &&
            isApiErrorCode(error, "EMAIL_NOT_VERIFIED")
          ) {
            setVerificationEmail(email);
            setVerificationSent(false);
            setResendCooldown(0);
            return;
          }
          throw error;
        }
        if (mode === "register" && config?.requireEmailVerification) {
          setVerificationEmail(email);
          setVerificationSent(true);
          setResendCooldown(VERIFICATION_RESEND_SECONDS);
        } else if (oauth) await continueOAuth(mode === "register");
        else await onLogin(returnTo);
      }
    });
  };
  const disabled =
    !config || (hosted && !loginContext) ||
    (mode === "register" && !config.registrationEnabled) ||
    (mode === "forgot" && !config.passwordResetEnabled);
  const title: Record<typeof mode, Message> = {
    login: "Welcome back",
    register: "Create your account",
    forgot: "Reset your password",
    reset: "Choose a new password"
  };
  const buttons: Record<typeof mode, Message> = {
    login: "Sign in",
    register: "Create account",
    forgot: "Send reset link",
    reset: "Save password"
  };
  const queryError = authQueryError(params.get("error"), params.has("verification"), mode);
  const invalidResetLink = mode === "reset" && (!params.get("token") || !!queryError);
  const completed =
    !!verificationEmail || !!resetEmail || passwordResetComplete || invalidResetLink;
  const pageTitle: Message = verificationEmail
    ? "Verify your email"
    : resetEmail
      ? "Check your email"
      : passwordResetComplete
        ? "Password updated"
        : invalidResetLink
          ? "Reset link expired"
          : title[mode];
  const description = verificationEmail
    ? verificationSent
      ? t("We sent a verification link to {email}. Open it to verify your address and sign in.", {
          email: maskEmail(verificationEmail)
        })
      : t("{email} has not been verified. Request a new verification email to continue.", {
          email: maskEmail(verificationEmail)
        })
    : resetEmail
      ? t("If an account exists for {email}, a password reset link is on its way.", {
          email: maskEmail(resetEmail)
        })
      : passwordResetComplete
        ? t("You can now sign in with your new password.")
        : invalidResetLink
          ? t("Request a new password reset link to continue.")
          : hosted
            ? loginContext
              ? t("Sign in to continue to {product}.", { product: loginContext.name })
              : t("Checking this login request…")
            : t("One account for all Zioon services.");
  return (
    <AuthLayout>
      {githubPending ? (
        <div className="auth-redirect-status" role="status" aria-live="assertive" aria-busy="true">
          <LoaderCircle className="button-spinner" size={22} aria-hidden="true" />
          <span>{t("Connecting to GitHub…")}</span>
        </div>
      ) : null}
      <h1>{t(pageTitle)}</h1>
      <p className="description">{description}</p>
      {contextError ? (
        <p className="form-error" role="alert">
          {t("This sign-in request could not be verified. Return to the app and try again.")}
        </p>
      ) : null}
      {queryError ? (
        <p className="form-error" role="alert">
          {t(queryError)}
        </p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {t(notice)}
        </p>
      ) : null}
      {config && disabled && !(hosted && !loginContext) ? (
        <p className="description">{t("This option is disabled on this installation.")}</p>
      ) : null}
      {verificationEmail ? (
        <div className="auth-completion">
          <MailCheck
            className="auth-completion-icon"
            size={28}
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <p className="hint">
            {t("Check your spam folder if the message does not arrive within a few minutes.")}
          </p>
          <button
            className="secondary"
            disabled={busy || resendCooldown > 0}
            onClick={() =>
              action(async () => {
                await apiRequest("/api/auth/send-verification-email", {
                  method: "POST",
                  body: JSON.stringify({
                    email: verificationEmail,
                    callbackURL: verificationCallbackURL
                  })
                });
                setVerificationSent(true);
                setResendCooldown(VERIFICATION_RESEND_SECONDS);
                setNotice("A new verification email was sent.");
              })
            }
          >
            {busy ? (
              <LoaderCircle className="button-spinner" size={17} aria-hidden="true" />
            ) : (
              <RotateCw size={17} aria-hidden="true" />
            )}
            {t(
              busy
                ? "Please wait…"
                : resendCooldown > 0
                  ? "Resend in {seconds}s"
                  : "Resend verification email",
              { seconds: resendCooldown }
            )}
          </button>
          <button
            className="text-link"
            type="button"
            onClick={() => {
              setVerificationEmail("");
              setVerificationSent(false);
              setResendCooldown(0);
              setNotice(undefined);
              setError("");
            }}
          >
            {t(mode === "register" ? "Use a different email" : "Back to sign in")}
          </button>
        </div>
      ) : resetEmail ? (
        <div className="auth-completion">
          <MailCheck
            className="auth-completion-icon"
            size={28}
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <p className="hint">
            {t("Check your spam folder if the message does not arrive within a few minutes.")}
          </p>
          <button className="text-link" type="button" onClick={() => setResetEmail("")}>
            {t("Try another email")}
          </button>
          <Link className="secondary" to={`/login${recoverySearch}`}>
            {t("Back to sign in")}
          </Link>
        </div>
      ) : passwordResetComplete ? (
        <div className="auth-completion">
          <Link className="primary" to={`/login${recoverySearch}`}>
            {t("Sign in")}
          </Link>
        </div>
      ) : invalidResetLink ? (
        <div className="auth-completion">
          <Link className="primary" to={`/forgot-password${recoverySearch}`}>
            {t("Request a new reset link")}
          </Link>
          <Link className="text-link" to={`/login${recoverySearch}`}>
            {t("Back to sign in")}
          </Link>
        </div>
      ) : currentUser && (oauth || hosted) && (mode === "login" || mode === "register") ? (
        <div className="auth-account-choice">
          <div className="auth-current-account">
            <span className="avatar" aria-hidden="true">{currentUser.name.slice(0, 1).toUpperCase()}</span>
            <div><strong>{currentUser.name}</strong><span>{currentUser.email}</span></div>
          </div>
          <button className="primary" disabled={busy || disabled}
            onClick={() => action(() => oauth ? continueOAuth() : onLogin(returnTo))}>
            {busy ? <LoaderCircle className="button-spinner" size={17} aria-hidden="true" /> : null}
            {t(busy ? "Please wait…" : queryError && hosted ? "Retry opening {product}" : "Continue as {name}",
              { name: currentUser.name, product: loginContext?.name || "" })}
          </button>
          <button className="text-link" disabled={busy} onClick={() => action(onSwitchAccount)}>
            {t("Use a different account")}
          </button>
        </div>
      ) : (
        <>
          {(mode === "login" || mode === "register") && config?.githubEnabled ? (
            <>
              <button
                className="secondary social-button"
                disabled={busy || disabled}
                onClick={social}
                aria-busy={githubPending}
              >
                {githubPending ? (
                  <LoaderCircle className="button-spinner" size={18} aria-hidden="true" />
                ) : (
                  <Github size={18} />
                )}
                {t(githubPending ? "Connecting to GitHub…" : "Continue with GitHub")}
              </button>
              <div className="auth-divider">
                <span>{t("or use email")}</span>
              </div>
            </>
          ) : null}
          <form className="connection-form" onSubmit={submit}>
            {mode === "register" ? (
              <label>
                {t("Name")}
                <input name="name" autoComplete="name" maxLength={128} required />
              </label>
            ) : null}
            {mode !== "reset" ? (
              <label>
                {t("Email")}
                <input name="email" type="email" autoComplete="email" required />
              </label>
            ) : null}
            {mode !== "forgot" ? (
              <label>
                {t("Password")}
                <input
                  name="password"
                  type="password"
                  minLength={12}
                  maxLength={128}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  required
                />
                {mode !== "login" ? (
                  <span className="hint">{t("Use at least 12 characters.")}</span>
                ) : null}
              </label>
            ) : null}
            <button className="primary" type="submit" disabled={busy || disabled}>
              {t(busy ? "Please wait…" : buttons[mode])}
            </button>
          </form>
        </>
      )}
      {!completed && !(currentUser && (oauth || hosted)) ? (
        <div className="auth-links">
          {mode !== "login" ? <Link to={`/login${mode === "forgot" || mode === "reset" ? recoverySearch : authSearch}`}>{t("Sign in")}</Link> : null}
          {mode === "login" && config?.registrationEnabled ? (
            <Link to={`/register${authSearch}`}>{t("Create account")}</Link>
          ) : null}
          {mode === "login" && config?.passwordResetEnabled ? (
            <Link to={`/forgot-password${recoverySearch}`}>{t("Forgot password?")}</Link>
          ) : null}
        </div>
      ) : null}
      {hosted && loginContext?.cancelUrl ? (
        <div className="auth-return">
          <a className="text-link" href={loginContext.cancelUrl}>
            {t("Return to {product}", { product: loginContext.name })}
          </a>
        </div>
      ) : null}
    </AuthLayout>
  );
}

export function AccountSettings({
  user,
  request,
  onUpdate,
  onLogout
}: {
  user: User;
  request: Request;
  onUpdate: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const { t, date } = useI18n();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<AuthConfig>();
  const [accounts, setAccounts] = useState<{ providerId: string }[]>([]);
  const [sessions, setSessions] = useState<
    { token: string; userAgent?: string; updatedAt: string; expiresAt: string }[]
  >([]);
  const [currentToken, setCurrentToken] = useState("");
  const load = async () => {
    const [all, current, providers, settings] = await Promise.all([
      request("/api/auth/list-sessions"),
      request("/api/auth/get-session"),
      request("/api/auth/list-accounts"),
      request("/api/v1/auth/config")
    ]);
    setSessions(all);
    setCurrentToken(current?.session?.token ?? "");
    setAccounts(providers);
    setConfig(settings);
  };
  useEffect(() => {
    void load().catch((error) => setError(error.message));
  }, [request]);
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice(undefined);
    try {
      await run();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const update = async (event: FormEvent<HTMLFormElement>, password: boolean) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    await action(async () => {
      await request(password ? "/api/auth/change-password" : "/api/auth/update-user", {
        method: "POST",
        body: JSON.stringify(
          password
            ? {
                currentPassword: data.get("currentPassword"),
                newPassword: data.get("newPassword"),
                revokeOtherSessions: true
              }
            : { name: data.get("name") }
        )
      });
      if (password) form.reset();
      await onUpdate();
      await load();
      setNotice(
        password ? "Password changed. Other sessions were signed out." : "Profile updated."
      );
    });
  };
  return (
    <section className="page">
      <div className="page-header">
        <h1>{t("Account")}</h1>
        <button className="secondary" disabled={busy} onClick={() => action(onLogout)}>
          {t("Sign out")}
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" role="status">
          {t(notice)}
        </p>
      ) : null}
      <div className="settings-grid">
        <form className="card connection-form" onSubmit={(event) => update(event, false)}>
          <h2>{t("Profile")}</h2>
          <label>
            {t("Name")}
            <input name="name" defaultValue={user.name} maxLength={128} required />
          </label>
          <label>
            {t("Email")}
            <input value={user.email} readOnly />
          </label>
          <button className="primary" disabled={busy}>
            {t("Save changes")}
          </button>
        </form>
        {accounts.some((account) => account.providerId === "credential") ? (
          <form className="card connection-form" onSubmit={(event) => update(event, true)}>
            <h2>{t("Password")}</h2>
            <label>
              {t("Current password")}
              <input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <label>
              {t("New password")}
              <input
                name="newPassword"
                type="password"
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                required
              />
            </label>
            <button className="primary" disabled={busy}>
              {t("Change password")}
            </button>
          </form>
        ) : (
          <div className="card">
            <h2>{t("Password")}</h2>
            <p className="description">{t("You sign in with GitHub.")}</p>
            {config?.passwordResetEnabled ? (
              <Link to="/forgot-password">{t("Use password reset to add an email password.")}</Link>
            ) : null}
          </div>
        )}
      </div>
      {config?.githubEnabled ? (
        <div className="card">
          <h2>{t("Sign-in methods")}</h2>
          <p className="description">
            {accounts.some((account) => account.providerId === "github")
              ? t("GitHub connected")
              : null}
          </p>
          {!accounts.some((account) => account.providerId === "github") ? (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  const result = await request("/api/auth/link-social", {
                    method: "POST",
                    body: JSON.stringify({
                      provider: "github",
                      callbackURL: `${window.location.origin}${
                        document.querySelector('meta[name="zioon-account-app"]') ? "/account" : "/app/settings"}`,
                      errorCallbackURL: `${window.location.origin}/login`,
                      disableRedirect: true
                    })
                  });
                  window.location.assign(result.url);
                })
              }
            >
              <Github size={16} />
              {t("Connect GitHub")}
            </button>
          ) : null}
        </div>
      ) : null}
      <h2>{t("Signed-in sessions")}</h2>
      <div className="resource-list">
        {sessions.map((session) => (
          <div className="resource-row" key={session.token}>
            <div>
              <strong>
                {t(session.token === currentToken ? "This session" : "Other session")}
              </strong>
              <p className="hint">
                {session.userAgent || t("Command line")} ·{" "}
                {t("Active {date}", { date: date(session.updatedAt) })}
              </p>
            </div>
            {session.token !== currentToken ? (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await request("/api/auth/revoke-session", {
                      method: "POST",
                      body: JSON.stringify({ token: session.token })
                    });
                    await load();
                  })
                }
              >
                {t("Sign out")}
              </button>
            ) : (
              <span className="state active">{t("Current")}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
