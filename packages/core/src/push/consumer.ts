import { buildFcmMessage, type FcmAccess, getAccessToken, type SendResult, sendFcm } from "./fcm";
import { recordDelivery } from "./stats";
import type { PushPayload, PushQueueMessage, PushTarget } from "./types";

type UserTargets = Exclude<PushQueueMessage, { kind: "topic" }>;

const CONCURRENCY = 20;
const MAX_ATTEMPTS = 5;
const MAX_DELAY_SEC = 3600;

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
  await db
    .prepare("DELETE FROM device WHERE token IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(tokens))
    .run();
}

const retriesLeft = (message: PushQueueMessage) => message.attempt + 1 < MAX_ATTEMPTS;

/** Retries go out as new messages so already-delivered tokens are never sent twice. */
async function retryLater(env: Env, message: PushQueueMessage, retryAfterSec: number | null) {
  const next = { ...message, attempt: message.attempt + 1 };
  if (!retriesLeft(message)) {
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

/** The push_stats row of a message; messages queued before push stats existed have none. */
const pushIdOf = (message: PushQueueMessage) => Number(message.payload.data?.["pushId"] ?? 0);

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
    const finalFailure = result.kind !== "ok" && !(result.kind === "retry" && retriesLeft(message));
    await recordDelivery(
      env.DB,
      pushIdOf(message),
      result.kind === "ok" ? 1 : 0,
      finalFailure ? 1 : 0,
    );
    return;
  }

  const targets = await targetsOf(env.DB, message);
  if (targets.length === 0) return;
  const payload: PushPayload = message.payload;
  const token = await access();
  const results = await mapLimit(targets, CONCURRENCY, (t) =>
    sendFcm(token, buildFcmMessage(payload, { token: t.token })),
  );

  let sent = 0;
  const dead: string[] = [];
  const retry: PushTarget[] = [];
  let retryAfterSec: number | null = null;
  results.forEach((result, i) => {
    const t = targets[i] as PushTarget;
    if (result.kind === "ok") sent++;
    if (result.kind === "dead") dead.push(t.token);
    if (result.kind === "retry") {
      retry.push(t);
      if (result.retryAfterSec !== null)
        retryAfterSec = Math.max(retryAfterSec ?? 0, result.retryAfterSec);
    }
    logDrop(result, t.token);
  });
  // The sends already happened: a failure from here on must not make Queues redeliver the whole
  // message to devices that got it. A lost retry or a dead token left behind is the lesser harm.
  try {
    const dropped = results.filter((r) => r.kind === "drop").length;
    const outOfRetries = retriesLeft(message) ? 0 : retry.length;
    await recordDelivery(env.DB, pushIdOf(message), sent, dead.length + dropped + outOfRetries);
    if (dead.length > 0) await deleteTokens(env.DB, dead);
    if (retry.length > 0) {
      await retryLater(
        env,
        { kind: "tokens", targets: retry, payload, attempt: message.attempt },
        retryAfterSec,
      );
    }
  } catch (error) {
    console.error("push follow-up failed after send", {
      dead: dead.length,
      retry: retry.length,
      error: String(error),
    });
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
