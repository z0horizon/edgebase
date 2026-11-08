import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          TEST_INBOX_MIGRATIONS: await readD1Migrations("./migrations-inbox"),
          BASE_URL: "https://api.test",
          TRUSTED_ORIGINS: "https://web.test,edgebase://",
          BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789",
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          APPLE_CLIENT_ID: "com.example.web",
          APPLE_CLIENT_SECRET: "apple-secret",
          APPLE_APP_BUNDLE_IDENTIFIER: "com.example.app",
          GITHUB_CLIENT_ID: "gh-client",
          GITHUB_CLIENT_SECRET: "gh-secret",
          PUSH_API_KEY: "test-push-key",
          // Tests that need a real service account pass their own.
          FCM_SERVICE_ACCOUNT: "",
        },
      },
    })),
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["test/apply-migrations.ts"] },
});
