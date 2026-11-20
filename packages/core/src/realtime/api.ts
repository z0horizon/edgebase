import type { ExecutionContext } from "hono";
import * as v from "valibot";
import { app } from "../app";
import { target } from "../batch";
import { metered, sampled } from "../db/metrics";

import type { ApiCaller } from "./caller";

export { type ApiCaller, MAX_CALLER_CHARS } from "./caller";
/** Largest request message, before parsing: the 64 KB body cap plus its envelope. */
export const MAX_API_MESSAGE_CHARS = 70 * 1024;
/** Calls one socket may have running at once. */
export const MAX_CALLS_IN_FLIGHT = 10;
/** API calls running at once in one hub, over all its sockets. */
export const MAX_HUB_CALLS_IN_FLIGHT = 200;

/** Calls running per socket and in the whole hub; a call takes a slot and gives it back. */
export class CallSlots<K extends object> {
  private perKey = new WeakMap<K, number>();
  private total = 0;

  constructor(
    private readonly maxPerKey = MAX_CALLS_IN_FLIGHT,
    private readonly maxTotal = MAX_HUB_CALLS_IN_FLIGHT,
  ) {}

  /** Takes a slot for `key`, or answers false when it or the hub has none left. */
  take(key: K): boolean {
    const running = this.perKey.get(key) ?? 0;
    if (running >= this.maxPerKey || this.total >= this.maxTotal) return false;
    this.perKey.set(key, running + 1);
    this.total++;
    return true;
  }

  give(key: K): void {
    this.perKey.set(key, Math.max(0, (this.perKey.get(key) ?? 1) - 1));
    this.total = Math.max(0, this.total - 1);
  }
}

export const ApiRequestSchema = v.object({
  type: v.literal("request"),
  data: v.object({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    method: v.picklist(["GET", "POST", "PUT", "DELETE"]),
    path: v.pipe(v.string(), v.maxLength(2048)),
    body: v.optional(v.unknown()),
    idempotencyKey: v.optional(v.pipe(v.string(), v.maxLength(256))),
  }),
});
export type ApiRequest = v.InferOutput<typeof ApiRequestSchema>["data"];

/** The URL of a call, or null unless it is a /v1/ route other than /v1/batch and /v1/realtime*. */
export function apiTarget(path: string, base: string): URL | null {
  const url = target(path, base);
  return url && !/^\/v1\/realtime(\/|$)/i.test(url.pathname) ? url : null;
}

/**
 * Runs one call through the app itself, with the caller's auth, origin, IP and network from the
 * upgrade, so it passes the same session check, validation and per-user limit as over HTTP.
 */
export async function callApi(
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
  caller: ApiCaller,
  url: URL,
  call: ApiRequest,
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(caller.headers);
  const init: RequestInit & { cf?: unknown } = { method: call.method, headers };
  if (call.body !== undefined && call.method !== "GET") {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(call.body);
  }
  if (call.idempotencyKey !== undefined) headers.set("idempotency-key", call.idempotencyKey);
  // The caller's network as Cloudflare saw it on the upgrade, for session activity and alerts.
  if (caller.cf) init.cf = caller.cf as NonNullable<RequestInit["cf"]>;
  const ctx: ExecutionContext = { waitUntil, passThroughOnException() {}, props: {} };
  const res = await metered(
    env,
    sampled(),
    { via: "socket", path: url.pathname },
    (e, c) => Promise.resolve(app.fetch(new Request(url, init as RequestInit), e, c ?? ctx)),
    ctx,
  );
  const text = await res.text();
  const isJson = /^application\/([a-z0-9.+-]*\+)?json\b/i.test(
    res.headers.get("content-type") ?? "",
  );
  return { status: res.status, body: text === "" ? null : isJson ? JSON.parse(text) : text };
}
