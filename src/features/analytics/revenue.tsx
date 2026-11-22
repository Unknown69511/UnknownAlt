import { createContext, useContext, type ReactNode } from "react";
import { fmtExact, fmtNum } from "../../i18n";
import { useStored } from "../../ui/stored";
import { number } from "./archive";

type Currency = "USD" | "Robux" | "Both";
const RevenueCurrency = createContext<Currency>("USD");
const DEVEX_USD = 0.0038;
const CREATOR_SHARE = .70;
const DAYS_PER_MONTH = 30;

export function RevenuePreference({ children }: { children: (picker: ReactNode) => ReactNode }) {
  const [currency, select] = useStored<Currency>("UnknownALT.analytics.revenueCurrency",
    (value) => value === "Robux" || value === "Both" ? value : "USD", String);
  return <RevenueCurrency.Provider value={currency}>{children(
    <label className="analytics-revenue-picker"><span>Revenue currency</span>
      <select className="field" aria-label="Revenue currency" value={currency} onChange={(event) => select(event.target.value as Currency)}>
        <option>USD</option><option>Robux</option><option>Both</option>
      </select>
    </label>,
  )}</RevenueCurrency.Provider>;
}

export function monthlyEstimate(usd: unknown, dailyRobux: unknown) {
  const dollars = number(usd);
  const daily = number(dailyRobux);
  // RoWatcher publishes gross spending in Robux and after-fee DevEx equivalents in USD.
  // Prefer the published amount. Where only USD is available, reverse the model's assumptions.
  const robux = daily == null ? dollars == null ? null : dollars / (DEVEX_USD * CREATOR_SHARE) : daily * DAYS_PER_MONTH;
  return { dollars, robux: robux == null ? null : Math.round(robux) };
}
export type EstimateValue = ReturnType<typeof monthlyEstimate>;

const USD = { style: "currency", currency: "USD", maximumFractionDigits: 0 } as const;

export function Revenue({ estimate }: { estimate: EstimateValue }) {
  const currency = useContext(RevenueCurrency);
  const { dollars, robux } = estimate;
  const figures = [];
  if (currency !== "Robux" && dollars != null) figures.push(<span key="usd" title={fmtExact(dollars, USD)}>{fmtNum(dollars, USD)} USD</span>);
  if (currency !== "USD" && robux != null) figures.push(<span key="robux" title={fmtExact(robux)}>{fmtNum(robux)} Robux</span>);
  return figures.length ? <span className="analytics-revenue-value">{figures}</span> : <>Unavailable</>;
}

export function RevenueAssumptions() {
  const currency = useContext(RevenueCurrency);
  return <p className="analytics-feedback">
    {currency === "USD" ? "USD estimates use the model’s standard DevEx rate of $0.0038 per eligible Earned Robux, before taxes."
      : "Robux estimates represent gross player spending. The model uses a 30-day month, a 30% fee, and a standard $0.0038 DevEx rate."}
    {" "}Roblox ranks and authorized Creator Analytics are separate from these estimates.
  </p>;
}
