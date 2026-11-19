import type { Context } from "hono";
import * as v from "valibot";
import type { AppEnv } from "./app";
import { jsonError, parseBody } from "./http";

const MAX_REQUESTS = 10;
/** What a sub-request inherits from the batch: who is calling and from where, nothing else. */
const FORWARDED_HEADERS = [
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

/** The URL of a sub-request, or null unless it stays on this origin under /v1/ and is not a batch. */
function target(path: string, base: string): URL | null {
  if (!path.startsWith("/v1/")) return null;
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith("/v1/")) return null;
  return /^\/v1\/batch\/?$/i.test(url.pathname) ? null : url;
}

/**
 * `POST /v1/batch`: up to 10 calls to `/v1/*` routes in one request, run in order inside the Worker
 * through `dispatch` (the app itself), so each passes the same session check, validation and
 * per-user limit as a direct call. It saves Worker requests; row reads and writes are unchanged.
 */
export function batch(
  dispatch: (req: Request, c: Context<AppEnv>) => Response | Promise<Response>,
) {
  return async (c: Context<AppEnv>) => {
    const body = await parseBody(c, BatchSchema);
    if (body instanceof Response) return body;
    const urls = body.requests.map((r) => target(r.path, c.req.url));
    if (urls.some((url) => url === null)) {
      return jsonError(
        400,
        "invalid_request",
        "Each path must be a /v1/ route other than /v1/batch",
      );
    }
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = c.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    const responses: { status: number; body: unknown }[] = [];
    for (const [i, r] of body.requests.entries()) {
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
}
