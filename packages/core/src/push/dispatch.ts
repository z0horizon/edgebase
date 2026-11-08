import { insertBroadcast, personalStatements } from "../inbox/queries";
import type { PushDispatch, PushPayload, PushQueueMessage, Translations } from "./types";

const IDS_PER_QUERY = 90;
const USERS_PER_MESSAGE = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Recipient = { id: string; locale: string | null };

/** Existing users among `ids`; for marketing, only those who opted in. */
async function eligibleUsers(
  db: D1Database,
  ids: string[],
  marketing: boolean,
): Promise<Recipient[]> {
  const found: Recipient[] = [];
  for (const part of chunk([...new Set(ids)], IDS_PER_QUERY)) {
    const rows = await db
      .prepare(
        `SELECT id, locale FROM user WHERE id IN (${part.map(() => "?").join(", ")})${
          marketing ? " AND marketingOptIn = 1" : ""
        }`,
      )
      .bind(...part)
      .all<Recipient>();
    found.push(...rows.results);
  }
  return found;
}

/** The translation key for a user's locale: exact tag, then its language, else "" (default text). */
export function pickLocale(available: Set<string>, locale: string | null): string {
  const tag = locale?.toLowerCase() ?? "";
  if (available.has(tag)) return tag;
  const language = tag.split("-")[0] ?? "";
  return available.has(language) ? language : "";
}

function groupByLocale(users: Recipient[], translations: Translations): Map<string, string[]> {
  const available = new Set(Object.keys(translations));
  const groups = new Map<string, string[]>();
  for (const user of users) {
    const key = pickLocale(available, user.locale);
    const ids = groups.get(key);
    if (ids) ids.push(user.id);
    else groups.set(key, [user.id]);
  }
  return groups;
}

/**
 * `pushId` (a push_stats row) is added to the push's data so apps can report opens.
 * `onInboxWritten` runs right after the inbox rows are stored, before anything is queued, so a
 * caller that retries a failed dispatch can avoid writing the inbox twice.
 */
export async function dispatchPush(
  env: Env,
  req: PushDispatch,
  now: number,
  pushId: number,
  onInboxWritten: () => Promise<void> = async () => {},
): Promise<{ users: number }> {
  // Translation keys are matched in lowercase; "" is the default text.
  const translations: Translations = Object.fromEntries(
    Object.entries(req.translations ?? {}).map(([tag, text]) => [tag.toLowerCase(), text]),
  );
  const payloadFor = (locale: string): PushPayload => ({
    ...(translations[locale] ?? { title: req.title, body: req.body }),
    category: req.category,
    data: { ...req.data, pushId: String(pushId) },
  });

  if ("topic" in req.to) {
    // A topic has no per-user locale; apps that need one subscribe to a topic per language.
    const payload = payloadFor("");
    if (req.inbox) {
      await insertBroadcast(env.INBOX_DB, payload, now);
      await onInboxWritten();
    }
    const message: PushQueueMessage = { kind: "topic", topic: req.to.topic, payload, attempt: 0 };
    await env.PUSH_QUEUE.send(message);
    return { users: 0 };
  }

  const users = await eligibleUsers(env.DB, req.to.userIds, req.category === "marketing");
  await env.DB.prepare("UPDATE push_stats SET users = ? WHERE id = ?")
    .bind(users.length, pushId)
    .run();
  if (users.length === 0) return { users: 0 };
  const groups = [...groupByLocale(users, translations)].map(([locale, userIds]) => ({
    payload: payloadFor(locale),
    userIds,
  }));
  if (req.inbox) {
    // One batch for every locale, so a failure leaves no inbox rows for a retry to duplicate.
    await env.INBOX_DB.batch(
      groups.flatMap((g) => personalStatements(env.INBOX_DB, g.userIds, g.payload, now)),
    );
    await onInboxWritten();
  }
  await env.PUSH_QUEUE.sendBatch(
    groups.flatMap(({ payload, userIds }) =>
      chunk(userIds, USERS_PER_MESSAGE).map((part) => ({
        body: { kind: "users", userIds: part, payload, attempt: 0 } satisfies PushQueueMessage,
      })),
    ),
  );
  return { users: users.length };
}
