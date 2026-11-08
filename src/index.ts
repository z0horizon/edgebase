import { app } from "./app";
import { runCleanup } from "./jobs/cleanup";
import { enqueueDuePushes } from "./jobs/scheduled";
import { handlePushBatch } from "./push/consumer";
import type { PushQueueMessage } from "./push/types";

export default {
  fetch: app.fetch,
  queue: (batch, env) => handlePushBatch(batch as MessageBatch<PushQueueMessage>, env),
  async scheduled(controller, env, ctx) {
    // Must match the crons in wrangler.jsonc.
    if (controller.cron === "* * * * *") ctx.waitUntil(enqueueDuePushes(env, Date.now()));
    if (controller.cron === "17 3 * * *") ctx.waitUntil(runCleanup(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
