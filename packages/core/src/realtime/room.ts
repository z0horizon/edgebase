import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import { jsonError } from "../http";
import { roomPolicy } from "./config";
import { type RealtimeEvent, RealtimeEventSchema, ROOM_NAME } from "./events";
import {
  accept,
  answerClose,
  CLOSE,
  checkSessions,
  closeOldest,
  closeQuietly,
  infoOf,
  isOpen,
  PING_TIMEOUT_MS,
  type SocketInfo,
  sendQuietly,
  spend,
  sweep,
  upgradeInfo,
} from "./sockets";

export { ROOM_NAME };
/** Sockets one room holds; joining past it answers `409 room_full`. */
export const MAX_ROOM_SOCKETS = 1000;
/** A user's sockets in one room; a newer one closes the oldest. */
export const MAX_SOCKETS_PER_USER_IN_ROOM = 5;
/** Largest message a client may send, before parsing. */
export const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;
/** Messages a socket may send in a burst; one more every MESSAGE_REFILL_MS (2 a second). */
export const MESSAGE_BURST = 10;
export const MESSAGE_REFILL_MS = 500;
/** How long a room trusts its members' sessions before checking them in D1 again. */
export const ROOM_SESSION_CHECK_MS = 60_000;
/**
 * Messages waiting for their turn in one room; past it members get `busy`. Each holds up to
 * MAX_CLIENT_MESSAGE_BYTES, so this bounds the queue's memory (a few MB) when `onMessage` is slow.
 */
export const MAX_ROOM_QUEUE = 200;
/** Event types only EdgeBase sends; a member's message with one of them is refused. */
export const RESERVED_TYPES: ReadonlySet<string> = new Set(["error", "presence", "inbox"]);

/** The room of a socket; its message budget is SocketInfo's (see `spend`). */
type RoomSocket = SocketInfo & { room: string };

const userTag = (userId: string) => `u:${userId}`;

/** What a client gets back when its message is not relayed. */
const errorEvent = (code: string, message: string) =>
  JSON.stringify({ type: "error", data: { code, message } });

const presenceEvent = (data: { members: string[] } | { joined: string } | { left: string }) =>
  JSON.stringify({ type: "presence", data });

/**
 * One room (`GET /v1/realtime/rooms/:room`): every member's socket, and the relay of what they
 * send. Members are checked by the app's `canJoin` when they join, and their sessions are
 * checked again in D1 at most once a minute while the room is active. Messages are handled one
 * at a time, so members see them in the order the room received them.
 */
export class RealtimeRoom extends DurableObject<Env> {
  /** In memory only: after hibernation the first message checks sessions again. */
  private sessionsCheckedAt = 0;
  /** The message being handled; the next one waits for it. */
  private turn: Promise<unknown> = Promise.resolve();
  /** Messages and server events waiting for (or holding) the turn. */
  private queued = 0;
  /** Users announced as present; rebuilt from the open sockets whenever the room wakes. */
  private present: Set<string>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.present = new Set(this.members());
  }

  override async fetch(request: Request): Promise<Response> {
    const info = upgradeInfo(request) as (SocketInfo & { room?: string }) | null;
    if (!info?.room) return new Response(null, { status: 400 });
    const tag = userTag(info.userId);
    // Dead sockets go first: they hold no place, and their users must not show as present.
    const open = sweep(this.ctx, this.ctx.getWebSockets(), info.connectedAt, (id) =>
      this.announceLeft(id),
    );
    const mine = open.filter((ws) => infoOf(ws)?.userId === info.userId);
    // A user's own replaced socket frees a place, so only joins that add one can find it full.
    if (mine.length < MAX_SOCKETS_PER_USER_IN_ROOM && open.length >= MAX_ROOM_SOCKETS) {
      return jsonError(409, "room_full", "This room is full");
    }
    closeOldest(mine, MAX_SOCKETS_PER_USER_IN_ROOM);
    const socket: RoomSocket = { ...info, room: info.room };
    const { response, server } = accept(this.ctx, socket, [tag]);
    const isNew = !this.present.has(info.userId);
    this.present.add(info.userId);
    if (roomPolicy()?.presence) {
      // Members that go silent leave no close behind; an alarm sweeps them while anyone is here.
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(info.connectedAt + PING_TIMEOUT_MS);
      }
      sendQuietly(server, presenceEvent({ members: [...this.present] }));
      // Others hear of a user once, when their first socket joins.
      if (isNew) {
        const joined = presenceEvent({ joined: info.userId });
        for (const ws of this.ctx.getWebSockets()) {
          if (ws !== server && isOpen(ws) && infoOf(ws)?.userId !== info.userId) {
            sendQuietly(ws, joined);
          }
        }
      }
    }
    return response;
  }

  /**
   * Sends `message` (a serialized event from the server) to every member, in turn with members'
   * messages so all see one order; returns how many got it.
   */
  async send(message: string, now: number): Promise<number> {
    return this.inTurn(async () => {
      await this.checkSessions(now);
      let sent = 0;
      for (const ws of this.ctx.getWebSockets()) if (this.deliver(ws, message, now)) sent++;
      return sent;
    });
  }

  /** Sweeps members that went silent, and comes back while presence is on and anyone is here. */
  override async alarm(): Promise<void> {
    const open = sweep(this.ctx, this.ctx.getWebSockets(), Date.now(), (id) =>
      this.announceLeft(id),
    );
    if (open.length > 0 && roomPolicy()?.presence) {
      await this.ctx.storage.setAlarm(Date.now() + PING_TIMEOUT_MS);
    }
  }

  /** Closes a user's sockets here, for a member the app removed; they should not rejoin on their own. */
  remove(userId: string): void {
    for (const ws of this.ctx.getWebSockets(userTag(userId))) {
      closeQuietly(ws, CLOSE.REMOVED, "removed from the room");
    }
    this.announceLeft(userId);
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const info = infoOf<RoomSocket>(ws);
    if (!info || typeof raw !== "string") {
      this.close(ws, CLOSE.PROTOCOL, "send JSON text");
      return;
    }
    const now = Date.now();
    // The budget is spent on arrival, before waiting for the turn, so a flood is limited at once.
    if (!spend(ws, info, now, MESSAGE_BURST, MESSAGE_REFILL_MS)) {
      sendQuietly(ws, errorEvent("rate_limited", "Too many messages, slow down"));
      return;
    }
    // Every member may be under their own limit while a slow onMessage lets the queue grow.
    if (this.queued >= MAX_ROOM_QUEUE) {
      sendQuietly(ws, errorEvent("busy", "The room is busy, try again"));
      return;
    }
    await this.inTurn(() => this.handle(ws, info, raw, now));
  }

  /** Runs `work` after everything queued before it; one at a time keeps a single order. */
  private async inTurn<T>(work: () => Promise<T>): Promise<T> {
    this.queued++;
    const run = this.turn.then(work);
    this.turn = run.catch(() => {});
    try {
      return await run;
    } finally {
      this.queued--;
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    answerClose(ws, code, reason);
    const userId = infoOf(ws)?.userId;
    if (userId) this.announceLeft(userId);
  }

  override webSocketError(ws: WebSocket): void {
    const userId = infoOf(ws)?.userId;
    if (userId) this.announceLeft(userId);
  }

  private async handle(ws: WebSocket, info: RoomSocket, raw: string, now: number): Promise<void> {
    if (sweep(this.ctx, [ws], now, (id) => this.announceLeft(id)).length === 0) return;
    if (new TextEncoder().encode(raw).length > MAX_CLIENT_MESSAGE_BYTES) {
      sendQuietly(
        ws,
        errorEvent("too_large", `Messages are at most ${MAX_CLIENT_MESSAGE_BYTES} bytes`),
      );
      return;
    }
    let event: RealtimeEvent;
    try {
      const parsed = v.safeParse(RealtimeEventSchema, JSON.parse(raw));
      if (!parsed.success || RESERVED_TYPES.has(parsed.output.type)) throw new Error("invalid");
      event = parsed.output;
    } catch {
      sendQuietly(ws, errorEvent("invalid_message", "Send { type, data? } as JSON"));
      return;
    }

    try {
      await this.checkSessions(now);
    } catch (error) {
      console.error({ event: "room_session_check_failed", error: String(error) });
      sendQuietly(ws, errorEvent("unavailable", "Try again"));
      return;
    }
    if (!isOpen(ws)) return; // the check signed this sender out

    const onMessage = roomPolicy()?.onMessage;
    if (onMessage) {
      try {
        const result = await onMessage(
          this.env,
          { userId: info.userId, room: info.room },
          event,
          now,
        );
        if (result === null) return;
        if (result !== undefined) event = result;
      } catch (error) {
        console.error({ event: "room_message_hook_failed", room: info.room, error: String(error) });
        sendQuietly(ws, errorEvent("rejected", "The message was not sent"));
        return;
      }
    }

    const message = JSON.stringify({ ...event, from: info.userId });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) this.deliver(other, message, now);
    }
  }

  /** The users with an open socket here, each once. */
  private members(): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const id = isOpen(ws) ? infoOf(ws)?.userId : undefined;
      if (id) ids.add(id);
    }
    return [...ids];
  }

  /** Tells the others a user left, once their last socket here is gone (with presence on). */
  private announceLeft(userId: string): void {
    if (!this.present.has(userId) || this.ctx.getWebSockets(userTag(userId)).some(isOpen)) return;
    this.present.delete(userId);
    if (!roomPolicy()?.presence) return;
    const left = presenceEvent({ left: userId });
    for (const ws of this.ctx.getWebSockets()) if (isOpen(ws)) sendQuietly(ws, left);
  }

  /** Closes a socket the room ends itself, and tells the others when its user is gone. */
  private close(ws: WebSocket, code: number, reason: string): void {
    closeQuietly(ws, code, reason);
    const userId = infoOf(ws)?.userId;
    if (userId) this.announceLeft(userId);
  }

  private deliver(ws: WebSocket, message: string, now: number): boolean {
    const [open] = sweep(this.ctx, [ws], now, (id) => this.announceLeft(id));
    return open !== undefined && sendQuietly(open, message);
  }

  /** Closes members whose session is gone, at most once per ROOM_SESSION_CHECK_MS; throws if D1 fails. */
  private async checkSessions(now: number): Promise<void> {
    if (now - this.sessionsCheckedAt < ROOM_SESSION_CHECK_MS) return;
    const sockets = this.ctx.getWebSockets().filter(isOpen);
    const ids = new Set<string>();
    for (const ws of sockets) {
      const id = infoOf(ws)?.sessionId;
      if (id) ids.add(id);
    }
    const live = await checkSessions(this.env, "room", [...ids], now);
    this.sessionsCheckedAt = now;
    for (const ws of sockets) {
      const id = infoOf(ws)?.sessionId;
      if (!id || !live.has(id)) this.close(ws, CLOSE.SIGNED_OUT, "signed out");
    }
  }
}
