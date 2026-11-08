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
