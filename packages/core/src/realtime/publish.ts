import { type RealtimeEvent, type RealtimeTarget, ROOM_NAME } from "./events";
import { REALTIME_SHARDS, shardOf } from "./shards";

export {
  MAX_EVENT_DATA_BYTES,
  type RealtimeEvent,
  RealtimeEventSchema,
  type RealtimeTarget,
  RealtimeTargetSchema,
} from "./events";

const hubAt = (env: Env, shard: number) => env.REALTIME.getByName(`hub-${shard}`);

/** The hub that holds a user's sockets. */
export const hubOf = (env: Env, userId: string) => hubAt(env, shardOf(userId));

/** The Durable Object of a room. */
export const roomOf = (env: Env, room: string) => env.ROOMS.getByName(room);

/**
 * Sends an event to the open personal sockets of some users or of everyone, or to a room's
 * members, and returns how many sockets got it: one Durable Object call per hub involved (at
 * most REALTIME_SHARDS), or one for a room.
 * Users with no open socket miss it, so an event must be something a client can also learn by
 * reading the API when it reconnects. Throws if a hub cannot be reached.
 */
export async function publish(
  env: Env,
  to: RealtimeTarget,
  event: RealtimeEvent,
  now: number,
): Promise<number> {
  const message = JSON.stringify(event);
  if ("room" in to) {
    if (!ROOM_NAME.test(to.room)) throw new Error(`not a room name: ${to.room}`);
    return roomOf(env, to.room).send(message, now);
  }
  if ("everyone" in to) {
    const counts = await Promise.all(
      Array.from({ length: REALTIME_SHARDS }, (_, shard) =>
        hubAt(env, shard).sendAll(message, to.marketingOnly === true, now),
      ),
    );
    return counts.reduce((a, b) => a + b, 0);
  }
  const byShard = new Map<number, string[]>();
  for (const id of to.userIds) {
    const shard = shardOf(id);
    const ids = byShard.get(shard);
    if (ids) ids.push(id);
    else byShard.set(shard, [id]);
  }
  const counts = await Promise.all(
    [...byShard].map(([shard, ids]) => hubAt(env, shard).send(ids, message, now)),
  );
  return counts.reduce((a, b) => a + b, 0);
}

/**
 * `publish` for side effects of a write that already happened (the inbox): a client reads the
 * data again when it reconnects, so a failure is logged and never fails the caller.
 */
export async function publishBestEffort(
  env: Env,
  to: RealtimeTarget,
  event: RealtimeEvent,
  now: number,
): Promise<void> {
  if ("userIds" in to && to.userIds.length === 0) return;
  try {
    await publish(env, to, event, now);
  } catch (error) {
    console.error({ event: "realtime_publish_failed", type: event.type, error: String(error) });
  }
}

/** EdgeBase's own event: the inbox gained an item; read it with GET /v1/inbox or POST /v1/sync. */
export const INBOX_EVENT = { type: "inbox" } as const satisfies RealtimeEvent;

/**
 * Closes a user's sockets in a room, for a member the app removed (close code 4005). Remove them
 * from whatever `canJoin` reads first, so they cannot join again.
 */
export async function removeFromRoom(env: Env, room: string, userId: string): Promise<void> {
  await roomOf(env, room).remove(userId);
}

/** Closes a user's open sockets, for a deleted account. */
export async function disconnectUser(env: Env, userId: string): Promise<void> {
  try {
    await hubOf(env, userId).disconnect(userId);
  } catch (error) {
    console.error({ event: "realtime_disconnect_failed", error: String(error) });
  }
}
