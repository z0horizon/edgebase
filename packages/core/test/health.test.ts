import { env } from "cloudflare:workers";
import * as v from "valibot";
import { expect, it } from "vitest";
import { base64url, decodeCursor, encodeCursor } from "../src/http";
import { call } from "./helpers";

it("GET /health answers 200 ok", async () => {
  const res = await call("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

it("unknown route answers 404 in the error shape", async () => {
  const res = await call("/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
});

it("a CORS preflight from a trusted web origin is allowed with credentials", async () => {
  const res = await call("/v1/inbox", {
    method: "OPTIONS",
    headers: {
      origin: "https://web.test",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("https://web.test");
  expect(res.headers.get("access-control-allow-credentials")).toBe("true");
});

it("an untrusted origin gets no CORS grant", async () => {
  const res = await call("/health", { headers: { origin: "https://evil.test" } });
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

it("the bearer token header is readable cross-origin", async () => {
  const res = await call("/health", { headers: { origin: "https://web.test" } });
  expect(res.headers.get("access-control-expose-headers")).toContain("set-auth-token");
});

it("base64url encodes buffers larger than the call-stack spread limit", () => {
  const bytes = new Uint8Array(200_000).fill(0xab);
  expect(base64url(bytes)).toHaveLength(Math.ceil((bytes.length * 4) / 3));
  const large = "x".repeat(150_000);
  expect(decodeCursor(encodeCursor(large), v.string())).toBe(large);
});

it("an unhandled error answers 500 internal without leaking details", async () => {
  const broken = {
    ...env,
    FCM_SERVICE_ACCOUNT: "{}",
    DB: {
      prepare() {
        throw new Error("secret d1 internals");
      },
    } as unknown as D1Database,
  };
  const res = await call("/v1/templates", { headers: { "x-api-key": env.PUSH_API_KEY } }, broken);
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({
    error: { code: "internal", message: "Internal error" },
  });
});
