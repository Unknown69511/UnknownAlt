const MAX_QUEUED = 40;
const MAX_AGE = 30_000;
type Pending = { expires: number; deliver: () => void };
const pending = new Map<string, Pending>();
let ready = false;

export function afterStartup(key: string, deliver: () => void, now = Date.now()) {
  if (ready) { deliver(); return; }
  if (pending.has(key)) return;
  if (pending.size >= MAX_QUEUED) pending.delete(pending.keys().next().value!);
  pending.set(key, { expires: now + MAX_AGE, deliver });
}

export function dropStartupNotices(prefix: string) {
  for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
}

export function finishStartupNotices(now = Date.now()) {
  if (ready) return;
  ready = true;
  const queued = [...pending.values()];
  pending.clear();
  for (const item of queued) if (item.expires > now) item.deliver();
}
