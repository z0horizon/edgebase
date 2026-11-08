import * as v from "valibot";

export const PlatformSchema = v.picklist(["web", "ios", "android"]);
export type Platform = v.InferOutput<typeof PlatformSchema>;
