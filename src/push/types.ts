import * as v from "valibot";

export const PlatformSchema = v.picklist(["web", "ios", "android"]);
export type Platform = v.InferOutput<typeof PlatformSchema>;

export const CategorySchema = v.picklist(["transactional", "marketing"]);
export type Category = v.InferOutput<typeof CategorySchema>;

export type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, string>;
  category: Category;
};
