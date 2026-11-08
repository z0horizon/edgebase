import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { app } from "../src/app";

export const BASE = "https://api.test";

/** A request to the Worker that also waits for the work it left running. */
export async function call(path: string, init: RequestInit = {}, bindings: Env = env) {
  const ctx = createExecutionContext();
  const res = await app.request(`${BASE}${path}`, init, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
