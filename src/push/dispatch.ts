import { insertBroadcast, insertPersonal } from "../inbox/queries";
import type { PushDispatch, PushPayload, PushQueueMessage } from "./types";

const IDS_PER_QUERY = 90;
const USERS_PER_MESSAGE = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Existing users among `ids`; for marketing, only those who opted in. */
async function eligibleUsers(db: D1Database, ids: string[], marketing: boolean): Promise<string[]> {
  const found: string[] = [];
  for (const part of chunk([...new Set(ids)], IDS_PER_QUERY)) {
    const rows = await db
      .prepare(
        `SELECT id FROM user WHERE id IN (${part.map(() => "?").join(", ")})${
          marketing ? " AND marketingOptIn = 1" : ""
        }`,
      )
      .bind(...part)
      .all<{ id: string }>();
    found.push(...rows.results.map((r) => r.id));
  }
  return found;
}

export async function dispatchPush(
  env: Env,
  req: PushDispatch,
  now: number,
): Promise<{ users: number }> {
  const payload: PushPayload = {
    title: req.title,
    body: req.body,
    category: req.category,
    ...(req.data ? { data: req.data } : {}),
  };

  if ("topic" in req.to) {
    if (req.inbox) await insertBroadcast(env.INBOX_DB, payload, now);
    const message: PushQueueMessage = { kind: "topic", topic: req.to.topic, payload, attempt: 0 };
    await env.PUSH_QUEUE.send(message);
    return { users: 0 };
  }

  const users = await eligibleUsers(env.DB, req.to.userIds, req.category === "marketing");
  if (users.length === 0) return { users: 0 };
  if (req.inbox) await insertPersonal(env.INBOX_DB, users, payload, now);
  await env.PUSH_QUEUE.sendBatch(
    chunk(users, USERS_PER_MESSAGE).map((userIds) => ({
      body: { kind: "users", userIds, payload, attempt: 0 } satisfies PushQueueMessage,
    })),
  );
  return { users: users.length };
}
