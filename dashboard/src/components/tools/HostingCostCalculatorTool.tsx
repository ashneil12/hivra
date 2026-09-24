"use client";

// AI Agent Hosting Cost Calculator (/tools/ai-agent-hosting-cost-calculator).
//
// Compares the 12-month true cost of running one agent box on a DIY VPS (server
// bill plus your own hours priced at your rate) against Hivra's $9.99 a month
// plan (2 vCPU, 4 GB). Hivra's price includes no backups, so the DIY backups
// line starts off and the page says so; ticking it prices a DIY setup with
// more than Hivra's plan gives you. All external facts (VPS provider prices, backup rates)
// live in the RATES table with a lastVerified date that the page renders. The
// tool is honest: with time counted at $0, a small VPS wins on raw dollars and
// the verdict says so plainly.
//
// The retired version compared several agents against named plans with agent
// counts. Public copy may not state agent-count limits, and the checkout plan
// names collide with the public price ladder, so this version compares one
// computer with one computer and names Hivra's plan by price and size.

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import { TOOLS_CTA } from "@/lib/tools/tool-catalog";

// External facts, checked on 2026-09-24 against each provider's own source:
// docs.hetzner.com (price adjustment of 15 June 2026, IP pricing, billing FAQ),
// digitalocean.com/pricing/droplets, the public Vultr plans API
// (api.vultr.com/v2/plans) and aws.amazon.com/lightsail/pricing. List prices in
// USD with a public IPv4 address, before tax. Update lastVerified only when
// every value here is re-checked.
const RATES = {
  lastVerified: "2026-09-24",
  vps: {
    hetznerCx23: { label: "Hetzner CX23 (2 vCPU, 4 GB, 40 GB)", monthlyUsd: 7.09, sameSizeAsHivra: true },
    vultr1gb: { label: "Vultr Cloud Compute (1 vCPU, 1 GB, 25 GB)", monthlyUsd: 5, sameSizeAsHivra: false },
    vultr4gb: { label: "Vultr Cloud Compute (2 vCPU, 4 GB, 80 GB)", monthlyUsd: 20, sameSizeAsHivra: true },
    do1gb: { label: "DigitalOcean Basic (1 vCPU, 1 GB, 25 GB)", monthlyUsd: 6, sameSizeAsHivra: false },
    do4gb: { label: "DigitalOcean Basic (2 vCPU, 4 GB, 80 GB)", monthlyUsd: 24, sameSizeAsHivra: true },
    lightsail1gb: { label: "AWS Lightsail (2 vCPU, 1 GB, 40 GB)", monthlyUsd: 7, sameSizeAsHivra: false },
    lightsail4gb: { label: "AWS Lightsail (2 vCPU, 4 GB, 80 GB)", monthlyUsd: 24, sameSizeAsHivra: true },
  },
  extras: {
    // Hetzner bills backups at 20% of the server price; DigitalOcean's weekly
    // backups are 20% too (daily is 30%).
    backupsPctOfVps: 0.2,
  },
  // Hivra's own price, from lib/subscription/plans.ts (checkout plan 2 vCPU, 4 GB).
  hivra: { label: "Hivra $9.99 plan", size: "2 vCPU, 4 GB", monthlyUsd: 9.99 },
} as const;

type VpsKey = keyof typeof RATES.vps;

function formatUsd(value: number): string {
  if (value >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(value, 0) : 0;
}

interface BarSegment {
  label: string;
  value: number;
  className: string | undefined;
}

function StackedBar({ title, total, segments, maxTotal }: { title: string; total: number; segments: BarSegment[]; maxTotal: number }) {
  const widthPct = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
  return (
    <div className={styles.barRow}>
      <div className={styles.barHead}>
        <span>{title}</span>
        <strong>{formatUsd(total)}</strong>
      </div>
      <div className={styles.bar} style={{ width: `${Math.max(widthPct, 1)}%` }} aria-hidden="true">
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <span key={s.label} title={`${s.label}: ${formatUsd(s.value)}`} className={s.className} style={{ width: `${(s.value / total) * 100}%` }} />
          ))}
      </div>
    </div>
  );
}

export default function HostingCostCalculatorTool() {
  const [vpsKey, setVpsKey] = useState<VpsKey>("hetznerCx23");
  const [hourlyRate, setHourlyRate] = useState(50);
  const [setupHours, setSetupHours] = useState(3);
  const [maintHours, setMaintHours] = useState(2);
  const [incidentHours, setIncidentHours] = useState(1);
  // Off by default: Hivra's side of the comparison has no backups either.
  const [backups, setBackups] = useState(false);
  const [otherExtras, setOtherExtras] = useState(0);
  const [timeIsFree, setTimeIsFree] = useState(false);

  const vps = RATES.vps[vpsKey];
  const hivra = RATES.hivra;

  const infraMonthly = vps.monthlyUsd;
  const extrasMonthly = (backups ? vps.monthlyUsd * RATES.extras.backupsPctOfVps : 0) + nonNegative(otherExtras);

  const rate = nonNegative(hourlyRate);
  const setupCost = timeIsFree ? 0 : nonNegative(setupHours) * rate;
  const timeMonthly = timeIsFree ? 0 : (nonNegative(maintHours) + nonNegative(incidentHours)) * rate;

  const diyInfra12 = infraMonthly * 12;
  const diyExtras12 = extrasMonthly * 12;
  const diyTime12 = timeMonthly * 12;
  const diyTotal12 = diyInfra12 + diyExtras12 + diyTime12 + setupCost;
  const hivraTotal12 = hivra.monthlyUsd * 12;

  const maxTotal = Math.max(diyTotal12, hivraTotal12);
  const diyWins = diyTotal12 < hivraTotal12;
  const diff12 = Math.abs(diyTotal12 - hivraTotal12);

  let verdict: string;
  if (diyWins && timeIsFree) {
    verdict = `On raw dollars, DIY wins: ${formatUsd(diyTotal12)} vs ${formatUsd(hivraTotal12)} over 12 months, ${formatUsd(diff12)} less. If your time really is free and you enjoy running servers, rent the VPS.`;
  } else if (diyWins) {
    verdict = `Even with your hours counted, DIY comes out ${formatUsd(diff12)} cheaper over 12 months at these time estimates: ${formatUsd(diyTotal12)} vs ${formatUsd(hivraTotal12)}. If those estimates hold for you, self-host.`;
  } else if (timeIsFree) {
    verdict = `Even with your time at $0, this VPS costs more than Hivra's ${formatUsd(hivra.monthlyUsd)} plan: ${formatUsd(diyTotal12)} vs ${formatUsd(hivraTotal12)} over 12 months.`;
  } else {
    verdict = `The server was never the cost. At ${formatUsd(rate)}/hour, your hours are ${formatUsd(setupCost + diyTime12)} of the ${formatUsd(diyTotal12)} DIY total. Hivra's ${formatUsd(hivra.monthlyUsd)} plan runs ${formatUsd(hivraTotal12)} for the same 12 months, ${formatUsd(diff12)} less.`;
  }

  const segments: BarSegment[] = [
    { label: "VPS", value: diyInfra12, className: styles.segInk },
    { label: "Extras", value: diyExtras12, className: styles.segMid },
    { label: "Setup time", value: setupCost, className: styles.segFaint },
    { label: "Maintenance time", value: diyTime12, className: styles.segLight },
  ];

  const extrasNote = [backups && "backups", otherExtras > 0 && "other extras"].filter(Boolean).join(", ") || "none selected";
  const breakdownRows: { item: string; monthly: number; note: string }[] = [
    { item: "VPS", monthly: infraMonthly, note: vps.label },
    { item: "Extras", monthly: extrasMonthly, note: extrasNote },
    { item: "Setup time, spread over 12 months", monthly: setupCost / 12, note: timeIsFree ? "time counted at $0" : `${setupHours}h one-time at ${formatUsd(rate)}/h` },
    { item: "Maintenance and incident time", monthly: timeMonthly, note: timeIsFree ? "time counted at $0" : `${maintHours}h + ${incidentHours}h per month at ${formatUsd(rate)}/h` },
  ];

  return (
    <div className={styles.tool}>
      <div className={styles.inputs}>
        <div>
          <label className={styles.label} htmlFor="hc-vps">
            VPS preset
          </label>
          <select id="hc-vps" className={styles.field} value={vpsKey} onChange={(e) => setVpsKey(e.target.value as VpsKey)}>
            {(Object.keys(RATES.vps) as VpsKey[]).map((key) => (
              <option key={key} value={key}>
                {RATES.vps[key].label}: {formatUsd(RATES.vps[key].monthlyUsd)}/mo
              </option>
            ))}
          </select>
          <p className={styles.hint}>
            {vps.sameSizeAsHivra
              ? `Same CPU and memory as Hivra's ${hivra.size} computer.`
              : `Smaller than Hivra's ${hivra.size} computer. Compare like for like with a 4 GB preset.`}
          </p>
        </div>
        <div>
          <label className={styles.label} htmlFor="hc-rate">
            Your hourly rate (USD)
          </label>
          <input id="hc-rate" className={styles.field} type="number" min={0} step={5} value={hourlyRate} onChange={(e) => setHourlyRate(Number(e.target.value))} />
        </div>
        <div>
          <label className={styles.label} htmlFor="hc-setup">
            Initial setup hours (one-time)
          </label>
          <input id="hc-setup" className={styles.field} type="number" min={0} step={0.5} value={setupHours} onChange={(e) => setSetupHours(Number(e.target.value))} />
        </div>
      </div>

      <div className={styles.inputs}>
        <div>
          <label className={styles.label} htmlFor="hc-maint">
            Maintenance hours per month
          </label>
          <input id="hc-maint" className={styles.field} type="number" min={0} step={0.5} value={maintHours} onChange={(e) => setMaintHours(Number(e.target.value))} />
        </div>
        <div>
          <label className={styles.label} htmlFor="hc-incident">
            Incident recovery hours per month
          </label>
          <input id="hc-incident" className={styles.field} type="number" min={0} step={0.5} value={incidentHours} onChange={(e) => setIncidentHours(Number(e.target.value))} />
        </div>
        <div>
          <label className={styles.label} htmlFor="hc-other">
            Other extras per month (USD)
          </label>
          <input id="hc-other" className={styles.field} type="number" min={0} step={1} value={otherExtras} onChange={(e) => setOtherExtras(Number(e.target.value))} />
          <p className={styles.hint}>Monitoring, a floating IP, a domain. Your own figure.</p>
        </div>
      </div>

      <div className={styles.inputs}>
        <div>
          <span className={styles.label}>Extras</span>
          <label className={styles.check}>
            <input type="checkbox" checked={backups} onChange={(e) => setBackups(e.target.checked)} />
            Automated backups (+20% of the VPS price)
          </label>
          <p className={styles.hint}>Off by default. Hivra&apos;s $9.99 price does not include backups.</p>
        </div>
        <div>
          <span className={styles.label}>Time accounting</span>
          <label className={styles.check}>
            <input type="checkbox" checked={timeIsFree} onChange={(e) => setTimeIsFree(e.target.checked)} />
            My time is free (count hours at $0)
          </label>
        </div>
      </div>

      <div className={styles.panel}>
        <span className={styles.panelTitle}>12-month total cost</span>
        <StackedBar title="DIY: one VPS you run yourself" total={diyTotal12} segments={segments} maxTotal={maxTotal} />
        <StackedBar
          title={`${hivra.label} (${hivra.size}, ${formatUsd(hivra.monthlyUsd)}/mo)`}
          total={hivraTotal12}
          segments={[{ label: "Monthly plan", value: hivraTotal12, className: styles.segAccent }]}
          maxTotal={maxTotal}
        />
        <div className={styles.legend2}>
          {segments.map((s) => (
            <span key={s.label}>
              <i className={[styles.swatch, s.className].filter(Boolean).join(" ")} aria-hidden="true" />
              {s.label}
            </span>
          ))}
          <span>
            <i className={[styles.swatch, styles.segAccent].filter(Boolean).join(" ")} aria-hidden="true" />
            Hivra monthly plan
          </span>
        </div>
      </div>

      <p className={styles.verdict} data-testid="hc-verdict">{verdict}</p>

      <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Monthly cost breakdown">
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">DIY line item</th>
              <th scope="col" className={styles.num}>Per month</th>
              <th scope="col">Notes</th>
            </tr>
          </thead>
          <tbody>
            {breakdownRows.map((row) => (
              <tr key={row.item}>
                <td>{row.item}</td>
                <td className={styles.num}>{formatUsd(row.monthly)}</td>
                <td>{row.note}</td>
              </tr>
            ))}
            <tr className={styles.total}>
              <td>DIY total</td>
              <td className={styles.num}>{formatUsd(diyTotal12 / 12)}</td>
              <td>{formatUsd(diyTotal12)} over 12 months</td>
            </tr>
            <tr className={styles.hivra}>
              <td>{hivra.label}</td>
              <td className={styles.num}>{formatUsd(hivra.monthlyUsd)}</td>
              <td>{formatUsd(hivraTotal12)} over 12 monthly payments</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className={styles.note}>
        Assumptions: one VPS compared with one Hivra computer of {hivra.size}. Several light agents can share one
        server, which works until they compete for CPU and memory. DIY backups start off because Hivra&apos;s price
        does not include backups. Ticked, they cost 20% of the server, which is Hetzner&apos;s rate and
        DigitalOcean&apos;s weekly rate; other providers price backups differently. Model
        usage is excluded on both sides: you bring your own Claude or ChatGPT login or API key either way. The
        default time estimates (3h setup, 2h monthly maintenance, 1h monthly incident recovery) are our starting
        guesses, not measurements; edit them to match your experience. VPS prices are the providers&apos; list
        prices with a public IPv4 address, before tax. The Hetzner figure is its Germany and Finland price of $6.49
        plus $0.60 for the IPv4 address. Prices last verified {RATES.lastVerified} on each provider&apos;s own
        pages.
      </p>

      <div className={styles.bridge}>
        <p>
          If the hours column is the problem, a managed computer takes the install and the server off your hands. One
          monthly price, not paused for inactivity, your own model login: $9.99 a month for 2 vCPU and 4 GB, or
          $19.99 a month for 4 vCPU and 8 GB.
        </p>
        <Link href={TOOLS_CTA.primaryHref} className={styles.bridgeLink}>
          Start on the $9.99 plan
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
