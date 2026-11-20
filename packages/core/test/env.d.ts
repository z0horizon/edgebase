import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  // Vite's import.meta.glob, which vitest provides (the test reads the sources it guards).
  interface ImportMeta {
    glob<T>(
      pattern: string,
      options: { query?: string; import?: string; eager: true },
    ): Record<string, T>;
  }

  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      TEST_INBOX_MIGRATIONS: D1Migration[];
      SLOW_TESTS: string;
    }
  }
}
