"use client";

// AI agent running cost calculator (/tools/ai-agent-running-cost-calculator).
//
// Splits one always-on agent into the server, the model tokens and (optionally)
// your own time. Every price comes from lib/tools/agent-tools/agent-running-cost.ts,
// which reads the shared price tables; the usage presets are labelled as our
// assumptions. Nothing is sent anywhere: the answers stay in the browser, and the
// structured ones are written to the address bar with history.replaceState.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import ToolRadioGroup from "@/components/tools/ToolRadioGroup";
import { formatPlanSize, planSizeParts } from "@/lib/blog/plan-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { monthYear } from "@/lib/tools/month-year";
import {
  ALL_MODELS,
  DAYS_PER_MONTH,
  HIVRA_MODELS,
  LIMITS,
  OPENROUTER_OPTIONS,
  RUNNING_COST_DEFAULTS,
  RUNNING_COST_FACTS,
  RUNNING_COST_PARAM_KEYS,
  SERVER_OPTIONS,
  USAGE_PRESETS,
  buildVerdict,
  clamp,
  computeRunningCost,
  formatTokens,
  formatUsd,
  getModel,
  getServer,
  parseRunningCostParams,
  serializeRunningCostParams,
  effectiveUsage,
  type ModelOption,
  type RunningCostInput,
  type UsageKey,
} from "@/lib/tools/agent-tools/agent-running-cost";

const USAGE_OPTIONS: { value: UsageKey; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "typical", label: "Typical" },
  { value: "heavy", label: "Heavy" },
  { value: "custom", label: "Custom" },
];

function modelLabel(model: ModelOption): string {
  if (model.free) return `${model.label}: free`;
  return `${model.label}: ${formatUsd(model.inputUsdPerM)} in, ${formatUsd(model.outputUsdPerM)} out`;
}

export default function AgentRunningCostTool() {
  const [input, setInput] = useState<RunningCostInput>(RUNNING_COST_DEFAULTS);

  const [urlReady, setUrlReady] = useState(false);

  // The page renders its defaults on the server; read a shared link once after mount.
  useEffect(() => {
    try {
      const search = window.location.search;
      // Reading an external system (the address bar) once after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (search) setInput(parseRunningCostParams(search));
    } catch {
      // No address bar to read: keep the defaults.
    }
    setUrlReady(true);
  }, []);

  // Write the structured answers back to the address bar, once the mount read has run.
  useEffect(() => {
    if (!urlReady) return;
    try {
      const params = new URLSearchParams(window.location.search);
      for (const key of RUNNING_COST_PARAM_KEYS) params.delete(key);
      const own = serializeRunningCostParams(input);
      const merged = [params.toString(), own].filter(Boolean).join("&");
      window.history.replaceState(null, "", `${window.location.pathname}${merged ? `?${merged}` : ""}${window.location.hash}`);
    } catch {
      // History not available (a preview or a sandbox): the tool still works.
    }
  }, [input, urlReady]);

  const update = (patch: Partial<RunningCostInput>) => setInput({ ...input, ...patch });

  const cost = computeRunningCost(input);
  const server = getServer(input.server);
  const model = getModel(input.model);
  const usage = effectiveUsage(input);
  const verdict = buildVerdict(input);
  const timeApplies = server.kind !== "hivra";

  const segments = [
    { label: "Server", value: cost.serverUsd, className: styles.segVps },
    { label: "Model tokens", value: cost.tokensUsd, className: styles.segAccent },
    { label: "Your time", value: cost.timeUsd, className: styles.segSetup },
  ];

  const usagePlain =
    input.usage === "custom"
      ? `${usage.messagesPerDay.toLocaleString("en-US")} messages a day, about ${usage.tokensPerMessage.toLocaleString("en-US")} tokens each`
      : USAGE_PRESETS[input.usage].plain;

  const serverShort = server.kind === "hivra" ? `Hivra computer, ${planSizeParts(server.key === "hivra-larger" ? "larger" : "entry").size}` : server.label;
  const rows = [
    { item: "Server", amount: cost.serverUsd, note: serverShort },
    {
      item: "Model tokens",
      amount: cost.tokensUsd,
      note: `${model.label}, ${formatTokens(cost.monthlyTokens)} tokens a month`,
    },
    {
      item: "Your time",
      amount: cost.timeUsd,
      note: !input.countTime ? "not counted" : timeApplies ? `${clamp(input.hoursPerMonth, LIMITS.maxHours)}h a month at ${formatUsd(clamp(input.hourlyRate, LIMITS.maxRate))} an hour` : "counted as 0 hours on a managed computer",
    },
  ];

  return (
    <div className={styles.tool}>
      <div className={[styles.inputs, styles.inputsPreset].join(" ")}>
        <div>
          <label className={styles.label} htmlFor="arc-server">
            Where the agent runs
          </label>
          <select id="arc-server" className={styles.field} value={input.server} onChange={(e) => update({ server: e.target.value as RunningCostInput["server"] })}>
            {SERVER_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.monthlyUsd === 0 || option.kind === "hivra" ? option.label : `${option.label}: ${formatUsd(option.monthlyUsd)}/mo`}
              </option>
            ))}
          </select>
          <p className={styles.hint}>{server.note}</p>
        </div>
        <div>
          <label className={styles.label} htmlFor="arc-model">
            Model
          </label>
          <select id="arc-model" className={styles.field} value={input.model} onChange={(e) => update({ model: e.target.value })}>
            <optgroup label="Hivra managed inference (USD per million tokens)">
              {HIVRA_MODELS.map((option) => (
                <option key={option.key} value={option.key}>
                  {modelLabel(option)}
                </option>
              ))}
            </optgroup>
            <optgroup label="OpenRouter list price (USD per million tokens)">
              {OPENROUTER_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {modelLabel(option)}
                </option>
              ))}
            </optgroup>
          </select>
          <p className={styles.hint}>
            {ALL_MODELS.length} models. Hivra prices are from its managed inference list, updated {monthYear(RUNNING_COST_FACTS.models.hivraCatalogUpdatedAt)}. OpenRouter prices are list prices
            from {monthYear(RUNNING_COST_FACTS.models.openRouterSnapshotDate)}.
          </p>
        </div>
      </div>

      <div className={styles.inputs}>
        <ToolRadioGroup name="arc-usage" label="How busy is the agent?" options={USAGE_OPTIONS} value={input.usage} onChange={(usageKey) => update({ usage: usageKey })} />
      </div>
      <p className={styles.hint} data-testid="arc-usage-plain">
        Our assumption, not a measurement: {usagePlain}. Agents re-read their context and tool output at every step, so one message moves far more tokens than its text. That is{" "}
        {formatTokens(cost.monthlyTokens)} tokens over {DAYS_PER_MONTH} days.
      </p>

      {input.usage === "custom" && (
        <div className={styles.inputs}>
          <div>
            <label className={styles.label} htmlFor="arc-msgs">
              Messages per day
            </label>
            <input
              id="arc-msgs"
              className={styles.field}
              type="number"
              min={0}
              max={LIMITS.maxMessagesPerDay}
              step={1}
              value={input.messagesPerDay}
              onChange={(e) => update({ messagesPerDay: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className={styles.label} htmlFor="arc-tokens">
              Tokens per message
            </label>
            <input
              id="arc-tokens"
              className={styles.field}
              type="number"
              min={0}
              max={LIMITS.maxTokensPerMessage}
              step={1000}
              value={input.tokensPerMessage}
              onChange={(e) => update({ tokensPerMessage: Number(e.target.value) })}
            />
            <p className={styles.hint}>Input and output together, including tool calls. We price 85% as input and 15% as output.</p>
          </div>
        </div>
      )}

      <div className={styles.inputs}>
        <div>
          <span className={styles.label}>Your own time</span>
          <label className={styles.check}>
            <input type="checkbox" checked={input.countTime} onChange={(e) => update({ countTime: e.target.checked })} />
            Count my time (off by default)
          </label>
        </div>
        {input.countTime && (
          <>
            <div>
              <label className={styles.label} htmlFor="arc-hours">
                Hours per month
              </label>
              <input id="arc-hours" className={styles.field} type="number" min={0} max={LIMITS.maxHours} step={1} value={input.hoursPerMonth} onChange={(e) => update({ hoursPerMonth: Number(e.target.value) })} />
              <p className={styles.hint}>Our starting guess, not a measurement. Enter your own.</p>
            </div>
            <div>
              <label className={styles.label} htmlFor="arc-rate">
                Your hourly rate (USD)
              </label>
              <input id="arc-rate" className={styles.field} type="number" min={0} max={LIMITS.maxRate} step={5} value={input.hourlyRate} onChange={(e) => update({ hourlyRate: Number(e.target.value) })} />
            </div>
          </>
        )}
      </div>
      {input.countTime && !timeApplies && <p className={styles.hint}>Hours are not added for a managed computer: Hivra installs and runs the agent. You still set the agent up.</p>}

      <div className={styles.panel}>
        <span className={styles.panelTitle}>Estimated monthly cost</span>
        <div className={styles.barRow}>
          <div className={styles.barHead}>
            <span>One always-on agent</span>
            <strong data-testid="arc-total">{formatUsd(cost.totalUsd)} a month</strong>
          </div>
          <div className={styles.bar} role="img" aria-label={`Split: ${segments.map((s) => `${s.label} ${formatUsd(s.value)}`).join(", ")}`}>
            {cost.totalUsd > 0 ? (
              segments
                .filter((s) => s.value > 0)
                .map((s) => <span key={s.label} title={`${s.label}: ${formatUsd(s.value)}`} className={s.className} style={{ width: `${(s.value / cost.totalUsd) * 100}%` }} />)
            ) : (
              <span style={{ width: "100%" }} />
            )}
          </div>
        </div>
        <div className={styles.legend2}>
          {segments.map((s) => (
            <span key={s.label}>
              <i className={[styles.swatch, s.className].filter(Boolean).join(" ")} aria-hidden="true" />
              {s.label}
            </span>
          ))}
        </div>
        <p className={styles.hint}>
          Server: {serverShort}. Model: {model.label}.
        </p>
      </div>

      <p className={styles.verdict} data-testid="arc-verdict">
        {verdict}
      </p>

      <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Monthly cost breakdown">
        <table className={[styles.table, styles.tableStack].join(" ")} role="table">
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">Line item</th>
              <th scope="col" role="columnheader" className={styles.num}>Per month</th>
              <th scope="col" role="columnheader">Notes</th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((row) => (
              <tr key={row.item} role="row">
                <td role="cell">{row.item}</td>
                <td role="cell" className={styles.num}>{formatUsd(row.amount)}</td>
                <td role="cell">{row.note}</td>
              </tr>
            ))}
            <tr role="row" className={styles.total}>
              <td role="cell">Total</td>
              <td role="cell" className={styles.num}>{formatUsd(cost.totalUsd)}</td>
              <td role="cell">about {formatUsd(cost.totalUsd * 12)} over 12 months on {serverShort}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className={styles.note}>
        <strong className={styles.noteLead}>Assumptions:</strong> the usage presets are ours: light is 10 messages a day at 20,000 tokens each, typical is 40 at 40,000, heavy is 150 at 80,000. We
        price {DAYS_PER_MONTH} days a month, 85% of tokens as input and 15% as output. Prompt caching is not modelled, so a model that caches will cost less than shown. A laptop you own is $0 and
        electricity is not counted; it sleeps when it idles or the lid closes. VPS prices are the providers&apos; list prices before tax, last checked {monthYear(RUNNING_COST_FACTS.vps.lastVerified)}
        , and Hetzner&apos;s own page now shows that size as unavailable. Free models are rate limited and can change. The model line is priced separately from the Hivra plan in this tool.
      </p>

      <div className={styles.bridge}>
        <p>
          If you would rather not run the server, Hivra offers a managed computer starting at {formatPlanSize("entry")}. It installs and runs the official agent. The model line above is
          priced separately in this tool.
        </p>
        <Link href={PUBLIC_START_HREF} className={styles.bridgeLink}>
          Start on Hivra
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
