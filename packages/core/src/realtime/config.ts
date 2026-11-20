import type { SessionUser } from "../auth/auth";
import type { RealtimeEvent } from "./events";

/** What a room's `onMessage` hook may answer: an event to send instead, `null` to drop it, or nothing to send it as is. */
export type RoomMessageResult = RealtimeEvent | null | undefined;

/**
 * The app's rules for rooms. Without them rooms are off: joining answers `404`.
 * Set once at the top of `apps/server/src/index.ts`, so the Worker and its Durable Objects,
 * which run the same module, both see it.
 */
export type RoomPolicy = {
  /** Whether `user` may join `room`; asked on every join, in the Worker, before any socket opens. */
  canJoin(env: Env, user: SessionUser, room: string): boolean | Promise<boolean>;
  /**
   * Tells members who is in the room: on joining, `{ type: "presence", data: { members } }`,
   * then `{ joined }` and `{ left }` as users come and go. Off by default, since it shows every
   * member's user id to the others.
   */
  presence?: boolean;
  /**
   * Runs, in the room, on each message a member sends, before it goes to the others: store it,
   * check it, rewrite it or drop it. Without it every valid message is relayed as sent.
   */
  onMessage?(
    env: Env,
    from: { userId: string; room: string },
    event: RealtimeEvent,
    now: number,
  ): RoomMessageResult | Promise<RoomMessageResult>;
};

let policy: RoomPolicy | null = null;

/** Turns rooms on with the app's rules, or off with null. */
export function configureRooms(rules: RoomPolicy | null): void {
  policy = rules;
}

export const roomPolicy = (): RoomPolicy | null => policy;
