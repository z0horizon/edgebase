import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { app } from "../src/app";

export const BASE = "https://api.test";
export const PASSWORD = "pw-correct-horse-1";

/** A request to the Worker that also waits for the work it left running. */
export async function call(path: string, init: RequestInit = {}, bindings: Env = env) {
  const ctx = createExecutionContext();
  const res = await app.request(`${BASE}${path}`, init, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let ipCounter = 0;
/** A fresh client IP, so one test's auth calls never share AUTH_RL's budget with another's. */
export const freshIp = () => `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

export function json(body: unknown, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", "https://web.test");
  return { method: "POST", ...init, headers, body: JSON.stringify(body) };
}

export function authed(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/** A signed-in user whose email is already verified, with its bearer token. */
export async function signUpVerified(email: string): Promise<{ userId: string; token: string }> {
  const headers = { "cf-connecting-ip": freshIp() };
  const signUp = await call(
    "/api/auth/sign-up/email",
    json({ email, password: PASSWORD, name: email }, { headers }),
  );
  const { user } = await signUp.json<{ user: { id: string } }>();
  await env.DB.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").bind(user.id).run();
  const signIn = await call(
    "/api/auth/sign-in/email",
    json({ email, password: PASSWORD }, { headers }),
  );
  const token = signIn.headers.get("set-auth-token");
  if (!token) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  return { userId: user.id, token };
}

let userCounter = 0;
/** Inserts a verified user straight into D1 and returns its id. */
export async function seedUser(createdAt = Date.UTC(2026, 10, 1), extra = ""): Promise<string> {
  const id = `seed-${++userCounter}${extra}`;
  const iso = new Date(createdAt).toISOString();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(id, id, `${id}@seed.test`, iso, iso)
    .run();
  return id;
}

/** A queue producer that records what it was given instead of sending. */
export function fakeQueue() {
  const sent: { body: unknown; delaySeconds?: number | undefined }[] = [];
  const queue = {
    async send(body: unknown, options?: QueueSendOptions) {
      sent.push({ body, delaySeconds: options?.delaySeconds });
    },
    async sendBatch(messages: Iterable<MessageSendRequest>) {
      for (const m of messages) sent.push({ body: m.body, delaySeconds: m.delaySeconds });
    },
  };
  return { queue: queue as unknown as Queue, sent };
}

/** A Firebase service account with a fresh RSA key, as FCM_SERVICE_ACCOUNT holds it. */
export async function makeServiceAccount(): Promise<{ json: string; publicKey: CryptoKey }> {
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
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  const json = JSON.stringify({
    project_id: "demo-project",
    client_email: "push@demo-project.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
  });
  return { json, publicKey: pair.publicKey };
}
