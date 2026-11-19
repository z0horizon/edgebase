/**
 * One request shared by every caller until `refresh()`: pages that need the same list ask once.
 * A failed request is not kept, so the next caller tries again.
 */
export function sharedRequest<T>(load: () => Promise<T>) {
  let pending: Promise<T> | null = null;
  const start = (): Promise<T> => {
    const request: Promise<T> = load().catch((error: unknown) => {
      // A newer refresh may have replaced it; only drop our own failure.
      if (pending === request) pending = null;
      throw error;
    });
    pending = request;
    return request;
  };
  return {
    get: (): Promise<T> => pending ?? start(),
    refresh: (): Promise<T> => start(),
  };
}
