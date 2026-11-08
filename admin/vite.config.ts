import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev` runs the Worker on 8787. The page calls it through this proxy, which presents the
// Worker's own origin, since auth and admin routes refuse requests from other origins.
const WORKER = "http://localhost:8787";
const worker = {
  target: WORKER,
  configure: (proxy: {
    on: (
      event: "proxyReq",
      fn: (req: { setHeader: (k: string, v: string) => void }) => void,
    ) => void;
  }) => proxy.on("proxyReq", (req) => req.setHeader("origin", WORKER)),
};

// Built into the Worker's static assets and served at /admin/ (see wrangler.jsonc).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "../public/admin", emptyOutDir: true },
  server: { proxy: { "/api": worker, "/v1": worker } },
});
