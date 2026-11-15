// Native AppUpdate status and progress, emitted through app://update.
export type AppUpdate = {
  configured: boolean;
  current: string;
  available: string | null;
  state: "unconfigured" | "idle" | "checking" | "available" | "downloading" | "verifying" | "installing" | "error";
  downloaded: number;
  total: number | null;
  error: string | null;
};
