import * as v from "valibot";

export const PlatformSchema = v.picklist(["web", "ios", "android"]);
export type Platform = v.InferOutput<typeof PlatformSchema>;

export const CategorySchema = v.picklist(["transactional", "marketing"]);
export type Category = v.InferOutput<typeof CategorySchema>;

const MAX_DATA_BYTES = 1024;

const PayloadEntries = {
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  body: v.pipe(v.string(), v.maxLength(500)),
  data: v.optional(
    v.pipe(
      v.record(v.string(), v.string()),
      v.check(
        (d) => new TextEncoder().encode(JSON.stringify(d)).length <= MAX_DATA_BYTES,
        "data must be at most 1 KB as JSON",
      ),
    ),
  ),
  category: CategorySchema,
};

export const PushPayloadSchema = v.object(PayloadEntries);
export type PushPayload = v.InferOutput<typeof PushPayloadSchema>;

export const PushTargetSchema = v.union([
  v.object({
    userIds: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1), v.maxLength(500)),
  }),
  // FCM's own topic name rule.
  v.object({ topic: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9\-_.~%]{1,900}$/)) }),
]);

/** A push to dispatch now; scheduled pushes are stored in this shape. */
export const PushDispatchSchema = v.object({
  ...PayloadEntries,
  to: PushTargetSchema,
  inbox: v.optional(v.boolean()),
});
export type PushDispatch = v.InferOutput<typeof PushDispatchSchema>;

export const PushRequestSchema = v.object({
  ...PushDispatchSchema.entries,
  sendAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
});
export type PushRequest = v.InferOutput<typeof PushRequestSchema>;

export type PushQueueMessage =
  | { kind: "users"; userIds: string[]; payload: PushPayload; attempt: number }
  | { kind: "tokens"; tokens: string[]; payload: PushPayload; attempt: number }
  | { kind: "topic"; topic: string; payload: PushPayload; attempt: number };
