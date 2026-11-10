import * as v from "valibot";
import { preparePush } from "../push/dispatch";
import { pushStatsInsert } from "../push/stats";
import { type PushDispatch, PushDispatchSchema } from "../push/types";

const BATCH = 100;
/** How long a claim on a `scheduled_push` row lasts; a run that dies leaves it to the next one. */
export const CLAIM_MS = 90_000;

function parseRequest(raw: string): PushDispatch | null {
  try {
    const result = v.safeParse(PushDispatchSchema, JSON.parse(raw));
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}

/**
 * Moves a row's `send_at` from `from` to a fresh claim, only if nobody changed it since: the
 * claim value is the row's `send_at`, and every new claim is later than the last.
 * Returns the claim, or null when another run holds the row.
 */
async function claim(db: D1Database, id: number, from: number): Promise<number | null> {
  // Wall clock, not `now`: like cleanup's budget, a claim measures real time spent sending.
  const until = Math.max(Date.now() + CLAIM_MS, from + 1);
  const result = await db
    .prepare("UPDATE scheduled_push SET send_at = ? WHERE id = ? AND send_at = ?")
    .bind(until, id, from)
    .run();
  return result.meta.changes > 0 ? until : null;
}

/**
 * Sends a stored push whose row the caller has claimed (`claimed` is the row's `send_at`), then
 * deletes the row. Safe to repeat: the inbox is written once per push, and only the holder of
 * a still-valid claim queues. Returns null when another run took the row over; it sends instead.
 * If it throws, the row stays and is retried once the claim runs out.
 */
export async function deliverStored(
  env: Env,
  row: { id: number; request: PushDispatch; pushId: number; claimed: number },
  now: number,
): Promise<{ users: number } | null> {
  const { users, messages } = await preparePush(env, row.request, now, row.pushId);
  // Renewed right before queueing, so the queue call always runs inside a full claim.
  const held = await claim(env.DB, row.id, row.claimed);
  if (held === null) return null;
  if (messages.length > 0) await env.PUSH_QUEUE.sendBatch(messages);
  await env.DB.prepare("DELETE FROM scheduled_push WHERE id = ? AND send_at = ?")
    .bind(row.id, held)
    .run();
  return { users };
}

/** Claims and sends `scheduled_push` rows that are due; returns how many were sent. */
export async function enqueueDuePushes(env: Env, now: number): Promise<number> {
  const due = await env.DB.prepare(
    "SELECT id, request, push_id, send_at FROM scheduled_push WHERE send_at <= ? ORDER BY send_at LIMIT ?",
  )
    .bind(now, BATCH)
    .all<{ id: number; request: string; push_id: number | null; send_at: number }>();

  let dispatched = 0;
  for (const row of due.results) {
    const request = parseRequest(row.request);
    if (!request) {
      console.error("dropping invalid scheduled push", { id: row.id });
      await env.DB.prepare("DELETE FROM scheduled_push WHERE id = ?").bind(row.id).run();
      continue;
    }
    const claimed = await claim(env.DB, row.id, row.send_at);
    if (claimed === null) continue;
    try {
      // Rows stored before push stats existed get one, kept so a failed send does not make another.
      let pushId = row.push_id;
      if (pushId === null) {
        const [stats] = await env.DB.batch<{ id: number }>([
          pushStatsInsert(env.DB, request.category, row.send_at),
          env.DB.prepare(
            "UPDATE scheduled_push SET push_id = last_insert_rowid() WHERE id = ?",
          ).bind(row.id),
        ]);
        const id = stats?.results[0]?.id;
        if (id === undefined) throw new Error("push_stats insert returned no id");
        pushId = id;
      }
      if (await deliverStored(env, { id: row.id, request, pushId, claimed }, now)) dispatched++;
    } catch (error) {
      // The claim pushed send_at back, so this row waits behind the others instead of blocking them.
      console.error("scheduled push failed; retried after its claim", {
        id: row.id,
        error: String(error),
      });
    }
  }
  return dispatched;
}
