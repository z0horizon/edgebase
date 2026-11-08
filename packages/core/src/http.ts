import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as v from "valibot";

export function jsonError(status: ContentfulStatusCode, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** The validated JSON body, or a 400 response to return as is. */
export async function parseBody<S extends v.GenericSchema>(
  c: Context,
  schema: S,
): Promise<v.InferOutput<S> | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return jsonError(400, "invalid_body", "Body must be JSON");
  }
  const result = v.safeParse(schema, raw);
  if (!result.success) {
    return jsonError(400, "invalid_body", v.summarize(result.issues));
  }
  return result.output;
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

export function encodeCursor(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** The decoded cursor, or null when it is not one we issued. */
export function decodeCursor<S extends v.GenericSchema>(
  raw: string,
  schema: S,
): v.InferOutput<S> | null {
  try {
    const binary = atob(raw.replaceAll("-", "+").replaceAll("_", "/"));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
    const result = v.safeParse(schema, JSON.parse(json));
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}
