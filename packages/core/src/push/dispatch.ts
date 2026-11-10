import { broadcastStatement, personalStatements, writeInboxOnce } from "../inbox/queries";
import type { PushDispatch, PushPayload, PushQueueMessage, Translations } from "./types";

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
  // One JSON parameter keeps any number of ids under D1's 100 bound parameters.
  const rows = await db
    .prepare(
      `SELECT id, locale FROM user WHERE id IN (SELECT value FROM json_each(?))${
        marketing ? " AND marketingOptIn = 1" : ""
      }`,
    )
    .bind(JSON.stringify(ids))
    .all<Recipient>();
  return rows.results;
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

type Prepared = { users: number; messages: { body: PushQueueMessage }[] };

/**
 * Stores the push's inbox rows (once per `pushId`, however often it is called) and returns the
 * queue messages to send; queueing is left to the caller holding the push's claim.
 * `pushId` (a push_stats row) is added to the push's data so apps can report opens.
 */
export async function preparePush(
  env: Env,
  req: PushDispatch,
  now: number,
  pushId: number,
): Promise<Prepared> {
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
      await writeInboxOnce(
        env.INBOX_DB,
        pushId,
        [broadcastStatement(env.INBOX_DB, payload, now)],
        now,
      );
    }
    return {
      users: 0,
      messages: [{ body: { kind: "topic", topic: req.to.topic, payload, attempt: 0 } }],
    };
  }

  const users = await eligibleUsers(env.DB, req.to.userIds, req.category === "marketing");
  await env.DB.prepare("UPDATE push_stats SET users = ? WHERE id = ?")
    .bind(users.length, pushId)
    .run();
  if (users.length === 0) return { users: 0, messages: [] };
  const groups = [...groupByLocale(users, translations)].map(([locale, userIds]) => ({
    payload: payloadFor(locale),
    userIds,
  }));
  if (req.inbox) {
    // One transaction for every locale, so a failure leaves no partial inbox behind.
    await writeInboxOnce(
      env.INBOX_DB,
      pushId,
      groups.flatMap((g) => personalStatements(env.INBOX_DB, g.userIds, g.payload, now)),
      now,
    );
  }
  return {
    users: users.length,
    messages: groups.flatMap(({ payload, userIds }) =>
      chunk(userIds, USERS_PER_MESSAGE).map((part) => ({
        body: { kind: "users", userIds: part, payload, attempt: 0 } satisfies PushQueueMessage,
      })),
    ),
  };
}
