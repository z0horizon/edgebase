import { base64url } from "../http";
import type { PushPayload } from "./types";

const OAUTH_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_LIFETIME_SEC = 3600;
const REFRESH_BEFORE_MS = 300_000;

type ServiceAccount = { project_id: string; client_email: string; private_key: string };
export type FcmAccess = { token: string; projectId: string };
type CachedAccess = FcmAccess & { expiresAt: number };

// Module scope lives as long as the isolate, so one exchange serves many queue batches.
const cache = new Map<string, CachedAccess>();
const inflight = new Map<string, Promise<CachedAccess>>();

export function resetFcmCacheForTests(): void {
  cache.clear();
  inflight.clear();
}

async function signJwt(sa: ServiceAccount, now: number): Promise<string> {
  const iat = Math.floor(now / 1000);
  const enc = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: OAUTH_URL,
    scope: SCOPE,
    iat,
    exp: iat + TOKEN_LIFETIME_SEC,
  })}`;
  const pem = sa.private_key.replace(/-----[^-]+-----|\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

async function exchange(sa: ServiceAccount, now: number): Promise<CachedAccess> {
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await signJwt(sa, now),
    }).toString(),
  });
  if (!res.ok) throw new Error(`FCM OAuth exchange failed: ${res.status} ${await res.text()}`);
  const body = await res.json<{ access_token: string; expires_in: number }>();
  return {
    token: body.access_token,
    projectId: sa.project_id,
    expiresAt: now + body.expires_in * 1000,
  };
}

export async function getAccessToken(serviceAccountJson: string, now: number): Promise<FcmAccess> {
  const sa = JSON.parse(serviceAccountJson) as ServiceAccount;
  const key = sa.client_email;
  const cached = cache.get(key);
  if (cached && now < cached.expiresAt - REFRESH_BEFORE_MS) {
    return { token: cached.token, projectId: cached.projectId };
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = exchange(sa, now).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const fresh = await pending;
  cache.set(key, fresh);
  return { token: fresh.token, projectId: fresh.projectId };
}

export type FcmMessage = { message: Record<string, unknown> & { android: object; apns: object } };

export function buildFcmMessage(
  payload: PushPayload,
  target: { token: string } | { topic: string },
): FcmMessage {
  const marketing = payload.category === "marketing";
  return {
    message: {
      ...target,
      notification: { title: payload.title, body: payload.body },
      ...(payload.data ? { data: payload.data } : {}),
      android: {
        priority: marketing ? "NORMAL" : "HIGH",
        notification: { channel_id: marketing ? "promotions" : "default" },
      },
      apns: { headers: { "apns-priority": marketing ? "5" : "10" } },
    },
  };
}

export type SendResult =
  | { kind: "ok" }
  | { kind: "dead" }
  | { kind: "retry"; retryAfterSec: number | null }
  | { kind: "drop"; status: number; code: string };

const DEAD_CODES = new Set(["UNREGISTERED", "SENDER_ID_MISMATCH"]);
const RETRY_CODES = new Set(["UNAVAILABLE", "INTERNAL", "QUOTA_EXCEEDED"]);

type FcmErrorBody = {
  error?: { status?: string; details?: { "@type"?: string; errorCode?: string }[] };
};

export async function sendFcm(access: FcmAccess, message: FcmMessage): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(`https://fcm.googleapis.com/v1/projects/${access.projectId}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
      body: JSON.stringify(message),
    });
  } catch {
    return { kind: "retry", retryAfterSec: null };
  }
  if (res.ok) return { kind: "ok" };

  const body = await res.json<FcmErrorBody>().catch((): FcmErrorBody => ({}));
  const code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? "";
  if (res.status === 404 || DEAD_CODES.has(code)) return { kind: "dead" };
  if (code === "UNAUTHENTICATED") {
    // Our access token was rejected (e.g. the service account key was rotated): forget it.
    for (const [key, cached] of cache) if (cached.token === access.token) cache.delete(key);
    return { kind: "retry", retryAfterSec: null };
  }
  if (res.status === 429 || res.status >= 500 || RETRY_CODES.has(code)) {
    const retryAfter = Number(res.headers.get("retry-after"));
    return { kind: "retry", retryAfterSec: retryAfter > 0 ? retryAfter : null };
  }
  return { kind: "drop", status: res.status, code };
}
