import { SESSION_LIVE } from "../auth/queries";
import { metered, sampled } from "../db/metrics";
/** What the Worker hands a hub or room with the upgrade; they are reachable only through the Worker. */
export type SocketInfo = {
  userId: string;
  sessionId: string;
  sessionExpiresAt: number;
  marketingOptIn: boolean;
  connectedAt: number;
  /** When the client last sent anything but an auto-answered ping (set by `spend`). */
  lastSeenAt?: number;
  /** The socket's message budget (see `spend`). */
  tokens?: number;
  refilledAt?: number;
};
export const SOCKET_INFO_HEADER = "x-edgebase-socket";

/** A socket older than this is closed with RECONNECT, so it signs in again. */
export const MAX_SOCKET_AGE_MS = 86_400_000;
/**
 * A socket that has not pinged for this long is taken for dead (a phone that lost its network
 * often leaves no close behind) and closed with RECONNECT. Clients ping every 30–60 s.
 */
export const PING_TIMEOUT_MS = 180_000;
/** Hibernatable sockets one Durable Object may hold (Cloudflare's cap is 32,768). */
export const MAX_SOCKETS_PER_OBJECT = 32_000;
/** Session ids per D1 lookup; one JSON parameter each, well under D1's statement size. */
const SESSIONS_PER_QUERY = 500;

/** Close codes a client sees. */
export const CLOSE = {
  /** The session is near its end or the socket is a day old: connect again (a new session check). */
  RECONNECT: 4001,
  /** A newer socket of the same user took this one's place: do not reconnect on your own. */
  REPLACED: 4002,
  /** The session was signed out or revoked, or the account deleted: sign in again first. */
  SIGNED_OUT: 4003,
  /** The client sent something it may not send on this socket. */
  PROTOCOL: 4004,
  /** The app removed the user from the room: do not rejoin on your own. */
  REMOVED: 4005,
} as const;

export function infoOf<T extends SocketInfo = SocketInfo>(ws: WebSocket): T | null {
  return ws.deserializeAttachment() as T | null;
}

/**
 * A socket whose session ran out, that is a day old, or that has been silent (no ping, no
 * message) for PING_TIMEOUT_MS; the caller closes it with RECONNECT. The runtime records each
 * auto-answered ping without waking the object; `spend` records every other message.
 */
export function isStale(
  ctx: DurableObjectState,
  ws: WebSocket,
  info: SocketInfo,
  now: number,
): boolean {
  const lastSeen = Math.max(
    ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0,
    info.lastSeenAt ?? 0,
    info.connectedAt,
  );
  return (
    info.sessionExpiresAt <= now ||
    now - info.connectedAt > MAX_SOCKET_AGE_MS ||
    now - lastSeen > PING_TIMEOUT_MS
  );
}

/**
 * Takes one message from a socket's budget (`burst` at once, one more every `refillMs`), and
 * records the message for liveness. Runs before any await, so concurrent messages cannot both
 * spend the same token. Returns false when the budget is empty.
 */
export function spend(
  ws: WebSocket,
  info: SocketInfo,
  now: number,
  burst: number,
  refillMs: number,
): boolean {
  const tokens = Math.min(
    burst,
    (info.tokens ?? burst) + (now - (info.refilledAt ?? info.connectedAt)) / refillMs,
  );
  const ok = tokens >= 1;
  ws.serializeAttachment({
    ...info,
    tokens: ok ? tokens - 1 : tokens,
    refilledAt: now,
    lastSeenAt: now,
  } satisfies SocketInfo);
  return ok;
}

export const isOpen = (ws: WebSocket) => ws.readyState === WebSocket.OPEN;

/**
 * Closes the stale ones among `sockets` with RECONNECT and returns the open rest; `onClosed`
 * hears each user id closed (rooms announce `left`).
 */
export function sweep(
  ctx: DurableObjectState,
  sockets: WebSocket[],
  now: number,
  onClosed?: (userId: string) => void,
): WebSocket[] {
  const open: WebSocket[] = [];
  for (const ws of sockets) {
    if (!isOpen(ws)) continue;
    const info = infoOf(ws);
    if (info && !isStale(ctx, ws, info, now)) {
      open.push(ws);
      continue;
    }
    closeQuietly(ws, CLOSE.RECONNECT, "reconnect");
    if (info && onClosed) onClosed(info.userId);
  }
  return open;
}

/** The ids among `ids` whose session still exists and has not expired. */
export async function liveSessions(
  db: D1Database,
  ids: string[],
  now: number,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const nowIso = new Date(now).toISOString();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += SESSIONS_PER_QUERY) {
    statements.push(
      db.prepare(SESSION_LIVE).bind(JSON.stringify(ids.slice(i, i + SESSIONS_PER_QUERY)), nowIso),
    );
  }
  const results = await db.batch<{ id: string }>(statements);
  return new Set(results.flatMap((r) => r.results.map((row) => row.id)));
}

/** liveSessions for a hub's or room's own check, measured like any invocation (via `via`). */
export const checkSessions = (env: Env, via: string, ids: string[], now: number) =>
  metered(env, sampled(), { via }, (e) => liveSessions(e.DB, ids, now));

/**
 * Closes the oldest of `sockets` so that `keep` of them remain, once a new one is added.
 * Returns nothing; closed sockets get REPLACED.
 */
export function closeOldest(sockets: WebSocket[], keep: number): void {
  const byAge = sockets
    .map((ws) => ({ ws, at: infoOf(ws)?.connectedAt ?? 0 }))
    .sort((a, b) => a.at - b.at);
  const excess = Math.max(0, byAge.length - (keep - 1));
  for (const { ws } of byAge.slice(0, excess)) {
    closeQuietly(ws, CLOSE.REPLACED, "replaced by a newer connection");
  }
}

export function closeQuietly(ws: WebSocket, code?: number, reason?: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

export function sendQuietly(ws: WebSocket, message: string): boolean {
  try {
    ws.send(message);
    return true;
  } catch {
    // Already closing; the client reconnects or is gone.
    return false;
  }
}

/** Completes a closing handshake the client started. */
export function answerClose(ws: WebSocket, code: number, reason: string): void {
  // Codes a peer cannot send back are answered without one.
  const sendable = code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code);
  if (sendable) closeQuietly(ws, code, reason);
  else closeQuietly(ws);
}

/** Accepts a hibernatable socket with its info: the 101 for the client end, and the server end. */
export function accept(
  ctx: DurableObjectState,
  info: SocketInfo,
  tags: string[],
): { response: Response; server: WebSocket } {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  ctx.acceptWebSocket(server, tags);
  server.serializeAttachment(info);
  return { response: new Response(null, { status: 101, webSocket: client }), server };
}

/** The SocketInfo of an upgrade from the Worker, or null for anything else. */
export function upgradeInfo(request: Request): SocketInfo | null {
  const raw = request.headers.get(SOCKET_INFO_HEADER);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || !raw) return null;
  return JSON.parse(raw) as SocketInfo;
}
