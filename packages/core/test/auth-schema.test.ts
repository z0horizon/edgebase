import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { getMigrations } from "better-auth/db/migration";
import { expect, it } from "vitest";
import { createAuth } from "../src/auth/auth";

// Runtime schema validation is off (it would run on every request); this is that check, against
// the database the migrations in packages/core/migrations build.
it("the migrations give Better Auth every table, column and index it expects", async () => {
  const auth = createAuth(env, createExecutionContext(), new Request("https://api.test/"));
  const { toBeCreated, toBeAdded, toBeAddedIndexes, schemaProblems } = await getMigrations(
    auth.options,
    { throwOnUnsafe: false },
  );
  expect(toBeCreated.map((t) => t.table)).toEqual([]);
  expect(toBeAdded.map((t) => t.table)).toEqual([]);
  expect(toBeAddedIndexes).toEqual([]);
  expect(schemaProblems).toEqual([]);
});

it("would notice a column the migrations do not have", async () => {
  const auth = createAuth(env, createExecutionContext(), new Request("https://api.test/"));
  const options = auth.options;
  const { toBeAdded } = await getMigrations(
    {
      ...options,
      user: {
        ...options.user,
        additionalFields: { ...options.user?.additionalFields, notMigrated: { type: "string" } },
      },
    },
    { throwOnUnsafe: false },
  );
  expect(toBeAdded.map((t) => t.table)).toEqual(["user"]);
});
