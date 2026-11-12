"use client";

// Free and cheap models for AI agents (/tools/best-free-models-for-ai-agents).
//
// A sortable, filterable table of models that accept tool calls, from two dated lists: Hivra's managed
// inference list and a copy of OpenRouter's list prices. Every number comes from
// lib/tools/agent-tools/agent-model-finder.ts. Nothing is sent anywhere: the name search stays in the
// page, and the structured filters are written to the address bar with history.replaceState.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import styles from "@/app/tools/tools.module.css";
import finderStyles from "@/components/tools/AgentModelFinderTool.module.css";
import ToolRadioGroup from "@/components/tools/ToolRadioGroup";
import { formatPlanSize } from "@/lib/blog/plan-facts";
import { agentDeployHref } from "@/lib/hivra/agent-seo-catalog";
import { monthYear } from "@/lib/tools/month-year";
import {
  DAYS_PER_MONTH,
  FINDER_DEFAULTS,
  FINDER_PARAM_KEYS,
  FINDER_ROWS,
  MIN_CONTEXT_KEYS,
  MIN_CONTEXT_LABEL,
  MODEL_FINDER_FACTS,
  SORT_KEYS,
  SORT_LABEL,
  USAGE_KEYS,
  WHERE_FILTER_KEYS,
  WHERE_LABEL,
  costPerDayUsd,
  defaultDir,
  findRows,
  formatContext,
  formatPrice,
  formatTokenCount,
  parseFinderParams,
  serializeFinderParams,
  summarize,
  tokensPerDay,
  type FinderRow,
  type FinderState,
  type PriceFilter,
  type SortKey,
  type UsageKey,
} from "@/lib/tools/agent-tools/agent-model-finder";
import { USAGE_PRESETS } from "@/lib/tools/agent-tools/agent-running-cost";

const PRICE_OPTIONS: { value: PriceFilter; label: string }[] = [
  { value: "all", label: "All models" },
  { value: "free", label: "Free only" },
  { value: "paid", label: "Paid only" },
];

const USAGE_OPTIONS: { value: UsageKey; label: string }[] = USAGE_KEYS.map((key) => ({ value: key, label: USAGE_PRESETS[key].label }));

const WHERE_OPTIONS: Record<(typeof WHERE_FILTER_KEYS)[number], string> = {
  all: "Both lists",
  hivra: WHERE_LABEL.hivra,
  openrouter: WHERE_LABEL.openrouter,
};

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "name", label: "Model", numeric: false },
  { key: "input", label: "Input $/M", numeric: true },
  { key: "output", label: "Output $/M", numeric: true },
  { key: "context", label: "Context", numeric: true },
  { key: "cost", label: "Est. cost per agent-day", numeric: true },
];

function tagsFor(row: FinderRow): { label: string; free?: boolean }[] {
  const tags: { label: string; free?: boolean }[] = [];
  if (row.free) tags.push({ label: "Free", free: true });
  if (row.isPrivate) tags.push({ label: "Private" });
  if (row.reasoning) tags.push({ label: "Reasoning" });
  if (row.imageInput) tags.push({ label: "Image input" });
  return tags;
}

const START_HREF = agentDeployHref({ agentType: "general" });

export default function AgentModelFinderTool() {
  const [state, setState] = useState<FinderState>(FINDER_DEFAULTS);
  const [query, setQuery] = useState("");

  // The page renders its defaults on the server; read a shared link once after mount.
  useEffect(() => {
    try {
      const search = window.location.search;
      // Reading an external system (the address bar) once after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (search) setState(parseFinderParams(search));
    } catch {
      // No address bar to read: keep the defaults.
    }
  }, []);

  const update = (patch: Partial<FinderState>) => setState({ ...state, ...patch });

  // Keep the address bar in step with the filters, leaving other query params and the hash alone.
  // Skipped on the first render so mounting never rewrites the address.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    try {
      const params = new URLSearchParams(window.location.search);
      for (const key of FINDER_PARAM_KEYS) params.delete(key);
      const own = serializeFinderParams(state);
      const merged = [params.toString(), own].filter(Boolean).join("&");
      window.history.replaceState(null, "", `${window.location.pathname}${merged ? `?${merged}` : ""}${window.location.hash}`);
    } catch {
      // History not available (a preview or a sandbox): the tool still works.
    }
  }, [state]);

  const chooseSort = (sort: SortKey) => {
    if (sort === state.sort) update({ dir: state.dir === "asc" ? "desc" : "asc" });
    else update({ sort, dir: defaultDir(sort) });
  };

  const rows = findRows(state, query);
  const summary = summarize(rows, state.usage);
  const usagePreset = USAGE_PRESETS[state.usage];
  const ariaSort = (key: SortKey): "ascending" | "descending" | "none" => (state.sort === key ? (state.dir === "asc" ? "ascending" : "descending") : "none");

  const statusText =
    rows.length === 0
      ? "No model matches these filters. Loosen one."
      : `${rows.length} of ${FINDER_ROWS.length} models match.${
          summary.cheapestPaid ? ` Lowest estimated cost among the paid ones: ${summary.cheapestPaid.name}, about ${formatPrice(costPerDayUsd(summary.cheapestPaid, state.usage))} a day.` : ""
        }${summary.freeCount > 0 ? ` ${summary.freeCount} free.` : ""}`;

  return (
    <div className={styles.tool}>
      <div className={styles.inputs}>
        <ToolRadioGroup name="amf-price" label="Price" options={PRICE_OPTIONS} value={state.price} onChange={(price) => update({ price })} />
        <div>
          <span className={styles.label}>Needs</span>
          <label className={styles.check}>
            <input type="checkbox" checked={state.privateOnly} onChange={(e) => update({ privateOnly: e.target.checked })} />
            Private models only
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={state.reasoningOnly} onChange={(e) => update({ reasoningOnly: e.target.checked })} />
            Reasoning models only
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={state.imageOnly} onChange={(e) => update({ imageOnly: e.target.checked })} />
            Accepts image input
          </label>
        </div>
        <div>
          <label className={styles.label} htmlFor="amf-context">
            Minimum context window
          </label>
          <select id="amf-context" className={styles.field} value={state.minContext} onChange={(e) => update({ minContext: e.target.value as FinderState["minContext"] })}>
            {MIN_CONTEXT_KEYS.map((key) => (
              <option key={key} value={key}>
                {MIN_CONTEXT_LABEL[key]}
              </option>
            ))}
          </select>
          <label className={styles.label} htmlFor="amf-where" style={{ marginTop: 20 }}>
            Where
          </label>
          <select id="amf-where" className={styles.field} value={state.where} onChange={(e) => update({ where: e.target.value as FinderState["where"] })}>
            {WHERE_FILTER_KEYS.map((key) => (
              <option key={key} value={key}>
                {WHERE_OPTIONS[key]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={styles.label} htmlFor="amf-search">
            Search by name
          </label>
          <input id="amf-search" className={[styles.field, finderStyles.search].join(" ")} type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
          <p className={styles.hint}>Stays in this page. It is not added to the link.</p>
        </div>
      </div>

      <div className={styles.inputs}>
        <ToolRadioGroup name="amf-usage" label="How busy is the agent? (for the cost column)" options={USAGE_OPTIONS} value={state.usage} onChange={(usage) => update({ usage })} />
      </div>
      <p className={styles.hint} data-testid="amf-usage-plain">
        Our assumption, not a measurement: {usagePreset.plain}, about {formatTokenCount(tokensPerDay(state.usage))} tokens an agent-day, or {formatTokenCount(tokensPerDay(state.usage) * DAYS_PER_MONTH)} over{" "}
        {DAYS_PER_MONTH} days. We price 85% as input and 15% as output at list price, with no caching.
      </p>

      <div className={finderStyles.phoneSort}>
        <div>
          <label className={styles.label} htmlFor="amf-sort">
            Sort by
          </label>
          <select id="amf-sort" className={styles.field} value={state.sort} onChange={(e) => chooseSort(e.target.value as SortKey)}>
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABEL[key]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className={styles.smallButton}
          style={{ marginTop: 0 }}
          aria-label={`Sort direction: ${state.dir === "asc" ? "low to high" : "high to low"}. Press to reverse.`}
          onClick={() => update({ dir: state.dir === "asc" ? "desc" : "asc" })}>
          {state.dir === "asc" ? "Low to high" : "High to low"}
        </button>
      </div>

      <p className={finderStyles.statusLine} role="status" data-testid="amf-status">
        {statusText}
      </p>

      <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Models that accept tool calls">
        <table className={[styles.table, finderStyles.modelTable].join(" ")} data-testid="amf-table">
          <caption>
            Sorted by {SORT_LABEL[state.sort].toLowerCase()}, {state.dir === "asc" ? "low to high" : "high to low"}. Prices are USD per million tokens at list price.
          </caption>
          <thead>
            <tr>
              {COLUMNS.slice(0, 1).map((column) => (
                <th key={column.key} scope="col" aria-sort={ariaSort(column.key)}>
                  <button type="button" className={finderStyles.sortButton} onClick={() => chooseSort(column.key)}>
                    {column.label}
                    <span className={finderStyles.arrow} aria-hidden="true">
                      {state.sort === column.key ? (state.dir === "asc" ? "↑" : "↓") : ""}
                    </span>
                  </button>
                </th>
              ))}
              <th scope="col">Where</th>
              {COLUMNS.slice(1).map((column) => (
                <th key={column.key} scope="col" className={styles.num} aria-sort={ariaSort(column.key)}>
                  <button type="button" className={finderStyles.sortButton} onClick={() => chooseSort(column.key)}>
                    {column.label}
                    <span className={finderStyles.arrow} aria-hidden="true">
                      {state.sort === column.key ? (state.dir === "asc" ? "↑" : "↓") : ""}
                    </span>
                  </button>
                </th>
              ))}
              <th scope="col">Tags</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className={finderStyles.empty}>
                  No model matches these filters.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const cost = costPerDayUsd(row, state.usage);
              return (
                <tr key={row.key} data-testid="amf-row">
                  <th scope="row">{row.name}</th>
                  <td data-label="Where" className={finderStyles.where}>
                    {WHERE_LABEL[row.where]}
                  </td>
                  <td data-label="Input $/M" className={styles.num}>
                    {formatPrice(row.inputUsdPerM)}
                  </td>
                  <td data-label="Output $/M" className={styles.num}>
                    {formatPrice(row.outputUsdPerM)}
                  </td>
                  <td data-label="Context" className={styles.num}>
                    {formatContext(row.contextTokens)}
                  </td>
                  <td data-label="Est. cost per agent-day" className={[styles.num, finderStyles.cost].join(" ")}>
                    {formatPrice(cost)}
                  </td>
                  <td data-label="Tags" data-wide="true">
                    {tagsFor(row).map((tag) => (
                      <span key={tag.label} className={[finderStyles.tag, tag.free ? finderStyles.tagFree : ""].filter(Boolean).join(" ")}>
                        {tag.label}
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className={styles.note}>
        <strong className={styles.noteLead}>Free models are rate limited and can change.</strong> OpenRouter&apos;s own free-models page says its free variants (IDs ending in :free) are capped at{" "}
        {MODEL_FINDER_FACTS.freeModels.requestsPerMinute} requests a minute and {MODEL_FINDER_FACTS.freeModels.requestsPerDayBase} a day, or{" "}
        {MODEL_FINDER_FACTS.freeModels.requestsPerDayAfterCredits.toLocaleString("en-US")} a day after you buy ${MODEL_FINDER_FACTS.freeModels.creditsUsd} of credits, and that failed attempts count. An
        agent makes several requests per message. A cheap model that fails tool calls costs more in retries than it saves, so test before you commit. We rank by a stated number only, never by quality.
      </p>
      <p className={styles.note}>
        <strong className={styles.noteLead}>Where the data comes from:</strong> Hivra&apos;s managed inference list, updated {monthYear(MODEL_FINDER_FACTS.hivraCatalogUpdatedAt)}, and OpenRouter list prices
        from a copy taken {monthYear(MODEL_FINDER_FACTS.openRouterSnapshotDate)}, before any discount. Only models that accept tool calls are shown. The private tag is the provider&apos;s label from
        Hivra&apos;s list, and OpenRouter rows are not tagged. Prices change, so check the provider before you commit.
      </p>

      <div className={styles.bridge}>
        <p>
          If you would rather not run the server, Hivra runs the official Hermes Agent on a managed computer, starting at {formatPlanSize("entry")}. The plan does not include AI usage, so the model cost above is on
          top. The rows from Hivra&apos;s list are the models its managed inference offers.
        </p>
        <Link href={START_HREF} className={styles.bridgeLink}>
          Start a Hermes agent on Hivra
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
