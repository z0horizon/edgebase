import { expect, it } from "vitest";
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
