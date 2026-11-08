import { app } from "./app";

export default {
  fetch: app.fetch,
  async queue() {},
  async scheduled() {},
} satisfies ExportedHandler<Env>;
