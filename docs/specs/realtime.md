# Realtime

Events over WebSockets (`packages/core/src/realtime/`), so apps react when something changes
instead of polling. Each user has a personal socket for server events (EdgeBase's `inbox`, the
app's own); rooms add sockets on which members also message each other.

## Entities

- **Socket**: one per open app (tab, device), from `GET /v1/realtime`. Its attachment holds the
  user id, session id and expiry, marketing opt-in and connect time. Nothing is stored in D1.
- **`RealtimeHub`** (`hub.ts`): the Durable Object holding the sockets of one of 16 shards,
  `hub-<n>` with `n = fnv1a(userId) % 16`. No storage.
- **`RealtimeRoom`** (`room.ts`): the Durable Object of one room, named by the room
  (`^[a-z0-9][a-z0-9_.:-]{0,127}$`). Holds its members' sockets; no storage.
- **`RoomPolicy`** (`config.ts`): the app's `canJoin(env, user, room)` and optional
  `onMessage(env, { userId, room }, event, now)`, set with `configureRooms`.
- **Event** (`events.ts`): `{ type, data? }`; `type` matches `^[a-z][a-z0-9_.:-]{0,63}$`, `data`
  is JSON of at most 8 KB. `inbox` and `error` are EdgeBase's.

## Rules

1. Opening needs a session (bearer or cookie) and `Upgrade: websocket` (`426` otherwise); a cookie
   session needs an origin from `BASE_URL` or web `TRUSTED_ORIGINS` (`403 forbidden_origin`).
2. A user keeps at most 10 sockets; a newer one closes the oldest with `4002`.
3. Clients send `ping`, auto-answered `pong` without waking the hub; binary closes the socket
   with `4004`, other text that is not a request answers `invalid_message` (rule 3b). A socket whose last `ping`, message or connect is over 3 minutes old is
   closed with `4001` when an event, a message or a new connection finds it (a lost network
   often leaves no close behind); closing sockets do not count toward any cap. A socket may send
   20 messages at once, then 4 a second (`rate_limited`).
   A hub holds at most 32,000 sockets (Cloudflare allows 32,768 per object); past it, connecting
   answers `503 realtime_full`. 16 hubs bound concurrent personal sockets to about 512k; raise
   `REALTIME_SHARDS` before that.
3b. A request `{ type: "request", data: { id, method, path, body?, idempotencyKey? } }` runs
   through `app.fetch` inside the hub, with the headers and `cf` the upgrade carried (those
   `POST /v1/batch` forwards: auth, cookie, origin, IP, user agent, language), and answers
   `{ type: "response", data: { id, status, body } }`. Only `/v1/` paths other than `/v1/batch`
   and `/v1/realtime*` (`invalid_request`); 10 running per socket (`busy`); 70 KB per message
   (`too_large`), 200 calls running per hub (`busy`). A `401` closes the socket (`4003`) only when
   its session is gone. Of cookies, only Better Auth's are kept; IP and `cf` are those of the
   upgrade. Upgrades whose forwarded headers exceed
   12 KB answer `431 headers_too_large`, since they must fit the socket's 16 KB attachment.
4. `publish(env, to, event, now)` (exported from `@edgebase/core`) and
   `POST /v1/realtime/publish` (server API key) send to `{ userIds }` (1–500 over HTTP),
   `{ everyone: true }` (one hub call per shard involved) or `{ room }` (one call), and return
   how many sockets got it.
5. Before sending, a hub closes sockets whose session expired or that are a day old (`4001`),
   then checks in D1, in one batch, the sessions it has not found live in the last 30 s
   (`HUB_SESSION_CHECK_MS`, in memory, so a hub that wakes checks again), and closes those whose
   session is gone (`4003`) without sending. If that check fails, nothing is sent (fail closed).
6. Events are not stored or retried; a client reads the API on every (re)connect.
7. Deleting an account closes its sockets with `4003`.
8. The `inbox` event follows inbox rule 10; marketing broadcasts reach only opted-in users'
   sockets (their opt-in as of connecting).

### Rooms

9. Without `configureRooms`, `GET /v1/realtime/rooms/:room` answers `404`. With it, the name is
   checked (`400`), then the upgrade and origin (rule 1), then `canJoin` (`403`), then the room's
   size: 1,000 sockets (`409 room_full`), 5 per user (a newer one closes the oldest, `4002`).
10. A member sends JSON text `{ type, data? }`. In order: binary closes the socket (`4004`); each
    socket has 10 messages, refilled at 2 a second (`rate_limited`, counted on arrival); then,
    one message at a time in arrival order: a stale socket closes (`4001`); over 16 KB is
    `too_large`; a bad shape or a reserved type (`error`, `presence`, `inbox`) is
    `invalid_message`; members' sessions are checked (below); `onMessage` may return `null`
    (dropped), an event (sent instead) or nothing (sent as is), and a throw answers `rejected`.
    Errors go to the sender as `{ type: "error", data: { code, message } }`. One message at a time
    means a slow `onMessage` slows the whole room (at 10 ms, about 100 messages a second); past
    200 waiting, senders get `busy`. Server events to the room take the same turn.
11. A relayed message goes to every other member as `{ type, data, from: <sender user id> }`;
    the sender does not get it back. Server events to a room have no `from`.
12. A room checks all its members' sessions in D1 at most once a minute, before relaying or
    sending; members whose session is gone are closed (`4003`) first. If the check fails, nothing
    is relayed and the sender gets `unavailable`. So a revoked session leaves a room within a
    minute of the room's next message.
13. `canJoin` is asked only on joining; `removeFromRoom(env, room, userId)` closes a member's
    sockets there (`4005`). Deleting an account closes its room sockets at the next session check.
14. Rooms store nothing: history, if the app wants it, is written by `onMessage` and read from
    the app's own routes on (re)join.
15. With `presence: true`, a joining socket gets `{ type: "presence", data: { members } }`, and
    the others get `{ joined }` when a user's first socket joins and `{ left }` when their last
    one closes, for any reason. Silent members are swept when someone joins and, with presence
    on, by an alarm every 3 minutes while the room has members. Off, nothing about members is sent.
