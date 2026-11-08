import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { decodeCursor, jsonError, parseBody } from "../http";
import { type Cursor, deleteItem, listInbox, markAllRead, markRead, unreadCount } from "./queries";

const CursorSchema = v.object({
  t: v.pipe(v.number(), v.integer()),
  k: v.picklist([0, 1]),
  i: v.pipe(v.number(), v.integer()),
});
const ReadSchema = v.object({ ids: v.pipe(v.array(v.string()), v.maxLength(100)) });

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isNaN(n) ? DEFAULT_LIMIT : Math.min(Math.max(n, 1), MAX_LIMIT);
}

/** Row id of a personal item id (`p_<n>`); broadcasts and anything else give null. */
function personalId(id: string): number | null {
  const match = /^p_(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

export const inboxRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    const raw = c.req.query("cursor");
    let cursor: Cursor | null = null;
    if (raw) {
      cursor = decodeCursor(raw, CursorSchema);
      if (!cursor) return jsonError(400, "invalid_cursor", "cursor is not valid");
    }
    const user = c.get("user");
    return c.json(
      await listInbox(c.env.INBOX_DB, {
        userId: user.id,
        userCreatedAt: user.createdAt.getTime(),
        marketingOptIn: user.marketingOptIn === true,
        cursor,
        limit: parseLimit(c.req.query("limit")),
        now: Date.now(),
        ttlDays: Number(c.env.INBOX_TTL_DAYS),
      }),
    );
  })
  .get("/unread-count", async (c) => {
    const user = c.get("user");
    const count = await unreadCount(c.env.INBOX_DB, {
      userId: user.id,
      userCreatedAt: user.createdAt.getTime(),
      marketingOptIn: user.marketingOptIn === true,
      now: Date.now(),
      ttlDays: Number(c.env.INBOX_TTL_DAYS),
    });
    return c.json({ count });
  })
  .post("/read", async (c) => {
    const body = await parseBody(c, ReadSchema);
    if (body instanceof Response) return body;
    const ids = body.ids.map(personalId).filter((id) => id !== null);
    await markRead(c.env.INBOX_DB, c.get("user").id, ids, Date.now());
    return c.body(null, 204);
  })
  .post("/read-all", async (c) => {
    await markAllRead(c.env.INBOX_DB, c.get("user").id, Date.now());
    return c.body(null, 204);
  })
  .delete("/:id", async (c) => {
    const id = personalId(c.req.param("id"));
    if (id === null || !(await deleteItem(c.env.INBOX_DB, c.get("user").id, id))) {
      return jsonError(404, "not_found", "No such inbox item");
    }
    return c.body(null, 204);
  });
