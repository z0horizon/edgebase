import { Hono } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { jsonError, parseBody } from "../http";
import {
  type PushDispatch,
  PushDispatchSchema,
  type PushRequest,
  type Template,
  TemplateNameSchema,
  TemplateSchema,
} from "./types";

const MAX_TEMPLATES = 500;
const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

async function getTemplate(db: D1Database, name: string): Promise<Template | null> {
  const content = await db
    .prepare("SELECT content FROM push_template WHERE name = ?")
    .bind(name)
    .first<string>("content");
  return content === null ? null : (JSON.parse(content) as Template);
}

class MissingVar extends Error {}

/** `text` with every `{{name}}` filled from `vars`; a placeholder without a var is an error. */
export function render(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new MissingVar(name);
    return value;
  });
}

const mapValues = <T, R>(record: Record<string, T>, fn: (value: T) => R): Record<string, R> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]));

/**
 * The push a request describes: template fields under the request's own, placeholders filled,
 * then checked like any push. A string is the 400 message.
 */
export async function resolvePush(
  db: D1Database,
  req: Omit<PushRequest, "sendAt">,
): Promise<PushDispatch | string> {
  const { template: name, vars, ...own } = req;
  const template = name ? await getTemplate(db, name) : null;
  if (name && !template) return `unknown template "${name}"`;
  // A field the request leaves out must not hide the template's.
  const defined = Object.fromEntries(
    Object.entries(own).filter(([, value]) => value !== undefined),
  );
  let merged = { ...template, ...defined } as Omit<PushRequest, "sendAt" | "template" | "vars">;
  if (template || vars) {
    const fill = (text: string) => render(text, vars ?? {});
    try {
      merged = {
        ...merged,
        ...(merged.title !== undefined && { title: fill(merged.title) }),
        ...(merged.body !== undefined && { body: fill(merged.body) }),
        ...(merged.data && { data: mapValues(merged.data, fill) }),
        ...(merged.translations && {
          translations: mapValues(merged.translations, (t) => ({
            title: fill(t.title),
            body: fill(t.body),
          })),
        }),
      };
    } catch (error) {
      if (error instanceof MissingVar) return `missing var "${error.message}"`;
      throw error;
    }
  }
  const result = v.safeParse(PushDispatchSchema, merged);
  return result.success ? result.output : v.summarize(result.issues);
}

export const templateRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    // Bounded by MAX_TEMPLATES, so one page holds them all.
    const rows = await c.env.DB.prepare(
      "SELECT name, content, updated_at FROM push_template ORDER BY name",
    ).all<{ name: string; content: string; updated_at: number }>();
    return c.json({
      templates: rows.results.map((r) => ({
        name: r.name,
        ...(JSON.parse(r.content) as Template),
        updatedAt: r.updated_at,
      })),
    });
  })
  .put("/:name", async (c) => {
    const name = c.req.param("name");
    if (!v.is(TemplateNameSchema, name)) {
      return jsonError(400, "invalid_body", "name must match [a-z0-9_.-]{1,64}");
    }
    const body = await parseBody(c, TemplateSchema);
    if (body instanceof Response) return body;
    // An update always fits; a new name only while under the cap.
    const result = await c.env.DB.prepare(
      `INSERT INTO push_template (name, content, updated_at) SELECT ?1, ?2, ?3
       WHERE (SELECT count(*) FROM push_template) < ?4
          OR EXISTS (SELECT 1 FROM push_template WHERE name = ?1)
       ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
    )
      .bind(name, JSON.stringify(body), Date.now(), MAX_TEMPLATES)
      .run();
    if (result.meta.changes === 0) {
      return jsonError(409, "limit_reached", `at most ${MAX_TEMPLATES} templates`);
    }
    return c.body(null, 204);
  })
  .get("/:name", async (c) => {
    const template = await getTemplate(c.env.DB, c.req.param("name"));
    return template ? c.json(template) : jsonError(404, "not_found", "No such template");
  })
  .delete("/:name", async (c) => {
    await c.env.DB.prepare("DELETE FROM push_template WHERE name = ?")
      .bind(c.req.param("name"))
      .run();
    return c.body(null, 204);
  });
