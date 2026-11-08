import { buildFcmMessage, type FcmAccess, getAccessToken, type SendResult, sendFcm } from "./fcm";
import type { PushPayload, PushQueueMessage, PushTarget } from "./types";

type UserTargets = Exclude<PushQueueMessage, { kind: "topic" }>;

const CONCURRENCY = 20;
const MAX_ATTEMPTS = 5;
const MAX_DELAY_SEC = 3600;
const IDS_PER_QUERY = 90;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The current device rows behind a message. Retries re-check ownership, so a token that was
 * removed or moved to another user while the retry waited never gets the old user's push.
 */
async function targetsOf(db: D1Database, message: UserTargets): Promise<PushTarget[]> {
  if (message.kind === "users") {
    const rows = await db
      .prepare(
        `SELECT token, user_id FROM device WHERE user_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(JSON.stringify(message.userIds))
      .all<{ token: string; user_id: string }>();
    return rows.results.map((r) => ({ token: r.token, userId: r.user_id }));
  }
  const rows = await db
    .prepare(`SELECT token, user_id FROM device WHERE token IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(message.targets.map((t) => t.token)))
    .all<{ token: string; user_id: string }>();
  const owner = new Map(rows.results.map((r) => [r.token, r.user_id]));
  return message.targets.filter((t) => owner.get(t.token) === t.userId);
}

async function deleteTokens(db: D1Database, tokens: string[]): Promise<void> {
  for (let i = 0; i < tokens.length; i += IDS_PER_QUERY) {
    const part = tokens.slice(i, i + IDS_PER_QUERY);
    await db
      .prepare(`DELETE FROM device WHERE token IN (${part.map(() => "?").join(", ")})`)
      .bind(...part)
      .run();
  }
}

/** Retries go out as new messages so already-delivered tokens are never sent twice. */
async function retryLater(env: Env, message: PushQueueMessage, retryAfterSec: number | null) {
  const next = { ...message, attempt: message.attempt + 1 };
  if (next.attempt >= MAX_ATTEMPTS) {
    await env.PUSH_DLQ.send(next);
    return;
  }
  const delaySeconds = Math.min(retryAfterSec ?? 30 * 2 ** message.attempt, MAX_DELAY_SEC);
  await env.PUSH_QUEUE.send(next, { delaySeconds });
}

function logDrop(result: SendResult, target: string) {
  if (result.kind === "drop")
    console.error("fcm dropped", { target, status: result.status, code: result.code });
}

async function handleMessage(
  env: Env,
  access: () => Promise<FcmAccess>,
  message: PushQueueMessage,
): Promise<void> {
  if (message.kind === "topic") {
    const result = await sendFcm(
      await access(),
      buildFcmMessage(message.payload, { topic: message.topic }),
    );
    if (result.kind === "retry") await retryLater(env, message, result.retryAfterSec);
    logDrop(result, `topic:${message.topic}`);
    return;
  }

  const targets = await targetsOf(env.DB, message);
  if (targets.length === 0) return;
  const payload: PushPayload = message.payload;
  const token = await access();
  const results = await mapLimit(targets, CONCURRENCY, (t) =>
    sendFcm(token, buildFcmMessage(payload, { token: t.token })),
  );

  const dead: string[] = [];
  const retry: PushTarget[] = [];
  let retryAfterSec: number | null = null;
  results.forEach((result, i) => {
    const t = targets[i] as PushTarget;
    if (result.kind === "dead") dead.push(t.token);
    if (result.kind === "retry") {
      retry.push(t);
      if (result.retryAfterSec !== null)
        retryAfterSec = Math.max(retryAfterSec ?? 0, result.retryAfterSec);
    }
    logDrop(result, t.token);
  });
  if (dead.length > 0) await deleteTokens(env.DB, dead);
  if (retry.length > 0) {
    await retryLater(
      env,
      { kind: "tokens", targets: retry, payload, attempt: message.attempt },
      retryAfterSec,
    );
  }
}

export async function handlePushBatch(
  batch: MessageBatch<PushQueueMessage>,
  env: Env,
): Promise<void> {
  // Fetched lazily so a batch with nothing to send never calls Google.
  let access: Promise<FcmAccess> | undefined;
  const getAccess = () => {
    access ??= getAccessToken(env.FCM_SERVICE_ACCOUNT, Date.now());
    return access;
  };
  for (const message of batch.messages) {
    try {
      await handleMessage(env, getAccess, message.body);
      message.ack();
    } catch (error) {
      console.error("push message failed", { id: message.id, error: String(error) });
      // Queues' max_retries then moves it to the DLQ.
      message.retry();
    }
  }
}
