import * as v from "valibot";

export const PlatformSchema = v.picklist(["web", "ios", "android"]);
export type Platform = v.InferOutput<typeof PlatformSchema>;

export const CategorySchema = v.picklist(["transactional", "marketing"]);
export type Category = v.InferOutput<typeof CategorySchema>;

const MAX_DATA_BYTES = 1024;

const TextEntries = {
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  body: v.pipe(v.string(), v.maxLength(500)),
};

// BCP 47, e.g. "vi" or "en-US".
export const LocaleSchema = v.pipe(v.string(), v.regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,3}$/));

/** Text per locale; a user gets their locale, else its language, else the default title and body. */
const TranslationsSchema = v.pipe(
  v.record(LocaleSchema, v.object(TextEntries)),
  v.check((t) => Object.keys(t).length <= 50, "at most 50 translations"),
);
export type Translations = v.InferOutput<typeof TranslationsSchema>;

const PayloadEntries = {
  ...TextEntries,
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

const PushPayloadSchema = v.object(PayloadEntries);
export type PushPayload = v.InferOutput<typeof PushPayloadSchema>;

// FCM's own topic name rule.
export const TopicSchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9\-_.~%]{1,900}$/));

const PushTargetSchema = v.union([
  v.object({
    userIds: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1), v.maxLength(500)),
  }),
  v.object({ topic: TopicSchema }),
]);

/** A push to dispatch now, with any template already applied; scheduled pushes are stored in this shape. */
export const PushDispatchSchema = v.object({
  ...PayloadEntries,
  translations: v.optional(TranslationsSchema),
  to: PushTargetSchema,
  inbox: v.optional(v.boolean()),
});
export type PushDispatch = v.InferOutput<typeof PushDispatchSchema>;

export const TemplateNameSchema = v.pipe(v.string(), v.regex(/^[a-z0-9_.-]{1,64}$/));

/** A stored template: the content of a push without its target. */
export const TemplateSchema = v.object({
  ...TextEntries,
  data: PayloadEntries.data,
  category: v.optional(CategorySchema),
  translations: v.optional(TranslationsSchema),
});
export type Template = v.InferOutput<typeof TemplateSchema>;

/**
 * The POST /v1/push body. Content fields may come from `template` and hold `{{name}}`
 * placeholders filled from `vars`; the result is checked against PushDispatchSchema.
 */
export const PushRequestSchema = v.object({
  to: PushTargetSchema,
  inbox: v.optional(v.boolean()),
  sendAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  template: v.optional(TemplateNameSchema),
  vars: v.optional(
    v.pipe(
      v.record(v.pipe(v.string(), v.regex(/^[\w.-]{1,64}$/)), v.pipe(v.string(), v.maxLength(500))),
      v.check((vars) => Object.keys(vars).length <= 50, "at most 50 vars"),
    ),
  ),
  title: v.optional(v.string()),
  body: v.optional(v.string()),
  data: v.optional(v.record(v.string(), v.string())),
  category: v.optional(CategorySchema),
  translations: v.optional(v.record(v.string(), v.object({ title: v.string(), body: v.string() }))),
});
export type PushRequest = v.InferOutput<typeof PushRequestSchema>;

/** A device token together with the user it belonged to when the push was addressed. */
export type PushTarget = { token: string; userId: string };

export type PushQueueMessage =
  | { kind: "users"; userIds: string[]; payload: PushPayload; attempt: number }
  | { kind: "tokens"; targets: PushTarget[]; payload: PushPayload; attempt: number }
  | { kind: "topic"; topic: string; payload: PushPayload; attempt: number };
