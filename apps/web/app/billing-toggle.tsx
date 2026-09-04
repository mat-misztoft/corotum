"use client";

import { useState } from "react";

const monthly = 5.99;
const yearly = 59.9;
const yearlySavings = monthly * 12 - yearly;
const savedMonths = Math.round(yearlySavings / monthly);

type BillingPeriod = "monthly" | "yearly";

export function BillingToggle() {
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const selectedPrice = period === "monthly" ? monthly : yearly;
  const unit = period === "monthly" ? "month" : "year";

  return (
    <div className="cloud-billing">
      <fieldset className="billing-period">
        <legend>Billing period</legend>
        <label>
          <input
            checked={period === "monthly"}
            data-umami-event="billing-period"
            data-umami-event-period="monthly"
            name="billing-period"
            onChange={() => setPeriod("monthly")}
            type="radio"
            value="monthly"
          />
          <span>MONTHLY</span>
        </label>
        <label>
          <input
            checked={period === "yearly"}
            data-umami-event="billing-period"
            data-umami-event-period="yearly"
            name="billing-period"
            onChange={() => setPeriod("yearly")}
            type="radio"
            value="yearly"
          />
          <span>
            YEARLY{" "}
            <small className="billing-saving">Save {savedMonths} months</small>
          </span>
        </label>
      </fieldset>
      <dl className="cloud-price-display" aria-live="polite">
        <div>
          <dt>{period.toUpperCase()}</dt>
          <dd>
            ${selectedPrice.toFixed(2)} <small>/ {unit}</small>
          </dd>
        </div>
      </dl>
    </div>
  );
}
