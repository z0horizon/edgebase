import { createMessageBatch, evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { handlePushBatch } from "../src/push/consumer";
import type { PushQueueMessage } from "../src/push/types";
import { CallSlots } from "../src/realtime/api";
import { authCookies } from "../src/realtime/caller";
import { configureRooms, type RoomPolicy } from "../src/realtime/config";
import {
  HUB_MESSAGE_BURST,
  HUB_SESSION_CHECK_MS,
  MAX_SOCKETS_PER_USER,
  REALTIME_SHARDS,
  shardOf,
} from "../src/realtime/hub";
import {
  disconnectUser,
  hubOf,
  INBOX_EVENT,
  MAX_EVENT_DATA_BYTES,
  publish,
  removeFromRoom,
  roomOf,
} from "../src/realtime/publish";
import {
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_ROOM_QUEUE,
  MAX_ROOM_SOCKETS,
  MAX_SOCKETS_PER_USER_IN_ROOM,
  MESSAGE_BURST,
} from "../src/realtime/room";
import {
  CLOSE,
  MAX_SOCKET_AGE_MS,
  MAX_SOCKETS_PER_OBJECT,
  PING_TIMEOUT_MS,
  SOCKET_INFO_HEADER,
  type SocketInfo,
} from "../src/realtime/sockets";
import { authed, call, freshIp, json, PASSWORD, seedUser, signUpVerified } from "./helpers";

const NOW = Date.now();
const DAY = 86_400_000;
const INBOX = JSON.stringify(INBOX_EVENT);
const API_KEY = { "x-api-key": "test-push-key" };

let sessions = 0;
/** A user with a live session row, as a signed-in socket has. */
async function seedSession(expiresAt = NOW + 30 * DAY) {
  const userId = await seedUser(Date.UTC(2026, 10, 1), "-rt");
  const sessionId = `rt-session-${++sessions}`;
  const iso = new Date(NOW).toISOString();
  await env.DB.prepare(
    "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(sessionId, new Date(expiresAt).toISOString(), `${sessionId}-token`, iso, iso, userId)
    .run();
  return { userId, sessionId };
}

type Watched = {
  messages: string[];
  closed: { code: number; reason: string } | null;
  next: () => Promise<void>;
};

/** Accepts a client socket and records what it receives. */
function watch(ws: WebSocket): Watched {
  let wake: (() => void) | null = null;
  const seen: Watched = {
    messages: [],
    closed: null,
    next: () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
  };
  ws.addEventListener("message", (e) => {
    seen.messages.push(String(e.data));
    wake?.();
  });
  ws.addEventListener("close", (e) => {
    seen.closed = { code: e.code, reason: e.reason };
    wake?.();
  });
  ws.accept();
  return seen;
}

/** Lets in-flight socket events arrive, so a socket that should get none is checked fairly. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** A socket opened on the user's hub directly, as the Worker's route would. */
async function connect(s: { userId: string; sessionId: string }, info: Partial<SocketInfo> = {}) {
  const full: SocketInfo = {
    ...s,
    sessionExpiresAt: NOW + 30 * DAY,
    marketingOptIn: false,
    connectedAt: NOW,
    ...info,
  };
  const res = await hubOf(env, s.userId).fetch("https://realtime.internal/connect", {
    headers: { upgrade: "websocket", [SOCKET_INFO_HEADER]: JSON.stringify(full) },
  });
  expect(res.status).toBe(101);
  if (!res.webSocket) throw new Error("no socket");
  return Object.assign(watch(res.webSocket), { ws: res.webSocket });
}

describe("GET /v1/realtime", () => {
  it("answers 426 without a WebSocket upgrade", async () => {
    const { token } = await signUpVerified("rt-426@example.com");
    const res = await call("/v1/realtime", authed(token));
    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({ error: { code: "upgrade_required" } });
  });

  it("answers 401 without a session", async () => {
    const res = await call("/v1/realtime", { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(401);
  });

  it("opens a socket for a bearer token, answers ping and delivers events", async () => {
    const { userId, token } = await signUpVerified("rt-open@example.com");
    const res = await call("/v1/realtime", authed(token, { headers: { upgrade: "websocket" } }));
    expect(res.status).toBe(101);
    if (!res.webSocket) throw new Error("no socket");
    const ws = watch(res.webSocket);

    let got = ws.next();
    res.webSocket.send("ping");
    await got;
    expect(ws.messages).toEqual(["pong"]);

    got = ws.next();
    const event = { type: "order.shipped", data: { orderId: "o1" } };
    expect(await publish(env, { userIds: [userId] }, event, Date.now())).toBe(1);
    await got;
    expect(ws.messages).toEqual(["pong", JSON.stringify(event)]);
    res.webSocket.close(1000, "done");
  });

  it("refuses a cookie session from an untrusted origin", async () => {
    const email = "rt-cookie@example.com";
    const { userId } = await signUpVerified(email);
    const signIn = await call(
      "/api/auth/sign-in/email",
      json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } }),
    );
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toContain("session_token");
    const open = (origin: string) =>
      call("/v1/realtime", { headers: { upgrade: "websocket", cookie, origin } });

    const evil = await open("https://evil.test");
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ error: { code: "forbidden_origin" } });

    const ok = await open("https://web.test");
    expect(ok.status).toBe(101);
    ok.webSocket?.accept();
    ok.webSocket?.close(1000, "done");
    await disconnectUser(env, userId);
  });
});

describe("POST /v1/realtime/publish", () => {
  const post = (body: unknown, headers: Record<string, string> = API_KEY) =>
    call("/v1/realtime/publish", json(body, { headers }));

  it("needs the API key", async () => {
    const res = await post({ to: { everyone: true }, type: "x" }, {});
    expect(res.status).toBe(401);
  });

  it("answers 503 while PUSH_API_KEY is unset, even without FCM", async () => {
    const res = await call(
      "/v1/realtime/publish",
      json({ to: { everyone: true }, type: "x" }, { headers: API_KEY }),
      { ...env, PUSH_API_KEY: "" },
    );
    expect(res.status).toBe(503);
  });

  it("validates the target, the type and the size of data", async () => {
    for (const body of [
      { to: { userIds: [] }, type: "x" },
      { to: { everyone: false }, type: "x" },
      { to: { everyone: true }, type: "Bad Type" },
      { to: { everyone: true }, type: "x", data: "a".repeat(MAX_EVENT_DATA_BYTES) },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "invalid_body" } });
    }
  });

  it("sends an event to the named users and counts the sockets", async () => {
    const [a, b] = [await seedSession(), await seedSession()];
    const [wa, wb] = [await connect(a), await connect(b)];
    const got = wa.next();
    const res = await post({ to: { userIds: [a.userId] }, type: "chat.message", data: { n: 1 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sockets: 1 });
    await got;
    await settle();
    expect(wa.messages).toEqual([JSON.stringify({ type: "chat.message", data: { n: 1 } })]);
    expect(wb.messages).toEqual([]);
  });
});

describe("realtime hub", () => {
  it("spreads users over every shard", () => {
    const shards = new Set(Array.from({ length: 2000 }, (_, i) => shardOf(`user-${i}`)));
    expect(shards.size).toBe(REALTIME_SHARDS);
  });

  it("sends to everyone, marketing-only to opted-in users", async () => {
    const [opted, plain] = [await seedSession(), await seedSession()];
    const wo = await connect(opted, { marketingOptIn: true });
    const wp = await connect(plain);

    await publish(env, { everyone: true, marketingOnly: true }, INBOX_EVENT, NOW);
    await settle();
    expect(wo.messages).toEqual([INBOX]);
    expect(wp.messages).toEqual([]);

    await publish(env, { everyone: true }, INBOX_EVENT, NOW);
    await settle();
    expect(wo.messages).toEqual([INBOX, INBOX]);
    expect(wp.messages).toEqual([INBOX]);
  });

  it("closes a socket whose session was revoked instead of sending to it", async () => {
    const s = await seedSession();
    const w = await connect(s);
    await env.DB.prepare("DELETE FROM session WHERE id = ?").bind(s.sessionId).run();
    expect(await publish(env, { userIds: [s.userId] }, { type: "secret", data: 1 }, NOW)).toBe(0);
    await settle();
    expect(w.messages).toEqual([]);
    expect(w.closed?.code).toBe(CLOSE.SIGNED_OUT);
  });

  it("closes a socket whose session expired or that is a day old", async () => {
    const [expired, old] = [await seedSession(NOW - 1), await seedSession()];
    const we = await connect(expired, { sessionExpiresAt: NOW });
    const wo = await connect(old, { connectedAt: NOW - MAX_SOCKET_AGE_MS - 1 });
    await publish(env, { userIds: [expired.userId, old.userId] }, INBOX_EVENT, NOW);
    await settle();
    for (const w of [we, wo]) {
      expect(w.messages).toEqual([]);
      expect(w.closed?.code).toBe(CLOSE.RECONNECT);
    }
  });

  it("closes a socket that stopped pinging, and keeps one that pings", async () => {
    const [silent, pinging] = [await seedSession(), await seedSession()];
    const at = NOW - PING_TIMEOUT_MS - 1000;
    const ws = await connect(silent, { connectedAt: at });
    const wp = await connect(pinging, { connectedAt: at });
    const pong = wp.next();
    wp.ws.send("ping");
    await pong;
    await publish(env, { userIds: [silent.userId, pinging.userId] }, INBOX_EVENT, Date.now());
    await settle();
    expect(ws.closed?.code).toBe(CLOSE.RECONNECT);
    expect(wp.messages).toEqual(["pong", INBOX]);
  });

  it("keeps a user's newest sockets and closes the oldest past the cap", async () => {
    const s = await seedSession();
    const sockets = [];
    for (let i = 0; i <= MAX_SOCKETS_PER_USER; i++) {
      sockets.push(await connect(s, { connectedAt: NOW + i }));
    }
    await settle();
    expect(sockets[0]?.closed?.code).toBe(CLOSE.REPLACED);
    expect(sockets.slice(1).every((w) => w.closed === null)).toBe(true);
    await disconnectUser(env, s.userId);
  });

  it("answers a message that is not a request with an error, and closes on binary", async () => {
    const w = await connect(await seedSession());
    const got = w.next();
    w.ws.send("hello");
    await got;
    expect(JSON.parse(w.messages[0] ?? "{}")).toMatchObject({
      type: "error",
      data: { code: "invalid_message" },
    });
    const closed = w.next();
    w.ws.send(new Uint8Array([1]));
    await closed;
    expect(w.closed?.code).toBe(CLOSE.PROTOCOL);
  });

  it("closes every socket of a deleted user", async () => {
    const s = await seedSession();
    const [w1, w2] = [await connect(s), await connect(s)];
    await disconnectUser(env, s.userId);
    await settle();
    expect(w1.closed?.code).toBe(CLOSE.SIGNED_OUT);
    expect(w2.closed?.code).toBe(CLOSE.SIGNED_OUT);
  });

  // About 40 s: opens 32,000 sockets. Runs with SLOW_TESTS=1.
  it.runIf(env.SLOW_TESTS === "1")(
    "answers 503 realtime_full once a hub holds MAX_SOCKETS_PER_OBJECT sockets",
    {
      timeout: 120_000,
    },
    async () => {
      // Ids that all land on one hub, one socket each.
      const shard = shardOf("cap-probe");
      const ids: string[] = [];
      for (let i = 0; ids.length <= MAX_SOCKETS_PER_OBJECT; i++) {
        if (shardOf(`cap-${i}`) === shard) ids.push(`cap-${i}`);
      }
      const open = (userId: string) =>
        hubOf(env, userId).fetch("https://realtime.internal/connect", {
          headers: {
            upgrade: "websocket",
            [SOCKET_INFO_HEADER]: JSON.stringify({
              userId,
              sessionId: "cap",
              sessionExpiresAt: NOW + DAY,
              marketingOptIn: false,
              connectedAt: NOW,
            } satisfies SocketInfo),
          },
        });
      const sockets: WebSocket[] = [];
      for (let i = 0; i < MAX_SOCKETS_PER_OBJECT; i += 500) {
        const batch = await Promise.all(
          ids.slice(i, Math.min(i + 500, MAX_SOCKETS_PER_OBJECT)).map(open),
        );
        for (const res of batch) {
          expect(res.status).toBe(101);
          res.webSocket?.accept();
          if (res.webSocket) sockets.push(res.webSocket);
        }
      }
      const over = await open(ids[MAX_SOCKETS_PER_OBJECT] as string);
      expect(over.status).toBe(503);
      expect(await over.json()).toMatchObject({ error: { code: "realtime_full" } });
      for (const ws of sockets) ws.close(1000, "done");
    },
  );

  it("refuses a request that is not an upgrade from the Worker", async () => {
    const res = await hubOf(env, "x").fetch("https://realtime.internal/connect");
    expect(res.status).toBe(400);
  });
});

describe("push consumer", () => {
  const payload = { title: "t", body: "b", category: "transactional" } as const;
  const run = (bodies: PushQueueMessage[]) =>
    handlePushBatch(
      createMessageBatch<PushQueueMessage>(
        "edgebase-push",
        bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
      ),
      env,
    );

  it("sends the inbox event for first deliveries that stored inbox items only", async () => {
    const [inbox, plain, retry] = [await seedSession(), await seedSession(), await seedSession()];
    const [wi, wp, wr] = [await connect(inbox), await connect(plain), await connect(retry)];
    const got = wi.next();
    await run([
      { kind: "users", userIds: [inbox.userId], payload, attempt: 0, inbox: true },
      { kind: "users", userIds: [plain.userId], payload, attempt: 0 },
      { kind: "users", userIds: [retry.userId], payload, attempt: 1, inbox: true },
    ]);
    await got;
    await settle();
    expect(wi.messages).toEqual([INBOX]);
    expect(wp.messages).toEqual([]);
    expect(wr.messages).toEqual([]);
  });
});

describe("rooms", () => {
  let rooms = 0;
  const roomName = () => `chat:${++rooms}`;
  afterEach(() => configureRooms(null));

  /** Rooms where anyone may join `chat:*`, and `onMessage` drops "spam" and tags "shout". */
  const policy: RoomPolicy = {
    canJoin: (_env, _user, room) => room.startsWith("chat:"),
    onMessage: (_env, from, event) => {
      const text = (event.data as { text?: string } | undefined)?.text;
      if (text === "spam") return null;
      if (text === "shout") return { type: event.type, data: { text: "SHOUT", by: from.userId } };
      if (text === "boom") throw new Error("hook failed");
      return undefined;
    },
  };

  /** A member socket opened on the room directly, as the Worker's route would. */
  async function join(room: string, s: { userId: string; sessionId: string }, connectedAt = NOW) {
    const info = {
      ...s,
      sessionExpiresAt: NOW + 30 * DAY,
      marketingOptIn: false,
      connectedAt,
      room,
    };
    const res = await roomOf(env, room).fetch("https://realtime.internal/connect", {
      headers: { upgrade: "websocket", [SOCKET_INFO_HEADER]: JSON.stringify(info) },
    });
    expect(res.status).toBe(101);
    if (!res.webSocket) throw new Error("no socket");
    return Object.assign(watch(res.webSocket), { ws: res.webSocket, ...s });
  }
  const say = (type: string, data: unknown) => JSON.stringify({ type, data });

  it("are off until the app configures them", async () => {
    const { token } = await signUpVerified("rt-room-off@example.com");
    const res = await call(
      "/v1/realtime/rooms/chat:1",
      authed(token, { headers: { upgrade: "websocket" } }),
    );
    expect(res.status).toBe(404);
  });

  it("check the name, the upgrade and canJoin before opening", async () => {
    configureRooms(policy);
    const { token } = await signUpVerified("rt-room-join@example.com");
    const open = (room: string, upgrade = true) =>
      call(
        `/v1/realtime/rooms/${room}`,
        authed(token, { headers: upgrade ? { upgrade: "websocket" } : {} }),
      );
    expect((await open("Bad Name")).status).toBe(400);
    expect((await open("chat:x", false)).status).toBe(426);
    const denied = await open("vip:1");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "forbidden" } });
    const ok = await open(roomName());
    expect(ok.status).toBe(101);
    ok.webSocket?.accept();
    ok.webSocket?.close(1000, "done");
  });

  it("relay a member's message to the others with its sender, not back to it", async () => {
    configureRooms(policy);
    const room = roomName();
    const [a, b] = [await join(room, await seedSession()), await join(room, await seedSession())];
    const got = b.next();
    a.ws.send(say("chat.message", { text: "hi" }));
    await got;
    await settle();
    expect(b.messages).toEqual([
      JSON.stringify({ type: "chat.message", data: { text: "hi" }, from: a.userId }),
    ]);
    expect(a.messages).toEqual([]);
  });

  it("let onMessage drop or rewrite a message, and tell the sender when it fails", async () => {
    configureRooms(policy);
    const room = roomName();
    const [a, b] = [await join(room, await seedSession()), await join(room, await seedSession())];
    a.ws.send(say("chat.message", { text: "spam" }));
    const got = b.next();
    a.ws.send(say("chat.message", { text: "shout" }));
    await got;
    const failed = a.next();
    a.ws.send(say("chat.message", { text: "boom" }));
    await failed;
    await settle();
    expect(b.messages).toEqual([
      JSON.stringify({
        type: "chat.message",
        data: { text: "SHOUT", by: a.userId },
        from: a.userId,
      }),
    ]);
    expect(JSON.parse(a.messages[0] ?? "{}")).toMatchObject({
      type: "error",
      data: { code: "rejected" },
    });
  });

  it("answer invalid, oversized and too many messages with an error event", async () => {
    configureRooms(policy);
    const room = roomName();
    const a = await join(room, await seedSession());
    const codes = async (raw: string) => {
      const got = a.next();
      a.ws.send(raw);
      await got;
      return (JSON.parse(a.messages.at(-1) ?? "{}") as { data: { code: string } }).data.code;
    };
    expect(await codes("not json")).toBe("invalid_message");
    expect(await codes(say("Bad Type", 1))).toBe("invalid_message");
    expect(await codes(say("x", "a".repeat(MAX_CLIENT_MESSAGE_BYTES)))).toBe("too_large");
    // Three messages of the burst are spent; the rest go through, then the limit answers.
    for (let i = 3; i < MESSAGE_BURST; i++) a.ws.send(say("x", i));
    expect(await codes(say("x", "over"))).toBe("rate_limited");
  });

  it("close a member that sends binary", async () => {
    configureRooms(policy);
    const a = await join(roomName(), await seedSession());
    const got = a.next();
    a.ws.send(new Uint8Array([1, 2]));
    await got;
    expect(a.closed?.code).toBe(CLOSE.PROTOCOL);
  });

  it("close members whose session was revoked and relay nothing to them", async () => {
    configureRooms(policy);
    const room = roomName();
    const [a, b] = [await join(room, await seedSession()), await join(room, await seedSession())];
    await env.DB.prepare("DELETE FROM session WHERE id = ?").bind(b.sessionId).run();
    a.ws.send(say("chat.message", { text: "secret" }));
    await settle();
    expect(b.messages).toEqual([]);
    expect(b.closed?.code).toBe(CLOSE.SIGNED_OUT);
  });

  it("take events from the server, over publish and the HTTP route", async () => {
    configureRooms(policy);
    const room = roomName();
    const [a, b] = [await join(room, await seedSession()), await join(room, await seedSession())];
    const event = { type: "room.closed" };
    expect(await publish(env, { room }, event, NOW)).toBe(2);
    const res = await call(
      "/v1/realtime/publish",
      json({ to: { room }, ...event }, { headers: API_KEY }),
    );
    expect(await res.json()).toEqual({ sockets: 2 });
    await settle();
    for (const w of [a, b])
      expect(w.messages).toEqual([JSON.stringify(event), JSON.stringify(event)]);
    await expect(publish(env, { room: "Bad Name" }, event, NOW)).rejects.toThrow();
  });

  it("keep a user's newest sockets in a room and close a removed member", async () => {
    configureRooms(policy);
    const room = roomName();
    const s = await seedSession();
    const sockets = [];
    for (let i = 0; i <= MAX_SOCKETS_PER_USER_IN_ROOM; i++)
      sockets.push(await join(room, s, NOW + i));
    await settle();
    expect(sockets[0]?.closed?.code).toBe(CLOSE.REPLACED);
    await removeFromRoom(env, room, s.userId);
    await settle();
    expect(sockets.slice(1).every((w) => w.closed?.code === CLOSE.REMOVED)).toBe(true);
  });

  it("refuse a member's message with a type only EdgeBase sends", async () => {
    configureRooms(policy);
    const a = await join(roomName(), await seedSession());
    for (const type of ["presence", "error", "inbox"]) {
      const got = a.next();
      a.ws.send(say(type, {}));
      await got;
      expect(JSON.parse(a.messages.at(-1) ?? "{}")).toMatchObject({
        type: "error",
        data: { code: "invalid_message" },
      });
    }
  });

  it("relay in the order received, even when onMessage is slow for one", async () => {
    configureRooms({
      canJoin: () => true,
      onMessage: async (_env, _from, event) => {
        if ((event.data as { text?: string }).text === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return undefined;
      },
    });
    const room = roomName();
    const [a, b] = [await join(room, await seedSession()), await join(room, await seedSession())];
    a.ws.send(say("m", { text: "slow" }));
    a.ws.send(say("m", { text: "fast" }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(b.messages.map((m) => (JSON.parse(m) as { data: { text: string } }).data.text)).toEqual([
      "slow",
      "fast",
    ]);
  });

  it("tell members who is there, who joins and who leaves, when presence is on", async () => {
    configureRooms({ ...policy, presence: true });
    const room = roomName();
    const [sa, sb] = [await seedSession(), await seedSession()];
    const a = await join(room, sa);
    await settle();
    expect(a.messages.map((m) => JSON.parse(m))).toEqual([
      { type: "presence", data: { members: [sa.userId] } },
    ]);
    const b = await join(room, sb);
    const b2 = await join(room, sb, NOW + 1); // a second tab: no second "joined"
    await settle();
    expect(JSON.parse(b.messages[0] ?? "{}").data.members.sort()).toEqual(
      [sa.userId, sb.userId].sort(),
    );
    expect(a.messages.slice(1).map((m) => JSON.parse(m))).toEqual([
      { type: "presence", data: { joined: sb.userId } },
    ]);
    b.ws.close(1000, "tab closed");
    await settle();
    expect(a.messages).toHaveLength(2); // b2 is still there
    b2.ws.close(1000, "last tab closed");
    await settle();
    expect(a.messages.slice(2).map((m) => JSON.parse(m))).toEqual([
      { type: "presence", data: { left: sb.userId } },
    ]);
    await removeFromRoom(env, room, sa.userId);
  });

  it("send no presence when it is off", async () => {
    configureRooms(policy);
    const room = roomName();
    const a = await join(room, await seedSession());
    await join(room, await seedSession());
    await settle();
    expect(a.messages).toEqual([]);
  });

  it("answer 409 room_full past the room's sockets, except for a user's own replacement", async () => {
    configureRooms(policy);
    const room = roomName();
    const first = await seedSession();
    const mine = [];
    for (let i = 0; i < MAX_SOCKETS_PER_USER_IN_ROOM; i++)
      mine.push(await join(room, first, NOW + i));
    await Promise.all(
      Array.from({ length: MAX_ROOM_SOCKETS - MAX_SOCKETS_PER_USER_IN_ROOM }, (_, i) =>
        join(room, { userId: `full-${rooms}-${i}`, sessionId: first.sessionId }),
      ),
    );
    const s = await seedSession();
    const res = await roomOf(env, room).fetch("https://realtime.internal/connect", {
      headers: {
        upgrade: "websocket",
        [SOCKET_INFO_HEADER]: JSON.stringify({
          ...s,
          sessionExpiresAt: NOW + DAY,
          marketingOptIn: false,
          connectedAt: NOW,
          room,
        }),
      },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "room_full" } });
    // A user at their own cap replaces their oldest socket, so the room does not grow.
    const again = await join(room, first, NOW + 100);
    await settle();
    expect(again.closed).toBeNull();
    expect(mine[0]?.closed?.code).toBe(CLOSE.REPLACED);
  });
});

describe("API calls over the personal socket", () => {
  /** A signed-in user's socket opened through the route, so calls act as that client. */
  async function signedIn(email: string) {
    const { userId, token } = await signUpVerified(email);
    const res = await call("/v1/realtime", authed(token, { headers: { upgrade: "websocket" } }));
    if (!res.webSocket) throw new Error(`no socket: ${res.status}`);
    const w = watch(res.webSocket);
    const request = async (data: Record<string, unknown>) => {
      const got = w.next();
      res.webSocket?.send(JSON.stringify({ type: "request", data }));
      await got;
      return JSON.parse(w.messages.at(-1) ?? "{}") as {
        type: string;
        data: { id?: string; status?: number; body?: unknown; code?: string };
      };
    };
    return { userId, token, w, ws: res.webSocket, request };
  }

  it("runs a call as the socket's user and answers with its id, status and body", async () => {
    const s = await signedIn("rt-api-me@example.com");
    const me = await s.request({ id: "1", method: "GET", path: "/v1/me" });
    expect(me).toMatchObject({ type: "response", data: { id: "1", status: 200 } });
    expect((me.data.body as { id: string }).id).toBe(s.userId);

    const read = await s.request({ id: "2", method: "POST", path: "/v1/inbox/read-all" });
    expect(read.data).toEqual({ id: "2", status: 204, body: null });

    const bad = await s.request({
      id: "3",
      method: "POST",
      path: "/v1/inbox/read",
      body: { ids: "x" },
    });
    expect(bad.data).toMatchObject({
      id: "3",
      status: 400,
      body: { error: { code: "invalid_body" } },
    });
  });

  it("refuses paths outside /v1, batch and realtime", async () => {
    const s = await signedIn("rt-api-paths@example.com");
    for (const path of [
      "/api/auth/get-session",
      "/v1/batch",
      "/v1/realtime/publish",
      "https://evil.test/v1/me",
    ]) {
      const answer = await s.request({ id: path, method: "GET", path });
      expect(answer).toEqual({
        type: "error",
        data: { code: "invalid_request", message: expect.any(String), id: path },
      });
    }
  });

  it("answers a revoked session's call with 401 and closes the socket", async () => {
    const s = await signedIn("rt-api-revoked@example.com");
    await env.DB.prepare("DELETE FROM session WHERE userId = ?").bind(s.userId).run();
    const answer = await s.request({ id: "1", method: "GET", path: "/v1/me" });
    expect(answer.data.status).toBe(401);
    await settle();
    expect(s.w.closed?.code).toBe(CLOSE.SIGNED_OUT);
  });

  it("does not run calls on a socket opened without the route", async () => {
    const w = await connect(await seedSession());
    const got = w.next();
    w.ws.send(
      JSON.stringify({ type: "request", data: { id: "1", method: "GET", path: "/v1/me" } }),
    );
    await got;
    expect(JSON.parse(w.messages[0] ?? "{}")).toMatchObject({
      data: { code: "invalid_request", id: "1" },
    });
  });

  it("keeps the socket open on a 401 that is not about its session", async () => {
    const s = await signedIn("rt-api-401@example.com");
    const answer = await s.request({
      id: "x",
      method: "POST",
      path: "/v1/auth/app-exchange",
      body: { token: "not-a-token", verifier: "v".repeat(43) },
    });
    expect(answer.data.status).toBe(401);
    await settle();
    expect(s.w.closed).toBeNull();
    const me = await s.request({ id: "y", method: "GET", path: "/v1/me" });
    expect(me.data.status).toBe(200);
  });

  it("answers each of a burst of calls once, with a response or busy", async () => {
    const s = await signedIn("rt-api-busy@example.com");
    const before = s.w.messages.length;
    for (let i = 0; i < HUB_MESSAGE_BURST; i++) {
      s.ws?.send(
        JSON.stringify({ type: "request", data: { id: `b${i}`, method: "GET", path: "/v1/me" } }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const answers = s.w.messages
      .slice(before)
      .map((m) => JSON.parse(m) as { type: string; data: { id?: string; code?: string } });
    expect(answers.map((a) => a.data.id).sort()).toEqual(
      Array.from({ length: HUB_MESSAGE_BURST }, (_, i) => `b${i}`).sort(),
    );
    expect(answers.every((a) => a.type === "response" || a.data.code === "busy")).toBe(true);
  });

  it("gives a socket at most its slots, and the hub at most its total", () => {
    const slots = new CallSlots<object>(2, 3);
    const [a, b] = [{}, {}];
    expect([slots.take(a), slots.take(a), slots.take(a)]).toEqual([true, true, false]);
    expect([slots.take(b), slots.take(b)]).toEqual([true, false]); // the hub is full at 3
    slots.give(a);
    expect(slots.take(b)).toBe(true);
    expect(slots.take(a)).toBe(false);
  });

  it("limits how many messages a socket may send", async () => {
    const w = await connect(await seedSession());
    for (let i = 0; i <= HUB_MESSAGE_BURST; i++) w.ws.send("not json");
    await settle();
    const codes = w.messages.map((m) => (JSON.parse(m) as { data: { code: string } }).data.code);
    expect(codes.slice(0, HUB_MESSAGE_BURST).every((c) => c === "invalid_message")).toBe(true);
    expect(codes.at(-1)).toBe("rate_limited");
  });

  it("counts any message, not only ping, as a sign of life", async () => {
    const s = await seedSession();
    // About to go silent: one second left before the ping timeout.
    const w = await connect(s, { connectedAt: Date.now() - PING_TIMEOUT_MS + 1000 });
    const got = w.next();
    w.ws.send("hello");
    await got;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await publish(env, { userIds: [s.userId] }, INBOX_EVENT, Date.now());
    await settle();
    expect(w.closed).toBeNull();
    expect(w.messages.at(-1)).toBe(INBOX);
  });

  it("refuses an upgrade whose headers cannot fit the socket", async () => {
    const { token } = await signUpVerified("rt-api-431@example.com");
    const res = await call(
      "/v1/realtime",
      authed(token, { headers: { upgrade: "websocket", "user-agent": "x".repeat(13 * 1024) } }),
    );
    expect(res.status).toBe(431);
    expect(await res.json()).toMatchObject({ error: { code: "headers_too_large" } });
  });

  it("keeps only Better Auth's cookies for calls", () => {
    expect(
      authCookies("theme=dark; better-auth.session_token=a.b; __Secure-better-auth.x=1; ga=2"),
    ).toBe("better-auth.session_token=a.b; __Secure-better-auth.x=1");
    expect(authCookies("theme=dark")).toBeUndefined();
    expect(authCookies(undefined)).toBeUndefined();
  });
});

describe("rooms: dead sockets and load", () => {
  let n = 0;
  const roomName = () => `load:${++n}`;
  afterEach(() => configureRooms(null));
  async function join(
    room: string,
    s: { userId: string; sessionId: string },
    connectedAt = Date.now(),
  ) {
    const res = await roomOf(env, room).fetch("https://realtime.internal/connect", {
      headers: {
        upgrade: "websocket",
        [SOCKET_INFO_HEADER]: JSON.stringify({
          ...s,
          sessionExpiresAt: Date.now() + 30 * DAY,
          marketingOptIn: false,
          connectedAt,
          room,
        }),
      },
    });
    if (!res.webSocket) throw new Error(`no socket: ${res.status}`);
    return Object.assign(watch(res.webSocket), { ws: res.webSocket, ...s });
  }
  const presence = (w: Watched) =>
    w.messages
      .map((m) => JSON.parse(m) as { type: string; data: Record<string, unknown> })
      .filter((m) => m.type === "presence");

  it("sweep a member that went silent when someone joins, and leave it out of members", async () => {
    configureRooms({ canJoin: () => true, presence: true });
    const room = roomName();
    const ghost = await join(room, await seedSession(), Date.now() - PING_TIMEOUT_MS - 1000);
    const b = await join(room, await seedSession());
    await settle();
    expect(ghost.closed?.code).toBe(CLOSE.RECONNECT);
    expect(presence(b)[0]?.data).toEqual({ members: [b.userId] });
  });

  it("sweep silent members on the presence alarm and announce them left", async () => {
    configureRooms({ canJoin: () => true, presence: true });
    const room = roomName();
    const b = await join(room, await seedSession());
    const ghost = await join(room, await seedSession(), Date.now() - PING_TIMEOUT_MS - 1000);
    await settle();
    expect(await runDurableObjectAlarm(roomOf(env, room))).toBe(true);
    await settle();
    expect(ghost.closed?.code).toBe(CLOSE.RECONNECT);
    expect(presence(b).at(-1)?.data).toEqual({ left: ghost.userId });
  });

  it("answer busy once the room's queue is full, and keep server events in turn", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    configureRooms({
      canJoin: () => true,
      onMessage: async (_env, _from, event) => {
        if ((event.data as { block?: boolean } | undefined)?.block) await blocked;
        return null;
      },
    });
    const room = roomName();
    const senders = [];
    for (let i = 0; i <= MAX_ROOM_QUEUE / MESSAGE_BURST; i++)
      senders.push(await join(room, await seedSession()));
    const first = senders[0];
    if (!first) throw new Error("no sender");
    first.ws.send(JSON.stringify({ type: "m", data: { block: true } }));
    await settle();
    let published = false;
    const event = publish(env, { room }, { type: "server.note" }, Date.now()).then((count) => {
      published = true;
      return count;
    });
    for (const w of senders)
      for (let i = 0; i < MESSAGE_BURST; i++) w.ws.send(JSON.stringify({ type: "m", data: i }));
    await settle();
    const busy = senders.flatMap((w) => w.messages).filter((m) => m.includes('"busy"'));
    expect(busy.length).toBeGreaterThan(0);
    expect(published).toBe(false); // waiting behind the blocked message
    release();
    expect(await event).toBe(senders.length);
    expect(published).toBe(true);
  });
});

describe("realtime: caching, network and hibernation", () => {
  it("trusts a live session for HUB_SESSION_CHECK_MS, then checks it again", async () => {
    const s = await seedSession();
    const w = await connect(s);
    const t0 = Date.now();
    expect(await publish(env, { userIds: [s.userId] }, INBOX_EVENT, t0)).toBe(1);
    await env.DB.prepare("DELETE FROM session WHERE id = ?").bind(s.sessionId).run();
    // Still within the window: the hub does not read D1 again.
    expect(await publish(env, { userIds: [s.userId] }, INBOX_EVENT, t0 + 1000)).toBe(1);
    expect(
      await publish(env, { userIds: [s.userId] }, INBOX_EVENT, t0 + HUB_SESSION_CHECK_MS),
    ).toBe(0);
    await settle();
    expect(w.closed?.code).toBe(CLOSE.SIGNED_OUT);
  });

  it("gives calls over the socket the network of the upgrade", async () => {
    const { userId, token } = await signUpVerified("rt-api-cf@example.com");
    const res = await call("/v1/realtime", {
      ...authed(token, { headers: { upgrade: "websocket" } }),
      cf: { country: "VN", asn: 7552 },
    });
    if (!res.webSocket) throw new Error("no socket");
    const w = watch(res.webSocket);
    const got = w.next();
    res.webSocket.send(
      JSON.stringify({ type: "request", data: { id: "1", method: "GET", path: "/v1/me" } }),
    );
    await got;
    await new Promise((resolve) => setTimeout(resolve, 200)); // session activity runs after the answer
    const row = await env.DB.prepare("SELECT country, asn FROM session WHERE userId = ?")
      .bind(userId)
      .first<{ country: string | null; asn: number | null }>();
    expect(row).toEqual({ country: "VN", asn: 7552 });
  });

  it("keeps a hub's sockets, their sessions and their callers across hibernation", async () => {
    const { userId, token } = await signUpVerified("rt-hibernate@example.com");
    const res = await call("/v1/realtime", authed(token, { headers: { upgrade: "websocket" } }));
    if (!res.webSocket) throw new Error("no socket");
    const w = watch(res.webSocket);
    await evictDurableObject(hubOf(env, userId));
    let got = w.next();
    expect(await publish(env, { userIds: [userId] }, INBOX_EVENT, Date.now())).toBe(1);
    await got;
    got = w.next();
    res.webSocket.send(
      JSON.stringify({ type: "request", data: { id: "1", method: "GET", path: "/v1/me" } }),
    );
    await got;
    expect(JSON.parse(w.messages.at(-1) ?? "{}")).toMatchObject({
      type: "response",
      data: { id: "1", status: 200 },
    });
    expect(w.closed).toBeNull();
  });

  it("keeps a room's members, budgets and presence across hibernation", async () => {
    configureRooms({ canJoin: () => true, presence: true });
    try {
      const room = "hibernate:1";
      const join = async (s: { userId: string; sessionId: string }) => {
        const r = await roomOf(env, room).fetch("https://realtime.internal/connect", {
          headers: {
            upgrade: "websocket",
            [SOCKET_INFO_HEADER]: JSON.stringify({
              ...s,
              sessionExpiresAt: Date.now() + 30 * DAY,
              marketingOptIn: false,
              connectedAt: Date.now(),
              room,
            }),
          },
        });
        if (!r.webSocket) throw new Error("no socket");
        return Object.assign(watch(r.webSocket), { ws: r.webSocket, ...s });
      };
      const [sa, sb, sc] = [await seedSession(), await seedSession(), await seedSession()];
      const a = await join(sa);
      const b = await join(sb);
      // a spends its whole burst before the room sleeps.
      for (let i = 0; i < MESSAGE_BURST; i++) a.ws.send(JSON.stringify({ type: "m", data: i }));
      await settle();
      await evictDurableObject(roomOf(env, room));
      // After waking: the budget is still spent, relays still reach b, and presence knows both.
      const limited = a.next();
      a.ws.send(JSON.stringify({ type: "m", data: "over" }));
      await limited;
      expect(JSON.parse(a.messages.at(-1) ?? "{}")).toMatchObject({
        data: { code: "rate_limited" },
      });
      const c = await join(sc);
      await settle();
      const members = (JSON.parse(c.messages[0] ?? "{}") as { data: { members: string[] } }).data
        .members;
      expect(members.sort()).toEqual([sa.userId, sb.userId, sc.userId].sort());
      expect(b.messages.filter((m) => m.includes('"from"'))).toHaveLength(MESSAGE_BURST);
    } finally {
      configureRooms(null);
    }
  });
});
