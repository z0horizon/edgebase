import { PLACEHOLDER } from "@edgebase/core/limits";

export const SEND_RECIPIENTS_KEY = "edgebase:send-recipients";

export function viewKeyFromHash<K extends string>(
  hash: string,
  views: Record<K, unknown>,
  fallback: K,
): K {
  const name = hash.startsWith("#") ? hash.slice(1) : hash;
  return Object.hasOwn(views, name) ? (name as K) : fallback;
}

// Preview only: the server fills placeholders for real and refuses missing ones.
export const fillPreview = (text: string, vars: Record<string, string>) =>
  text.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(vars, name) ? (vars[name] ?? match) : match,
  );

export function clearSessionDrafts(storage: Pick<Storage, "removeItem">) {
  storage.removeItem(SEND_RECIPIENTS_KEY);
}
