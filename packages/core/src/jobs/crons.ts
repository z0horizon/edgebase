// Plain constants so the app's script tests can check them against its wrangler.jsonc.
export const CRONS = {
  /** Sends scheduled pushes that are due. */
  dispatch: "* * * * *",
  /** Retention cleanup, in small time budgets. */
  cleanup: "17 * * * *",
};
