import type { Context } from "hono";
import * as v from "valibot";
import type { AppEnv } from "./app";
import { adminNeedsTwoFactor } from "./auth/auth";
import { parseBody } from "./http";
import { listInboxWithUnread, markAllRead, markRead } from "./inbox/queries";
import { inboxQuery, personalId } from "./inbox/routes";
import { DeviceSchema, upsertDevice } from "./push/devices";
import { PushIdSchema, recordOpens } from "./push/stats";

/** `GET /v1/me` and the `user` of `POST /v1/sync`. */
export function mePayload(c: Context<AppEnv>) {
  const user = c.get("user");
  return {
    ...user,
    adminNeedsTwoFactor: adminNeedsTwoFactor({ user, session: c.get("session") }),
  };
}

const SyncSchema = v.object({
  device: v.optional(DeviceSchema),
  opens: v.optional(v.pipe(v.array(PushIdSchema), v.maxLength(20))),
  read: v.optional(v.pipe(v.array(v.string()), v.maxLength(100))),
  readAll: v.optional(v.boolean()),
  inbox: v.optional(
    v.union([
      v.literal(false),
      v.object({
        limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
      }),
    ]),
  ),
});

/**
 * What an app does when it comes to the foreground, in one request instead of three to five:
 * register the device token, report opened pushes, mark inbox items read, then return the user
 * and the first inbox page with its unread count. Every part is optional and behaves like the
 * route it stands for (`PUT /v1/devices`, `POST /v1/opens`, `POST /v1/inbox/read[-all]`,
 * `GET /v1/me`, `GET /v1/inbox`); writes land before the inbox is read.
 */
export async function sync(c: Context<AppEnv>) {
  const body = await parseBody(c, SyncSchema);
  if (body instanceof Response) return body;
  const userId = c.get("user").id;
  const now = Date.now();
  const read = (body.read ?? []).map(personalId).filter((id) => id !== null);
  await Promise.all([
    body.device && upsertDevice(c.env.DB, { ...body.device, userId }, now),
    recordOpens(c.env.DB, userId, body.opens ?? []),
    body.readAll
      ? markAllRead(c.env.INBOX_DB, userId, now)
      : markRead(c.env.INBOX_DB, userId, read, now),
  ]);
  const inbox =
    body.inbox === false
      ? undefined
      : await listInboxWithUnread(c.env.INBOX_DB, {
          ...inboxQuery(c),
          cursor: null,
          limit: body.inbox?.limit ?? 20,
        });
  return c.json({ user: mePayload(c), ...(inbox && { inbox }) });
}
