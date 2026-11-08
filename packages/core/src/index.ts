import { app } from "./app";
import { runCleanup } from "./jobs/cleanup";
import { enqueueDuePushes } from "./jobs/scheduled";
import { handlePushBatch } from "./push/consumer";
import type { PushQueueMessage } from "./push/types";

export { type AppEnv, app } from "./app";
export type { SessionUser } from "./auth/auth";
export { requireApiKey, requireAuthConfig, requireUser } from "./auth/middleware";
export { jsonError, parseBody } from "./http";

/** The Worker's handlers; routes added to `app` before the first request are served too. */
export const worker = {
  fetch: app.fetch,
  queue: (batch, env) => handlePushBatch(batch as MessageBatch<PushQueueMessage>, env),
  async scheduled(controller, env, ctx) {
    // Must match the crons in the app's wrangler.jsonc.
    if (controller.cron === "* * * * *") ctx.waitUntil(enqueueDuePushes(env, Date.now()));
    if (controller.cron === "17 * * * *") ctx.waitUntil(runCleanup(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
