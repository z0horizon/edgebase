export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Same-origin JSON call; the session cookie rides along. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: {
      ...init.headers,
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy or platform error page, not one of ours; the status below says enough.
  }
  if (!res.ok) {
    // EdgeBase routes answer { error: { message } }, Better Auth routes { message }.
    throw new ApiError(
      data?.error?.message ?? data?.message ?? `Request failed (${res.status})`,
      res.status,
    );
  }
  return data as T;
}

export type User = {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  emailVerified: boolean;
  createdAt: string;
};

export type Text = { title: string; body: string };
export type Category = "transactional" | "marketing";

export type Template = Text & {
  name: string;
  data?: Record<string, string>;
  category?: Category;
  translations?: Record<string, Text>;
  updatedAt: number;
};

export type PushStats = {
  id: number;
  category: Category;
  users: number;
  sent: number;
  failed: number;
  opened: number;
  sendAt: number;
};

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";
