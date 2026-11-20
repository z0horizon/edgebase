import type { Context } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { isAllowedWebOrigin } from "../auth/middleware";
import { FORWARDED_HEADERS } from "../batch";
import { jsonError, parseBody } from "../http";
import { type ApiCaller, authCookies, MAX_CALLER_CHARS } from "./caller";
import { roomPolicy } from "./config";
import { RealtimeEventSchema, RealtimeTargetSchema, RoomNameSchema } from "./events";
import { hubOf, publish, roomOf } from "./publish";
import { SOCKET_INFO_HEADER, type SocketInfo } from "./sockets";

/** The checks every socket upgrade shares; a Response means refuse with it. */
function upgradeRefusal(c: Context<AppEnv>): Response | null {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return jsonError(426, "upgrade_required", "Connect with a WebSocket");
  }
  // Browsers send cookies with a WebSocket opened by any site, and the handshake is a GET that
  // requireUser lets through; only the Worker's own origin or a web TRUSTED_ORIGINS entry may use them.
  if (
    c.req.header("authorization") === undefined &&
    c.req.header("cookie") !== undefined &&
    !isAllowedWebOrigin(c.env, c.req.header("origin"))
  ) {
    return jsonError(403, "forbidden_origin", "Untrusted request origin");
  }
  return null;
}

function socketInfo(c: Context<AppEnv>): SocketInfo {
  const user = c.get("user");
  const session = c.get("session");
  return {
    userId: user.id,
    sessionId: session.id,
    sessionExpiresAt: new Date(session.expiresAt).getTime(),
    marketingOptIn: user.marketingOptIn === true,
    connectedAt: Date.now(),
  };
}

/** Hands the upgrade to a Durable Object and passes its answer on. */
async function connect(
  stub: { fetch(input: string, init: RequestInit): Promise<Response> },
  info: SocketInfo & { room?: string; api?: ApiCaller },
): Promise<Response> {
  const res = await stub.fetch("https://realtime.internal/connect", {
    headers: { upgrade: "websocket", [SOCKET_INFO_HEADER]: JSON.stringify(info) },
  });
  // A fresh Response, so middleware that adds headers (CORS) is not handed immutable ones.
  if (res.webSocket) {
    return new Response(null, { status: 101, webSocket: res.webSocket, headers: res.headers });
  }
  return new Response(res.body, res);
}

/**
 * `GET /v1/realtime`: upgrades to the caller's personal WebSocket, on which the server sends
 * events (`{ "type", "data"? }`): EdgeBase's `inbox`, and whatever the app publishes to the user,
 * so apps react then instead of polling. Use after requireUser.
 */
export async function realtime(c: Context<AppEnv>): Promise<Response> {
  const refused = upgradeRefusal(c);
  if (refused) return refused;
  // What API calls over the socket act as: the same headers and network /v1/batch forwards.
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    // Of cookies, only the session's: the rest is not needed and should not sit in the hub.
    const value = name === "cookie" ? authCookies(c.req.header(name)) : c.req.header(name);
    if (value !== undefined) headers[name] = value;
  }
  const api: ApiCaller = { headers, cf: c.req.raw.cf ?? null };
  if (JSON.stringify(api).length > MAX_CALLER_CHARS) {
    return jsonError(431, "headers_too_large", "Request headers are too large for a socket");
  }
  return connect(hubOf(c.env, c.get("user").id), { ...socketInfo(c), api });
}

/**
 * `GET /v1/realtime/rooms/:room`: joins a room the app's `canJoin` lets the caller into, on a
 * WebSocket of its own: members send events to each other, and the server publishes to all.
 * Without `configureRooms`, rooms are off and this answers 404. Use after requireUser.
 */
export async function joinRoom(c: Context<AppEnv>): Promise<Response> {
  const policy = roomPolicy();
  if (!policy) return jsonError(404, "not_found", "Route not found");
  const parsed = v.safeParse(RoomNameSchema, c.req.param("room") ?? "");
  const room = parsed.success ? parsed.output : "";
  if (!parsed.success) {
    return jsonError(400, "invalid_param", "room must match ^[a-z0-9][a-z0-9_.:-]{0,127}$");
  }
  const refused = upgradeRefusal(c);
  if (refused) return refused;
  if (!(await policy.canJoin(c.env, c.get("user"), room))) {
    return jsonError(403, "forbidden", "You cannot join this room");
  }
  return connect(roomOf(c.env, room), { ...socketInfo(c), room });
}

const PublishSchema = v.object({ to: RealtimeTargetSchema, ...RealtimeEventSchema.entries });

/**
 * `POST /v1/realtime/publish` (server key): sends an event to some users', everyone's or a
 * room's sockets, for servers that are not this Worker; code in the Worker calls `publish`.
 */
export async function publishRoute(c: Context<AppEnv>): Promise<Response> {
  const body = await parseBody(c, PublishSchema);
  if (body instanceof Response) return body;
  const { to, ...event } = body;
  return c.json({ sockets: await publish(c.env, to, event, Date.now()) });
}
