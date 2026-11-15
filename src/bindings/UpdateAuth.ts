/** Public state only. Device codes and access tokens stay in native code. */
export type UpdateAuth = {
  configured: boolean;
  connected: boolean;
  login: string | null;
  state: "public" | "unconfigured" | "disconnected" | "pending" | "connected" | "error";
  userCode: string | null;
  verificationUri: string | null;
  expiresAt: number | null;
  pollAfterMs: number | null;
  error: string | null;
};
