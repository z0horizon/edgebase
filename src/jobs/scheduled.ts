import * as v from "valibot";
import { dispatchPush } from "../push/dispatch";
import { PushDispatchSchema } from "../push/types";

const BATCH = 100;

function parseRequest(raw: string): v.InferOutput<typeof PushDispatchSchema> | null {
  try {
    const result = v.safeParse(PushDispatchSchema, JSON.parse(raw));
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}

/** Dispatches scheduled pushes that are due; returns how many were dispatched. */
export async function enqueueDuePushes(env: Env, now: number): Promise<number> {
  const due = await env.DB.prepare(
    "SELECT id, request FROM scheduled_push WHERE send_at <= ? ORDER BY send_at LIMIT ?",
  )
    .bind(now, BATCH)
    .all<{ id: number; request: string }>();

  let dispatched = 0;
  for (const row of due.results) {
    const request = parseRequest(row.request);
    if (request) {
      // Once the inbox is written, the stored request drops it, so a retry only sends the push.
      await dispatchPush(env, request, now, async () => {
        await env.DB.prepare("UPDATE scheduled_push SET request = ? WHERE id = ?")
          .bind(JSON.stringify({ ...request, inbox: false }), row.id)
          .run();
      });
      dispatched++;
    } else {
      console.error("dropping invalid scheduled push", { id: row.id });
    }
    // Deleted only after dispatch, so a failed dispatch is retried on the next minute.
    await env.DB.prepare("DELETE FROM scheduled_push WHERE id = ?").bind(row.id).run();
  }
  return dispatched;
}
