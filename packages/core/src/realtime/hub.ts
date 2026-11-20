import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import { jsonError } from "../http";
import {
  type ApiCaller,
  ApiRequestSchema,
  apiTarget,
  CallSlots,
  callApi,
  MAX_API_MESSAGE_CHARS,
} from "./api";
import {
  accept,
  answerClose,
  CLOSE,
  checkSessions,
  closeOldest,
  closeQuietly,
  infoOf,
  MAX_SOCKETS_PER_OBJECT,
  type SocketInfo,
  sendQuietly,
  spend,
  sweep,
  upgradeInfo,
} from "./sockets";

/** A personal socket: its info, and what calls over it act as. */
type HubSocket = SocketInfo & { api?: ApiCaller };

/** An answer to a socket, `error` with the call's id when there is one. */
const errorEvent = (code: string, message: string, id?: string) =>
  JSON.stringify({ type: "error", data: { code, message, ...(id !== undefined && { id }) } });

export { REALTIME_SHARDS, shardOf } from "./shards";

/**
 * How long a hub trusts a session it found live before checking it in D1 again: an app that
 * publishes often (typing, progress) would otherwise read every socket's session per event.
 */
export const HUB_SESSION_CHECK_MS = 30_000;
/** Sessions a hub remembers as checked; older entries are dropped past this many. */
const MAX_CHECKED_SESSIONS = 50_000;

/** Newer sockets of a user close the oldest past this many (tabs, devices). */
export const MAX_SOCKETS_PER_USER = 10;
/**
 * Messages a socket may send at once, one more every HUB_MESSAGE_REFILL_MS (4 a second): a hub
 * is one Durable Object for 1/16 of all users, so one client must not keep it busy.
 */
export const HUB_MESSAGE_BURST = 20;
export const HUB_MESSAGE_REFILL_MS = 250;

const userTag = (userId: string) => `u:${userId}`;

/**
 * Holds the personal realtime sockets (`GET /v1/realtime`) of the users of one shard. Sockets
 * are hibernatable: an idle hub sleeps and costs nothing, and "ping" is answered "pong" without
 * waking it. Clients may also call the API over the socket (`{ type: "request" }`), which runs the
 * call through the app itself as that client, saving a Worker request per call.
 *
 * Events can carry data, so before sending, a hub checks the sockets' sessions in D1, like every
 * signed-in request does: a session signed out, revoked or banned by any route gets no event and
 * its socket closes, without each of those routes having to know about sockets.
 */
export class RealtimeHub extends DurableObject<Env> {
  /** When each session was last found live; in memory, so a hub that wakes checks again. */
  private checkedAt = new Map<string, number>();
  /** Calls running; in memory, since a socket with calls running keeps the hub awake. */
  private slots = new CallSlots<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const info = upgradeInfo(request);
    if (!info) return new Response(null, { status: 400 });
    // Dead and closing sockets do not hold a place; sweeping reads every attachment, so only a
    // hub that looks full pays for it.
    const all = this.ctx.getWebSockets();
    if (
      all.length >= MAX_SOCKETS_PER_OBJECT &&
      sweep(this.ctx, all, info.connectedAt).length >= MAX_SOCKETS_PER_OBJECT
    ) {
      // Clients fall back to polling; raise REALTIME_SHARDS before hubs get this full.
      return jsonError(503, "realtime_full", "Realtime is at capacity, try again later");
    }
    const tag = userTag(info.userId);
    closeOldest(
      sweep(this.ctx, this.ctx.getWebSockets(tag), info.connectedAt),
      MAX_SOCKETS_PER_USER,
    );
    return accept(this.ctx, info, [tag]).response;
  }

  /** Sends `message` (a serialized event) to every socket of these users; returns how many got it. */
  async send(userIds: string[], message: string, now: number): Promise<number> {
    const sockets = [...new Set(userIds)].flatMap((id) => this.ctx.getWebSockets(userTag(id)));
    return this.deliver(sockets, message, now);
  }

  /** Sends `message` to every socket here, or with `marketingOnly` to opted-in users' only. */
  async sendAll(message: string, marketingOnly: boolean, now: number): Promise<number> {
    const sockets = this.ctx
      .getWebSockets()
      .filter((ws) => !marketingOnly || infoOf(ws)?.marketingOptIn === true);
    return this.deliver(sockets, message, now);
  }

  /** Closes every socket of a user, for a deleted account. */
  disconnect(userId: string): void {
    for (const ws of this.ctx.getWebSockets(userTag(userId))) {
      closeQuietly(ws, CLOSE.SIGNED_OUT, "account deleted");
    }
  }

  private async deliver(sockets: WebSocket[], message: string, now: number): Promise<number> {
    const current: { ws: WebSocket; sessionId: string }[] = [];
    for (const ws of sweep(this.ctx, sockets, now)) {
      const sessionId = infoOf(ws)?.sessionId;
      if (sessionId) current.push({ ws, sessionId });
    }
    if (current.length === 0) return 0;
    const due = [...new Set(current.map((s) => s.sessionId))].filter(
      (id) => now - (this.checkedAt.get(id) ?? Number.NEGATIVE_INFINITY) >= HUB_SESSION_CHECK_MS,
    );
    // Fails closed: when the check cannot run, nothing is sent (the caller logs the error).
    const live =
      due.length > 0 ? await checkSessions(this.env, "hub", due, now) : new Set<string>();
    const gone = new Set(due.filter((id) => !live.has(id)));
    this.remember(live, gone, now);
    let sent = 0;
    for (const { ws, sessionId } of current) {
      if (gone.has(sessionId)) closeQuietly(ws, CLOSE.SIGNED_OUT, "signed out");
      else if (sendQuietly(ws, message)) sent++;
    }
    return sent;
  }

  private remember(live: Set<string>, gone: Set<string>, now: number): void {
    for (const id of live) this.checkedAt.set(id, now);
    for (const id of gone) this.checkedAt.delete(id);
    if (this.checkedAt.size <= MAX_CHECKED_SESSIONS) return;
    for (const [id, at] of this.checkedAt) {
      if (now - at >= HUB_SESSION_CHECK_MS) this.checkedAt.delete(id);
    }
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const info = infoOf<HubSocket>(ws);
    if (!info || typeof raw !== "string") {
      closeQuietly(ws, CLOSE.PROTOCOL, "send JSON text");
      return;
    }
    const now = Date.now();
    if (sweep(this.ctx, [ws], now).length === 0) return;
    // Spent on arrival, before any await; bad messages spend too, so a flood is cut off at once.
    if (!spend(ws, info, now, HUB_MESSAGE_BURST, HUB_MESSAGE_REFILL_MS)) {
      sendQuietly(ws, errorEvent("rate_limited", "Too many messages, slow down"));
      return;
    }
    if (raw.length > MAX_API_MESSAGE_CHARS) {
      sendQuietly(ws, errorEvent("too_large", "A request is at most 64 KB of body"));
      return;
    }
    let call: v.InferOutput<typeof ApiRequestSchema>["data"];
    try {
      const parsed = v.safeParse(ApiRequestSchema, JSON.parse(raw));
      if (!parsed.success) throw new Error("invalid");
      call = parsed.output.data;
    } catch {
      sendQuietly(
        ws,
        errorEvent("invalid_message", 'Send { "type": "request", "data": { id, method, path } }'),
      );
      return;
    }
    const url = apiTarget(call.path, this.env.BASE_URL);
    if (!url || !info.api) {
      sendQuietly(
        ws,
        errorEvent(
          "invalid_request",
          "path must be a /v1/ route other than batch and realtime",
          call.id,
        ),
      );
      return;
    }
    if (!this.slots.take(ws)) {
      sendQuietly(ws, errorEvent("busy", "Wait for an answer before sending more", call.id));
      return;
    }
    try {
      const res = await callApi(this.env, (p) => this.ctx.waitUntil(p), info.api, url, call);
      sendQuietly(ws, JSON.stringify({ type: "response", data: { id: call.id, ...res } }));
      // A 401 can be a route's own (a wrong API key, a bad hand-off token); the socket closes
      // only when the session behind it is really gone.
      if (res.status === 401) {
        const live = await checkSessions(this.env, "hub", [info.sessionId], Date.now());
        if (!live.has(info.sessionId)) {
          this.checkedAt.delete(info.sessionId);
          closeQuietly(ws, CLOSE.SIGNED_OUT, "signed out");
        }
      }
    } catch (error) {
      console.error({ event: "realtime_call_failed", error: String(error) });
      sendQuietly(ws, errorEvent("internal", "Internal error", call.id));
    } finally {
      this.slots.give(ws);
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    answerClose(ws, code, reason);
  }
}
