import { app } from "./app";
import { metered, sampled } from "./db/metrics";
import { runCleanup } from "./jobs/cleanup";
import { CRONS } from "./jobs/crons";
import { enqueueDuePushes } from "./jobs/scheduled";
import { handlePushBatch } from "./push/consumer";
import type { PushQueueMessage } from "./push/types";

export { type AppEnv, app } from "./app";
export type { SessionUser } from "./auth/auth";
export {
  requireApiKey,
  requireAuthConfig,
  requireServerKey,
  requireUser,
  userRateLimit,
} from "./auth/middleware";
export { type DbName, registeredQueries, sql } from "./db/registry";
export { jsonError, parseBody } from "./http";
// The app's Worker must export these classes for the REALTIME and ROOMS bindings (see
// apps/server/src/index.ts).
export { configureRooms, type RoomMessageResult, type RoomPolicy } from "./realtime/config";
export { RealtimeHub } from "./realtime/hub";
export {
  publish,
  type RealtimeEvent,
  type RealtimeTarget,
  removeFromRoom,
} from "./realtime/publish";
export { RealtimeRoom } from "./realtime/room";

/** The Worker's handlers; routes added to `app` before the first request are served too. */
export const worker = {
  // A sample of invocations logs its D1 cost per query name (see db/metrics.ts).
  fetch: (request, env, ctx) =>
    metered(
      env,
      sampled(),
      { via: "fetch", path: new URL(request.url).pathname },
      (e, c) => Promise.resolve(app.fetch(request, e, c ?? ctx)),
      ctx,
    ),
  queue: (batch, env) =>
    metered(env, sampled(), { via: "queue" }, (e) =>
      handlePushBatch(batch as MessageBatch<PushQueueMessage>, e),
    ),
  async scheduled(controller, env, ctx) {
    // The app's wrangler.jsonc must list these; its script tests check that. Crons are few, so
    // every run is measured.
    if (controller.cron === CRONS.dispatch) {
      ctx.waitUntil(
        metered(env, true, { via: "cron:dispatch" }, (e) => enqueueDuePushes(e, Date.now())),
      );
    }
    if (controller.cron === CRONS.cleanup) {
      ctx.waitUntil(metered(env, true, { via: "cron:cleanup" }, (e) => runCleanup(e, Date.now())));
    }
  },
} satisfies ExportedHandler<Env>;
