import * as v from "valibot";
import { MAX_RECIPIENTS } from "../push/limits";

/** Largest `data` of an event, serialized; a socket message should stay small. */
export const MAX_EVENT_DATA_BYTES = 8 * 1024;

/** A room name: lowercase, so `chat:42` and `Chat:42` are never two rooms. */
export const ROOM_NAME = /^[a-z0-9][a-z0-9_.:-]{0,127}$/;
export const RoomNameSchema = v.pipe(v.string(), v.regex(ROOM_NAME));

/** `type` names what happened (`inbox` and `error` are EdgeBase's); `data` is any JSON the app chooses. */
export const RealtimeEventSchema = v.object({
  type: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_.:-]{0,63}$/)),
  data: v.optional(
    v.pipe(
      v.unknown(),
      v.check(
        (data) => new TextEncoder().encode(JSON.stringify(data)).length <= MAX_EVENT_DATA_BYTES,
        `data must be at most ${MAX_EVENT_DATA_BYTES} bytes of JSON`,
      ),
    ),
  ),
});
export type RealtimeEvent = v.InferOutput<typeof RealtimeEventSchema>;

// Strict, so a key the HTTP route does not offer (`marketingOnly`) is refused, not dropped.
export const RealtimeTargetSchema = v.union([
  v.strictObject({
    userIds: v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1))),
      v.minLength(1),
      v.maxLength(MAX_RECIPIENTS),
    ),
  }),
  v.strictObject({ everyone: v.literal(true) }),
  v.strictObject({ room: RoomNameSchema }),
]);
/**
 * Who gets an event: some users' personal sockets, everyone's (`marketingOnly` keeps it to
 * users who opted in), or the members of a room.
 */
export type RealtimeTarget =
  | { userIds: string[] }
  | { everyone: true; marketingOnly?: boolean }
  | { room: string };
