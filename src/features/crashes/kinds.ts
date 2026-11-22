import type { Crash, CrashKind } from "../../api";
import { t, type Key } from "../../i18n";

export const CRASH_KINDS: Record<CrashKind, Key> = {
  crash: "launch.crash.exitGroup",
  disconnect: "launch.crash.disconnect",
  hang: "launch.crash.hang",
  mem: "launch.crash.mem",
  timed: "launch.crash.timed",
};
export const crashTitle = (c: Crash) => t(c.kind === "crash" ? (c.verdict === "crashed" ? "launch.crash.crash" : "launch.crash.unconfirmed") : CRASH_KINDS[c.kind]);

/** What the autopsy made of a client that just ended (`Crash.verdict`). The other kinds say it themselves. */
const VERDICTS: Record<string, Key> = {
  crashed: "crashes.verdict.crashed",
  noLog: "crashes.verdict.noLog",
  early: "crashes.verdict.early",
  unknown: "crashes.verdict.unknown",
};
export const verdictOf = (c: Crash) => (c.kind === "crash" && c.verdict && VERDICTS[c.verdict] ? t(VERDICTS[c.verdict]) : null);
