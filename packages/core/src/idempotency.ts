import * as v from "valibot";
import { base64url, jsonError, sha256 } from "./http";

export const IdempotencyKeySchema = v.pipe(v.string(), v.regex(/^[\x21-\x7e]{1,255}$/));

/** The `Idempotency-Key` header: undefined when absent, a 400 response when malformed. */
export function idempotencyKey(header: string | undefined): string | undefined | Response {
  if (header === undefined || v.is(IdempotencyKeySchema, header)) return header;
  return jsonError(400, "invalid_header", "Idempotency-Key must be 1-255 printable characters");
}

/**
 * Runs `run` once per `key`: its answer with `okStatus` is kept in `push_idempotency` for 24 h
 * (cleanup removes it) and replayed to every repeat, so a client that retries after a timeout
 * never does the work twice. Any other answer, or a throw, frees the key for a corrected retry.
 * `stored` may shrink what is kept; `scope` names the log event.
 */
export async function runOnce(
  db: D1Database,
  o: {
    key: string;
    body: unknown;
    now: number;
    okStatus: number;
    scope: string;
    stored?: (text: string) => string;
  },
  run: () => Promise<Response>,
): Promise<Response> {
  const hash = base64url(await sha256(JSON.stringify(o.body)));
  const claimed = await db
    .prepare(
      `INSERT INTO push_idempotency (key, request_hash, created_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    )
    .bind(o.key, hash, o.now)
    .run();
  if (claimed.meta.changes === 0) {
    const prior = await db
      .prepare("SELECT request_hash, response FROM push_idempotency WHERE key = ?")
      .bind(o.key)
      .first<{ request_hash: string; response: string | null }>();
    if (prior && prior.request_hash !== hash) {
      return jsonError(422, "idempotency_mismatch", "Idempotency-Key was used with another body");
    }
    if (!prior?.response) {
      return jsonError(409, "idempotency_in_progress", "A request with this key is still running");
    }
    return new Response(prior.response, {
      status: o.okStatus,
      headers: { "content-type": "application/json", "idempotent-replayed": "true" },
    });
  }

  const free = () => db.prepare("DELETE FROM push_idempotency WHERE key = ?").bind(o.key).run();
  let res: Response;
  try {
    res = await run();
  } catch (error) {
    // Free the key so the client's retry runs instead of waiting out the 24 h.
    await free();
    throw error;
  }
  if (res.status === o.okStatus) {
    try {
      const text = await res.clone().text();
      await db
        .prepare("UPDATE push_idempotency SET response = ? WHERE key = ?")
        .bind(o.stored ? o.stored(text) : text, o.key)
        .run();
    } catch (error) {
      // The work is done; a 500 here would make the caller repeat it without a key.
      console.error({
        event: `${o.scope}_idempotency_save_failed`,
        key: o.key,
        error: String(error),
      });
    }
  } else {
    // Nothing was done; the corrected request may reuse the key.
    await free();
  }
  return res;
}
