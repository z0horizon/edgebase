import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildFcmMessage, getAccessToken, resetFcmCacheForTests, sendFcm } from "../src/push/fcm";

const NOW = Date.UTC(2026, 10, 8);
let SA = "";
let PUBLIC_KEY: CryptoKey;

async function makeServiceAccount(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  PUBLIC_KEY = pair.publicKey;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  return JSON.stringify({
    project_id: "demo-project",
    client_email: "push@demo-project.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
  });
}

/** Stubs Google's OAuth and FCM endpoints; returns the list of OAuth exchanges seen. */
function stubGoogle(fcm: () => Response = () => Response.json({ name: "m/1" })) {
  const exchanges: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    if (url === "https://oauth2.googleapis.com/token") {
      exchanges.push(String(init?.body));
      return Response.json({ access_token: `at-${exchanges.length}`, expires_in: 3600 });
    }
    return fcm();
  });
  return exchanges;
}

const fcmError = (status: number, errorCode: string, headers: HeadersInit = {}) =>
  Response.json(
    {
      error: {
        code: status,
        status: errorCode,
        details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }],
      },
    },
    { status, headers },
  );

beforeAll(async () => {
  SA = await makeServiceAccount();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetFcmCacheForTests();
});

describe("getAccessToken", () => {
  it("two concurrent callers trigger one OAuth exchange", async () => {
    const exchanges = stubGoogle();
    const [a, b] = await Promise.all([getAccessToken(SA, NOW), getAccessToken(SA, NOW)]);
    expect(exchanges).toHaveLength(1);
    expect(a).toEqual({ token: "at-1", projectId: "demo-project" });
    expect(b.token).toBe("at-1");
    expect(exchanges[0]).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
    );
  });

  it("reuses the token until 5 minutes before expiry, then refreshes", async () => {
    const exchanges = stubGoogle();
    await getAccessToken(SA, NOW);
    expect((await getAccessToken(SA, NOW + 3_299_000)).token).toBe("at-1");
    expect((await getAccessToken(SA, NOW + 3_300_000)).token).toBe("at-2");
    expect(exchanges).toHaveLength(2);
  });
});

it("the OAuth assertion is an RS256 JWT signed by the service account key", async () => {
  const exchanges = stubGoogle();
  await getAccessToken(SA, NOW);
  const jwt = new URLSearchParams(exchanges[0]).get("assertion") ?? "";
  const [header, claims, sig] = jwt.split(".") as [string, string, string];
  const decode = (part: string) =>
    Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    PUBLIC_KEY,
    decode(sig),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  expect(valid).toBe(true);
  expect(JSON.parse(new TextDecoder().decode(decode(claims)))).toMatchObject({
    iss: "push@demo-project.iam.gserviceaccount.com",
    aud: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    exp: NOW / 1000 + 3600,
  });
});

describe("sendFcm", () => {
  const access = { token: "at", projectId: "demo-project" };
  const message = buildFcmMessage(
    { title: "t", body: "b", category: "transactional" },
    { token: "tok" },
  );

  it.each([
    [404, "UNREGISTERED", "dead"],
    [403, "SENDER_ID_MISMATCH", "dead"],
    [429, "QUOTA_EXCEEDED", "retry"],
    [500, "INTERNAL", "retry"],
    [503, "UNAVAILABLE", "retry"],
    [400, "INVALID_ARGUMENT", "drop"],
    [401, "THIRD_PARTY_AUTH_ERROR", "drop"],
  ])("FCM %i %s → %s", async (status, code, kind) => {
    stubGoogle(() => fcmError(status, code));
    expect((await sendFcm(access, message)).kind).toBe(kind);
  });

  it("success → ok, posted to the project's send URL with the bearer token", async () => {
    const spy = stubGoogle();
    expect(await sendFcm(access, message)).toEqual({ kind: "ok" });
    expect(spy).toHaveLength(0);
    const [input, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(input)).toBe("https://fcm.googleapis.com/v1/projects/demo-project/messages:send");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer at");
  });

  it("reads Retry-After seconds", async () => {
    stubGoogle(() => fcmError(429, "QUOTA_EXCEEDED", { "retry-after": "120" }));
    expect(await sendFcm(access, message)).toEqual({ kind: "retry", retryAfterSec: 120 });
  });

  it("a network error → retry with no delay hint", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    expect(await sendFcm(access, message)).toEqual({ kind: "retry", retryAfterSec: null });
  });
});

describe("buildFcmMessage", () => {
  it("transactional maps to HIGH / default / apns 10", () => {
    const m = buildFcmMessage({ title: "t", body: "b", category: "transactional" }, { token: "x" });
    expect(m.message.android).toEqual({
      priority: "HIGH",
      notification: { channel_id: "default" },
    });
    expect(m.message.apns).toEqual({ headers: { "apns-priority": "10" } });
  });

  it("marketing maps to NORMAL / promotions / apns 5 and keeps data and topic", () => {
    const m = buildFcmMessage(
      { title: "t", body: "b", data: { k: "v" }, category: "marketing" },
      { topic: "all" },
    );
    expect(m.message).toMatchObject({
      topic: "all",
      notification: { title: "t", body: "b" },
      data: { k: "v" },
      android: { priority: "NORMAL", notification: { channel_id: "promotions" } },
      apns: { headers: { "apns-priority": "5" } },
    });
  });
});
