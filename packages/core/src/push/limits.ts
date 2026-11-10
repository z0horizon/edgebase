// Plain constants with no imports, shared with the admin page so each limit lives in one place.

/** Most users one push may target; a topic reaches more. */
export const MAX_RECIPIENTS = 500;
export const TITLE_MAX = 120;
export const BODY_MAX = 500;
/** A template name, unanchored as HTML `pattern` takes it; `-` is escaped for its `v` flag. */
export const TEMPLATE_NAME_PATTERN = "[a-z0-9_.\\-]{1,64}";
/** Pushes `GET /v1/push` lists, newest first. */
export const STATS_LISTED = 50;
/** Days a push's stats and opens are kept. */
export const STATS_KEPT_DAYS = 90;
/** A `{{name}}` placeholder in a template's text. */
export const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;
