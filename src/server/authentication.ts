import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { ServerConfiguration } from "./configuration";

/**
 * Optional single-password gate. The session cookie is `<expiry>.<hmac>`; no
 * server-side session table, so restarts don't sign anyone out.
 *
 * The Secure flag is set only when the request actually arrived over HTTPS
 * (directly, or via X-Forwarded-Proto from your reverse proxy). Browsers drop
 * Secure cookies on plain-HTTP LAN addresses, which would make login loop
 * forever when you hit the container by IP.
 */

const SESSION_COOKIE_NAME = "inkwell_session";

function signExpiry(expiryEpochSeconds: number, signingSecret: Buffer): string {
  return createHmac("sha256", signingSecret).update(String(expiryEpochSeconds)).digest("base64url");
}

function constantTimeStringEquals(first: string, second: string): boolean {
  const firstBytes = Buffer.from(first);
  const secondBytes = Buffer.from(second);
  return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes);
}

function requestArrivedOverHttps(context: Context): boolean {
  const forwardedProtocol = context.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProtocol) return forwardedProtocol === "https";
  return new URL(context.req.url).protocol === "https:";
}

export function isSessionValid(context: Context, configuration: ServerConfiguration): boolean {
  if (!configuration.editorPassword) return true;
  const cookieValue = getCookie(context, SESSION_COOKIE_NAME);
  if (!cookieValue) return false;
  const [expiryText, providedSignature] = cookieValue.split(".");
  const expiryEpochSeconds = Number.parseInt(expiryText ?? "", 10);
  if (!Number.isFinite(expiryEpochSeconds) || !providedSignature) return false;
  if (expiryEpochSeconds < Math.floor(Date.now() / 1000)) return false;
  return constantTimeStringEquals(providedSignature, signExpiry(expiryEpochSeconds, configuration.sessionSigningSecret));
}

export function tryPasswordSignIn(context: Context, configuration: ServerConfiguration, submittedPassword: string): boolean {
  if (!configuration.editorPassword) return true;
  // Hash both sides first so comparison time doesn't leak the password length.
  const submittedDigest = createHmac("sha256", configuration.sessionSigningSecret).update(submittedPassword).digest();
  const expectedDigest = createHmac("sha256", configuration.sessionSigningSecret).update(configuration.editorPassword).digest();
  if (!timingSafeEqual(submittedDigest, expectedDigest)) return false;

  const expiryEpochSeconds = Math.floor(Date.now() / 1000) + configuration.sessionLifetimeSeconds;
  setCookie(context, SESSION_COOKIE_NAME, `${expiryEpochSeconds}.${signExpiry(expiryEpochSeconds, configuration.sessionSigningSecret)}`, {
    httpOnly: true,
    sameSite: "Lax",
    secure: requestArrivedOverHttps(context),
    path: "/",
    maxAge: configuration.sessionLifetimeSeconds,
  });
  return true;
}

export function signOut(context: Context): void {
  deleteCookie(context, SESSION_COOKIE_NAME, { path: "/" });
}

export function requireSession(configuration: ServerConfiguration): MiddlewareHandler {
  return async (context, next) => {
    if (!isSessionValid(context, configuration)) return context.json({ error: "Sign in required" }, 401);
    await next();
  };
}
