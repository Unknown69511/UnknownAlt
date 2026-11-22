import { Icon } from "../../ui/Icon";
import { categories, openNotice, setNotification, useNotifications, type Category } from "./store";

export function NotificationsPanel({ block }: { block?: string }) {
  const { options, history } = useNotifications();
  return <section data-block={block} className="panel p-4 space-y-4">
    <h2 className="font-semibold flex items-center gap-2"><Icon name="bell" /> Notifications</h2>
    <div className="grid gap-2 sm:grid-cols-2">
      {(Object.entries(categories) as [Category, string][]).map(([id, label]) =>
        <label className="flex items-center gap-3 border border-line rounded-lg p-3 text-sm" key={id}>
          <input type="checkbox" checked={options[id]} onChange={(event) => setNotification(id, event.target.checked)} />{label}
        </label>)}
    </div>
    <p className="text-sm text-fg-2">Friend requests are checked using your signed-in accounts only when enabled. Alerts stay on this device.</p>
    <h3 className="font-semibold">Notification history</h3>
    {history.length === 0 && <p className="text-sm text-fg-2">Nothing to show yet.</p>}
    <ul className="divide-y divide-line">{history.map((item) =>
      <li key={item.id}><button className="py-3 text-start w-full flex items-start gap-3" onClick={() => openNotice(item.id)}>
        <Icon name={item.read ? "check" : "bell"} />
        <span className="min-w-0"><span className="block text-sm">{item.text}</span>
          <span className="text-xs text-fg-2">{categories[item.type]} · {new Date(item.at).toLocaleString()}</span></span>
      </button></li>)}</ul>
  </section>;
}
