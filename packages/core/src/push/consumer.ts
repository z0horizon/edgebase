import { buildFcmMessage, type FcmAccess, getAccessToken, type SendResult, sendFcm } from "./fcm";
import { recordDeliveries } from "./stats";
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
 * The current device rows behind a message. Delivery and retries re-check ownership and marketing
 * opt-in, so a removed/reassigned token or an opted-out user never gets the push.
 */
async function targetsOf(db: D1Database, message: UserTargets): Promise<PushTarget[]> {
  const marketing = message.payload.category === "marketing";
  const col = message.kind === "users" ? "d.user_id" : "d.token";
  const keys = message.kind === "users" ? message.userIds : message.targets.map((t) => t.token);
  const join = marketing ? "JOIN user u ON u.id = d.user_id" : "";
  const optIn = marketing ? "AND u.marketingOptIn = 1" : "";
  const rows = await db
    .prepare(
      `SELECT d.token, d.user_id FROM device d ${join}
       WHERE ${col} IN (SELECT value FROM json_each(?)) ${optIn}`,
    )
    .bind(JSON.stringify(keys))
    .all<{ token: string; user_id: string }>();
  if (message.kind === "users")
    return rows.results.map((r) => ({ token: r.token, userId: r.user_id }));
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
    console.error({ event: "fcm_dropped", target, status: result.status, code: result.code });
}

/** Stats for FCM's answers: accepted, and finally failed (refused, or out of retries). */
function tally(results: SendResult[], message: PushQueueMessage) {
  const final = (r: SendResult) =>
    r.kind === "dead" || r.kind === "drop" || (r.kind === "retry" && !retriesLeft(message));
  return {
    sent: results.filter((r) => r.kind === "ok").length,
    failed: results.filter(final).length,
  };
}

/** The push_stats row of a message; messages queued before push stats existed have none. */
const pushIdOf = (message: PushQueueMessage) => Number(message.payload.data?.["pushId"] ?? 0);

type DeliveryDelta = { pushId: number; sent: number; failed: number };

async function handleMessage(
  env: Env,
  access: () => Promise<FcmAccess>,
  message: PushQueueMessage,
): Promise<DeliveryDelta> {
  const pushId = pushIdOf(message);
  if (message.kind === "topic") {
    const result = await sendFcm(
      await access(),
      buildFcmMessage(message.payload, { topic: message.topic }),
    );
    if (result.kind === "retry") await retryLater(env, message, result.retryAfterSec);
    logDrop(result, `topic:${message.topic}`);
    return { pushId, ...tally([result], message) };
  }

  const targets = await targetsOf(env.DB, message);
  if (targets.length === 0) return { pushId, sent: 0, failed: 0 };
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
  const counts = tally(results, message);
  // The sends already happened: a failure from here on must not make Queues redeliver the whole
  // message to devices that got it. A lost retry or a dead token left behind is the lesser harm.
  try {
    if (dead.length > 0) await deleteTokens(env.DB, dead);
    if (retry.length > 0) {
      await retryLater(
        env,
        { kind: "tokens", targets: retry, payload, attempt: message.attempt },
        retryAfterSec,
      );
    }
  } catch (error) {
    console.error({
      event: "push_followup_failed",
      dead: dead.length,
      retry: retry.length,
      error: String(error),
    });
  }
  return { pushId, ...counts };
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
  const totals = new Map<number, { sent: number; failed: number }>();
  for (const message of batch.messages) {
    try {
      const { pushId, sent, failed } = await handleMessage(env, getAccess, message.body);
      if (pushId && (sent > 0 || failed > 0)) {
        const cur = totals.get(pushId);
        if (cur) {
          cur.sent += sent;
          cur.failed += failed;
        } else {
          totals.set(pushId, { sent, failed });
        }
      }
      message.ack();
    } catch (error) {
      console.error({ event: "push_message_failed", id: message.id, error: String(error) });
      // Queues' max_retries then moves it to the DLQ.
      message.retry();
    }
  }
  await recordDeliveries(env.DB, totals);
}
