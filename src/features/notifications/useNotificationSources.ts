import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, events, type AccountSummary } from "../../api";
import { useCrashes, useInstances } from "../../data";
import { useOwnedUpdate } from "../update/OwnedUpdate";
import { useAnnouncementFeed } from "../update/UpdatesPage";
import { notify, openNotice, useNotifications } from "./store";

export function useNotificationSources(accounts: AccountSummary[] | undefined) {
  const { options } = useNotifications();
  const { status } = useOwnedUpdate();
  const crashes = useCrashes();
  const clients = useInstances();
  const since = useRef(Date.now());
  const previous = useRef(new Map<string, { state: string; startedAt: number }>());
  useAnnouncementFeed(options.announcements);

  useEffect(() => {
    const unlisten = events.onNotificationOpen(openNotice);
    void unlisten.catch(() => {});
    return () => { void unlisten.then((remove) => remove()).catch(() => {}); };
  }, []);
  useEffect(() => {
    if (status?.configured && status.available) {
      notify("app", status.available, `UnknownALT ${status.available} is ready to install.`, { view: "updates" });
    }
  }, [status?.configured, status?.available, options.app]);
  useEffect(() => {
    for (const item of crashes.data ?? []) {
      if (item.at >= since.current && item.kind === "crash") {
        notify("crashes", String(item.id), "A managed Roblox client crashed.", { view: "crashes" });
      }
    }
  }, [crashes.data]);
  useEffect(() => {
    if (!clients.data) return;
    const before = previous.current;
    previous.current = new Map(clients.data.map((client) => [client.id, client]));
    for (const client of clients.data) {
      const known = before.get(client.id);
      if (client.state === "disconnected" && known && known.state !== "disconnected") {
        notify("disconnects", `${client.id}:${client.startedAt}:${Math.floor(Date.now() / 60_000)}`,
          "A managed Roblox client lost its connection.", { view: "monitor" });
      }
    }
  }, [clients.data]);

  const ids = (accounts ?? []).filter((account) => account.status === "valid").map((account) => account.id);
  const friends = useRef({ counts: new Map<number, number>(), offset: 0 });
  useEffect(() => {
    if (!options.friends) friends.current = { counts: new Map(), offset: 0 };
  }, [options.friends]);
  useQuery({
    queryKey: ["friendRequestCounts", ids], enabled: options.friends && ids.length > 0,
    queryFn: async () => {
      const offset = friends.current.offset % ids.length;
      const batch = [...ids.slice(offset), ...ids.slice(0, offset)].slice(0, 8);
      const rows = await api.friendRequestCounts(batch);
      friends.current.offset = (offset + batch.length) % ids.length;
      const previous = friends.current.counts;
      for (const [id, count] of rows) {
        const old = previous.get(id);
        previous.set(id, count);
        if (old != null && count > old) {
          notify("friends", `${id}:${Date.now()}:${count}`, "A signed-in Roblox account has new friend requests.", { view: "accounts" });
        }
      }
      return rows;
    },
    staleTime: 120_000, refetchInterval: 120_000, refetchIntervalInBackground: true, retry: false,
  });
}
