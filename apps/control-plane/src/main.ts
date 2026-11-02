import { IdentityStore, PostgresStore } from "@adc/db";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { createControlPlane } from "./app.ts";
import { createAuthentication, type AuthenticationOptions } from "./auth.ts";
import { createAccessService } from "./access.ts";
import { registerZioonAccounts } from "./zioon-register.mjs";
import { parseCorsOrigins } from "./cors.ts";
import { LocalContentAddressedAssetStore } from "./asset-store.ts";
import { LocalTransferBlobStore } from "./transfer-store.ts";
import OSS from "ali-oss";
import { OssDirectTransferStore } from "./object-transfer-store.ts";

const databaseURL = process.env.DATABASE_URL;
const secret = process.env.ADC_AUTH_SECRET;
const publicURL = process.env.ADC_PUBLIC_URL;
if (!databaseURL)
  throw new Error(
    "DATABASE_URL is required. PostgreSQL stores accounts, sessions and device state."
  );
if (!secret)
  throw new Error("ADC_AUTH_SECRET is required. Generate it with: openssl rand -base64 48");
if (!publicURL)
  throw new Error(
    "ADC_PUBLIC_URL is required, for example http://localhost:8787 or https://devices.example.com"
  );
const origin = new URL(publicURL);
if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
  throw new Error("ADC_PUBLIC_URL must be an origin without a path, credentials or query.");
}
if (
  origin.protocol !== "https:" &&
  !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
) {
  throw new Error("Public installations require an HTTPS ADC_PUBLIC_URL.");
}
const consoleDirectory =
  process.env.ADC_CONSOLE_DIR ?? fileURLToPath(new URL("../../console/dist", import.meta.url));
if (!existsSync(`${consoleDirectory}/index.html`)) {
  throw new Error("Console build is missing. Run pnpm build before starting the server.");
}
const analyticsScriptUrl = process.env.ADC_ANALYTICS_SCRIPT_URL;
const analyticsDomain = process.env.ADC_ANALYTICS_DOMAIN;
if (!!analyticsScriptUrl !== !!analyticsDomain) {
  throw new Error("ADC_ANALYTICS_SCRIPT_URL and ADC_ANALYTICS_DOMAIN must be configured together.");
}
if (analyticsScriptUrl) {
  const analyticsUrl = new URL(analyticsScriptUrl);
  if (analyticsUrl.protocol !== "https:") {
    throw new Error("ADC_ANALYTICS_SCRIPT_URL must use HTTPS.");
  }
}
if (analyticsDomain && !/^[a-z0-9.-]{1,253}$/i.test(analyticsDomain)) {
  throw new Error("ADC_ANALYTICS_DOMAIN must be a hostname.");
}
const store = new PostgresStore(databaseURL);
const mailer = process.env.ADC_SMTP_URL
  ? nodemailer.createTransport({
      url: process.env.ADC_SMTP_URL,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000
    })
  : undefined;
if (mailer) await mailer.verify();
const accountOrigin = process.env.ZIOON_ACCOUNT_ISSUER
  ? new URL(process.env.ZIOON_ACCOUNT_ISSUER).origin : undefined;
const accountCookieDomain = process.env.ZIOON_ACCOUNT_COOKIE_DOMAIN;
if (accountCookieDomain && (!/^[a-z0-9.-]+$/.test(accountCookieDomain)
  || ![publicURL, accountOrigin].every(value => value && new URL(value).protocol === "https:"
    && new URL(value).hostname.endsWith(`.${accountCookieDomain}`)))) {
  throw new Error("The common cookie domain must contain both HTTPS account and product origins.");
}
const authenticationOptions: AuthenticationOptions = {
  pool: store.pool,
  baseURL: publicURL,
  secret,
  registrationEnabled: process.env.ADC_REGISTRATION_ENABLED !== "false",
  requireEmailVerification: process.env.ADC_REQUIRE_EMAIL_VERIFICATION === "true",
  allowDynamicClientRegistration: process.env.ADC_OAUTH_DYNAMIC_REGISTRATION === "true",
  ...(accountOrigin ? {
    trustedOrigins: [accountOrigin],
    ...(accountCookieDomain ? { sharedCookieDomain: accountCookieDomain } : {})
  } : {}),
  ...(process.env.ADC_GITHUB_CLIENT_ID || process.env.ADC_GITHUB_CLIENT_SECRET
    ? {
        github: {
          clientId: process.env.ADC_GITHUB_CLIENT_ID ?? "",
          clientSecret: process.env.ADC_GITHUB_CLIENT_SECRET ?? "",
          ...(process.env.ZIOON_GITHUB_REDIRECT_URI ? {
            redirectURI: process.env.ZIOON_GITHUB_REDIRECT_URI
          } : {})
        }
      }
    : {}),
  ...(mailer
    ? {
        sendMail: async (mail) => {
          const result = await mailer.sendMail({
            ...mail,
            from: process.env.ZIOON_ACCOUNT_SMTP_FROM ?? {
              name: "Zioon Account",
              address: process.env.ADC_SMTP_FROM?.match(/<([^<>]+)>/)?.[1]
                ?? process.env.ADC_SMTP_FROM ?? "no-reply@localhost"
            }
          });
          if (!result.accepted.length || result.rejected.length) {
            throw new Error("The SMTP server did not accept the message.");
          }
        }
      }
    : {})
};
const authentication = createAuthentication(authenticationOptions);
const accountAuthentication = accountOrigin
  ? createAuthentication({ ...authenticationOptions, baseURL: accountOrigin,
      trustedOrigins: [origin.origin], allowDynamicClientRegistration: false })
  : undefined;
const corsOrigins = parseCorsOrigins(process.env.ADC_CORS_ORIGINS);
const assetStore = process.env.ADC_ASSET_DIR
  ? new LocalContentAddressedAssetStore(process.env.ADC_ASSET_DIR)
  : undefined;
const transferBackend = process.env.ADC_TRANSFER_BACKEND ?? "disabled";
if (!["disabled", "local", "oss"].includes(transferBackend)) {
  throw new Error("ADC_TRANSFER_BACKEND must be disabled, local or oss");
}
const transferStore =
  transferBackend === "local"
    ? new LocalTransferBlobStore(process.env.ADC_TRANSFER_DIR ?? "./data/transfers")
    : undefined;
function requiredTransferSetting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for OSS transfers`);
  return value;
}
const directTransferStore =
  transferBackend === "oss"
    ? new OssDirectTransferStore(
        new OSS({
          region: requiredTransferSetting("ADC_TRANSFER_OSS_REGION"),
          bucket: requiredTransferSetting("ADC_TRANSFER_OSS_BUCKET"),
          accessKeyId: requiredTransferSetting("ADC_TRANSFER_OSS_ACCESS_KEY_ID"),
          accessKeySecret: requiredTransferSetting("ADC_TRANSFER_OSS_ACCESS_KEY_SECRET"),
          secure: true,
          timeout: 15_000
        })
      )
    : undefined;
const maxTransferBytes = Number(process.env.ADC_TRANSFER_MAX_BYTES ?? 1024 * 1024 * 1024);
if (!Number.isSafeInteger(maxTransferBytes) || maxTransferBytes < 1) {
  throw new Error("ADC_TRANSFER_MAX_BYTES must be a positive safe integer.");
}
const access = createAccessService(authentication, new IdentityStore(store.pool), accountAuthentication);
const app = await createControlPlane({
  store,
  access,
  logger: true,
  consoleDirectory,
  ...(assetStore ? { assetStore } : {}),
  ...(transferStore ? { transferStore } : {}),
  ...(directTransferStore ? { directTransferStore } : {}),
  maxTransferBytes,
  ...(corsOrigins ? { corsOrigins } : {}),
  ...(analyticsScriptUrl && analyticsDomain
    ? {
        analytics: {
          provider: "plausible" as const,
          scriptUrl: analyticsScriptUrl,
          domain: analyticsDomain
        }
      }
    : {}),
  nodeDistribution: {
    directory:
      process.env.ADC_NODE_RELEASE_DIR ??
      fileURLToPath(new URL("../../../dist/node", import.meta.url)),
    publicUrl: publicURL,
    ...(process.env.ADC_NODE_DOWNLOAD_URL ? { downloadUrl: process.env.ADC_NODE_DOWNLOAD_URL } : {})
  },
  androidDistribution: {
    directory:
      process.env.ADC_ANDROID_RELEASE_DIR ||
      fileURLToPath(new URL("../../../dist/android", import.meta.url)),
    publicUrl: publicURL
  },
  skillDistribution: {
    directory:
      process.env.ADC_SKILL_RELEASE_DIR ??
      fileURLToPath(new URL("../../../dist/skills", import.meta.url))
  },
  pluginDistribution: {
    directory:
      process.env.ADC_PLUGIN_RELEASE_DIR ??
      fileURLToPath(new URL("../../../dist/plugins", import.meta.url))
  },
  ...(process.env.ADC_TRUSTED_PROXIES
    ? { trustProxy: process.env.ADC_TRUSTED_PROXIES.split(",") }
    : {})
});
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

await registerZioonAccounts(app, access, { consoleDirectory });
await app.listen({ port, host });
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void app
      .close()
      .then(() => {
        mailer?.close();
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        app.log.error(error);
        process.exitCode = 1;
      });
  });
}
