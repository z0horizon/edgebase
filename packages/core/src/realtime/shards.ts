/**
 * Personal sockets are spread over this many hubs by user id, so an event to any number of users
 * or to everyone is at most this many Durable Object calls, and each hub carries 1/16 of the API
 * calls sent over sockets. Changing it moves users to other hubs; their open sockets then miss
 * events until they reconnect (a deploy reconnects them anyway).
 */
export const REALTIME_SHARDS = 16;

/** FNV-1a: a stable, even spread of user ids over the hubs. */
export function shardOf(userId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % REALTIME_SHARDS;
}
