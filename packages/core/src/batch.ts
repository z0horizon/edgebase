import type { Context } from "hono";
import * as v from "valibot";
import type { AppEnv } from "./app";
import { jsonError, parseBody } from "./http";
import { idempotencyKey, runOnce } from "./idempotency";

const MAX_REQUESTS = 10;
// A replayed answer larger than this keeps each call's status but not its body.
const MAX_STORED_CHARS = 64 * 1024;
/** What a sub-request inherits from the batch: who is calling and from where, nothing else. */
export const FORWARDED_HEADERS = [
  "authorization",
  "cookie",
  "origin",
  "cf-connecting-ip",
  "user-agent",
  "accept-language",
];

const BatchSchema = v.object({
  requests: v.pipe(
    v.array(
      v.object({
        method: v.picklist(["GET", "POST", "PUT", "DELETE"]),
        path: v.pipe(v.string(), v.maxLength(2048)),
        body: v.optional(v.unknown()),
      }),
    ),
    v.minLength(1),
    v.maxLength(MAX_REQUESTS),
  ),
});

type BatchRequest = v.InferOutput<typeof BatchSchema>["requests"][number];
type BatchAnswer = { responses: { status: number; body: unknown }[] };

/** The URL of a sub-request, or null unless it stays on this origin under /v1/ and is not a batch. */
export function target(path: string, base: string): URL | null {
  if (!path.startsWith("/v1/")) return null;
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith("/v1/")) return null;
  return /^\/v1\/batch\/?$/i.test(url.pathname) ? null : url;
}

/**
 * `POST /v1/batch`: up to 10 calls to `/v1/*` routes in one request, run in order inside the Worker
 * through `dispatch` (the app itself), so each passes the same session check, validation and
 * per-user limit as a direct call. It saves Worker requests; row reads and writes are unchanged.
 * With an `Idempotency-Key` header the whole answer is kept for 24 h and replayed to a repeat, so a
 * retry after a timeout does not run the writes again.
 */
export function batch(
  dispatch: (req: Request, c: Context<AppEnv>) => Response | Promise<Response>,
) {
  const run = async (c: Context<AppEnv>, requests: BatchRequest[], urls: URL[]) => {
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = c.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    const responses: BatchAnswer["responses"] = [];
    for (const [i, r] of requests.entries()) {
      const init: RequestInit & { cf?: unknown } = {
        method: r.method,
        headers: new Headers(headers),
      };
      if (r.body !== undefined && r.method !== "GET") {
        (init.headers as Headers).set("content-type", "application/json");
        init.body = JSON.stringify(r.body);
      }
      // The caller's network (ASN, country) as Cloudflare saw it on the batch request.
      if (c.req.raw.cf) init.cf = c.req.raw.cf;
      const res = await dispatch(new Request(urls[i] as URL, init as RequestInit), c);
      const text = await res.text();
      const isJson = /^application\/([a-z0-9.+-]*\+)?json\b/i.test(
        res.headers.get("content-type") ?? "",
      );
      responses.push({
        status: res.status,
        body: text === "" ? null : isJson ? (JSON.parse(text) as unknown) : text,
      });
    }
    return c.json({ responses });
  };
  return async (c: Context<AppEnv>) => {
    const key = idempotencyKey(c.req.header("idempotency-key"));
    if (key instanceof Response) return key;
    const body = await parseBody(c, BatchSchema);
    if (body instanceof Response) return body;
    const urls = body.requests.map((r) => target(r.path, c.req.url)).filter((url) => url !== null);
    if (urls.length !== body.requests.length) {
      return jsonError(
        400,
        "invalid_request",
        "Each path must be a /v1/ route other than /v1/batch",
      );
    }
    if (key === undefined) return run(c, body.requests, urls);
    // Keys are per user: nobody can replay, or collide with, another account's batch.
    return runOnce(
      c.env.DB,
      {
        key: `batch:${c.get("user").id}:${key}`,
        body,
        now: Date.now(),
        okStatus: 200,
        scope: "batch",
        stored: (text) =>
          text.length <= MAX_STORED_CHARS
            ? text
            : JSON.stringify({
                responses: (JSON.parse(text) as BatchAnswer).responses.map((r) => ({
                  status: r.status,
                  body: null,
                })),
                truncated: true,
              }),
      },
      () => run(c, body.requests, urls),
    );
  };
}
