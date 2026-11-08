import { buildFcmMessage, type FcmAccess, getAccessToken, type SendResult, sendFcm } from "./fcm";
import type { PushPayload, PushQueueMessage } from "./types";

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

async function tokensOf(db: D1Database, userIds: string[]): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT token FROM device WHERE user_id IN (${userIds.map(() => "?").join(", ")})`)
    .bind(...userIds)
    .all<{ token: string }>();
  return rows.results.map((r) => r.token);
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

  const tokens =
    message.kind === "users" ? await tokensOf(env.DB, message.userIds) : message.tokens;
  if (tokens.length === 0) return;
  const payload: PushPayload = message.payload;
  const token = await access();
  const results = await mapLimit(tokens, CONCURRENCY, (t) =>
    sendFcm(token, buildFcmMessage(payload, { token: t })),
  );

  const dead: string[] = [];
  const retry: string[] = [];
  let retryAfterSec: number | null = null;
  results.forEach((result, i) => {
    const t = tokens[i] as string;
    if (result.kind === "dead") dead.push(t);
    if (result.kind === "retry") {
      retry.push(t);
      if (result.retryAfterSec !== null)
        retryAfterSec = Math.max(retryAfterSec ?? 0, result.retryAfterSec);
    }
    logDrop(result, t);
  });
  if (dead.length > 0) await deleteTokens(env.DB, dead);
  if (retry.length > 0) {
    await retryLater(
      env,
      { kind: "tokens", tokens: retry, payload, attempt: message.attempt },
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
