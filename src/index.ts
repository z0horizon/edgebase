import { app } from "./app";
import { handlePushBatch } from "./push/consumer";
import type { PushQueueMessage } from "./push/types";

export default {
  fetch: app.fetch,
  queue: (batch, env) => handlePushBatch(batch as MessageBatch<PushQueueMessage>, env),
  async scheduled() {},
} satisfies ExportedHandler<Env>;
