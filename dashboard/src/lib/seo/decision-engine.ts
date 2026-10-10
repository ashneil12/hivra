// src/lib/seo/decision-engine.ts
//
// SEO decision engine — PURE functions, no I/O.
//
// Takes typed row arrays (mirroring the seo_gsc_daily / seo_targets /
// seo_page_inventory Supabase tables) and produces a deterministic,
// ranked list of concrete actions: which pages to optimize, which
// content is decaying, which metas underperform their position, which
// target keywords still have no live page, and which pages are broken.
//
// Everything here must stay deterministic: same inputs → same output,
// byte for byte. The analyst cron and its tests both depend on that.

/** Row shape of the `seo_gsc_daily` table (one row per date+page+query). */
export interface SeoGscDailyRow {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  site: string;
  page: string;
  query: string;
  clicks: number;
  impressions: number;
  /** Click-through rate as a fraction (0.042 = 4.2%). */
  ctr: number;
  /** Average position for this date+page+query (1 = top). */
  position: number;
}

/** Row shape of the `seo_targets` table (keyword backlog). */
export interface SeoTargetRow {
  keyword: string;
  cluster: string;
  intent: string;
  target_url: string | null;
  status: string;
  /** 0-100, higher = more important. */
  priority: number;
}

/** Row shape of the `seo_page_inventory` table (crawl results). */
export interface SeoPageInventoryRow {
  url: string;
  /** Last observed HTTP status; null = never crawled successfully. */
  last_status: number | null;
  canonical_ok: boolean;
}

export type SeoActionType =
  | "optimize_page"
  | "refresh_content"
  | "rewrite_meta"
  | "create_content"
  | "fix_page";

/**
 * Title of a live page, used to spot backlog targets that an existing
 * page already serves. Paths are site-relative ("/agents/aeon").
 */
export interface SeoPageTitleRow {
  path: string;
  title: string;
}

export interface RankedAction {
  action_type: SeoActionType;
  /** Page URL, or keyword for create_content actions. */
  target: string;
  score: number;
  rationale: string;
  /**
   * Set on create_content actions when a live page looks like it already
   * serves this keyword. Advisory: confirm before writing, and back-link
   * the target row rather than publishing a competing page.
   */
  possible_existing_url?: string;
}

export interface DecisionEngineInputs {
  gscDaily: SeoGscDailyRow[];
  targets: SeoTargetRow[];
  pageInventory: SeoPageInventoryRow[];
  /** Titles of known pages; enables phantom-gap warnings on the backlog. */
  livePageTitles?: SeoPageTitleRow[];
}

export interface SeoPriorActionRow {
  action_type: string;
  target: string;
  status: string;
}

/**
 * Expected organic CTR by average position, as a fraction. Index 0 is
 * position 1. A blend of published position-CTR studies, deliberately
 * conservative in the tail; only relative shape matters for scoring.
 */
export const EXPECTED_CTR_BY_POSITION: readonly number[] = [
  0.28, // 1
  0.15, // 2
  0.11, // 3
  0.08, // 4
  0.063, // 5
  0.049, // 6
  0.039, // 7
  0.033, // 8
  0.028, // 9
  0.024, // 10
  0.02, // 11
  0.017, // 12
  0.015, // 13
  0.013, // 14
  0.012, // 15
  0.011, // 16
  0.01, // 17
  0.009, // 18
  0.008, // 19
  0.007, // 20
];

/** Quick wins: only queries whose window-average position sits in this band. */
export const QUICK_WIN_POSITION_MIN = 5;
export const QUICK_WIN_POSITION_MAX = 20;
export const QUICK_WIN_MIN_IMPRESSIONS = 50;

/** Content decay: trailing 7d clicks vs prior 7d, with a floor on baseline. */
export const DECAY_DROP_THRESHOLD = 0.3;
export const DECAY_MIN_BASELINE_CLICKS = 10;

/** CTR anomalies: top-5 positions whose CTR is under half the curve. */
export const CTR_ANOMALY_MAX_POSITION = 5;
export const CTR_ANOMALY_MIN_IMPRESSIONS = 100;

/** Inventory regressions rank near the top of any brief. */
const FIX_PAGE_STATUS_SCORE = 950;
const FIX_PAGE_CANONICAL_SCORE = 900;

/**
 * Phantom-gap detection. A backlog target with no target_url is flagged
 * when this share of its significant terms already appears in a live
 * page's path and title. Deliberately strict: a false positive damps a
 * real gap, so the bar is "nearly every term is already covered".
 * Validated against the live backlog (2026-07-18) — at 0.75 the only
 * flag across 10 open targets was "aeon agent hosting" -> /agents/aeon,
 * the known phantom, with no false positives.
 */
export const DUPLICATE_COVERAGE_THRESHOLD = 0.75;
export const DUPLICATE_MIN_MATCHED_TERMS = 2;
/** Flagged targets are damped, never dropped, so genuine gaps outrank them. */
export const DUPLICATE_SCORE_FACTOR = 0.35;

/**
 * Terms carrying no topical signal. Keeping this list short and generic
 * matters: every word removed here raises the effective coverage of the
 * words that remain.
 */
const DUPLICATE_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "at", "be", "by", "do", "doe", "for", "from", "how",
  "i", "in", "is", "it", "my", "of", "on", "or", "the", "to", "v", "vs", "what",
  "when", "which", "why", "with", "you", "your",
]);

const MAX_ACTIONS = 50;

/**
 * Expected CTR at a (possibly fractional) position. Positions below 1
 * clamp to position 1; positions past the end of the curve clamp to the
 * last entry. Fractional positions round to the nearest whole position,
 * which is plenty of resolution for scoring.
 */
export function expectedCtrAtPosition(position: number): number {
  const idx = Math.min(
    EXPECTED_CTR_BY_POSITION.length - 1,
    Math.max(0, Math.round(position) - 1),
  );
  return EXPECTED_CTR_BY_POSITION[idx];
}

/**
 * How much CTR a query stands to gain if the page climbs into the top 3.
 * Always >= 0. This is the "size of the prize" multiplier for quick wins.
 */
export function ctrUpliftPotential(position: number): number {
  const target = EXPECTED_CTR_BY_POSITION[2]; // position 3
  return Math.max(0, target - expectedCtrAtPosition(position));
}

interface PageQueryAggregate {
  page: string;
  query: string;
  impressions: number;
  clicks: number;
  /** Impression-weighted average position over the window. */
  avgPosition: number;
}

function aggregateByPageQuery(rows: SeoGscDailyRow[]): PageQueryAggregate[] {
  const byKey = new Map<
    string,
    { page: string; query: string; impressions: number; clicks: number; positionWeight: number }
  >();
  for (const row of rows) {
    const key = `${row.page}\u0000${row.query}`;
    let agg = byKey.get(key);
    if (!agg) {
      agg = { page: row.page, query: row.query, impressions: 0, clicks: 0, positionWeight: 0 };
      byKey.set(key, agg);
    }
    // Weight position by impressions so a 1-impression fluke day can't
    // drag a query's window average around. Zero-impression rows carry
    // no ranking signal and contribute nothing; an aggregate with zero
    // total impressions gets avgPosition 0, which every consumer below
    // filters out via its impressions threshold.
    agg.impressions += row.impressions;
    agg.clicks += row.clicks;
    agg.positionWeight += row.position * row.impressions;
  }
  const out: PageQueryAggregate[] = [];
  for (const agg of byKey.values()) {
    out.push({
      page: agg.page,
      query: agg.query,
      impressions: agg.impressions,
      clicks: agg.clicks,
      avgPosition: agg.impressions > 0 ? agg.positionWeight / agg.impressions : 0,
    });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Quick wins: queries already ranking on page 1-2 (avg position 5-20)
 * with real impression volume, grouped by page. Score is the summed
 * impressions * CTR-uplift-potential across the page's qualifying
 * queries — i.e. clicks recoverable by pushing those queries into the
 * top 3.
 */
export function quickWins(gscDaily: SeoGscDailyRow[]): RankedAction[] {
  const qualifying = aggregateByPageQuery(gscDaily).filter(
    (agg) =>
      agg.impressions >= QUICK_WIN_MIN_IMPRESSIONS &&
      agg.avgPosition >= QUICK_WIN_POSITION_MIN &&
      agg.avgPosition <= QUICK_WIN_POSITION_MAX,
  );

  const byPage = new Map<string, { score: number; queries: PageQueryAggregate[] }>();
  for (const agg of qualifying) {
    let entry = byPage.get(agg.page);
    if (!entry) {
      entry = { score: 0, queries: [] };
      byPage.set(agg.page, entry);
    }
    entry.score += agg.impressions * ctrUpliftPotential(agg.avgPosition);
    entry.queries.push(agg);
  }

  const actions: RankedAction[] = [];
  for (const [page, entry] of byPage.entries()) {
    // Deterministic "best query" for the rationale: highest impressions,
    // then alphabetical.
    const best = [...entry.queries].sort(
      (a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query),
    )[0];
    actions.push({
      action_type: "optimize_page",
      target: page,
      score: round2(entry.score),
      rationale:
        `${entry.queries.length} quick-win ${entry.queries.length === 1 ? "query" : "queries"} at position 5-20; ` +
        `top: "${best.query}" (avg pos ${round2(best.avgPosition)}, ${best.impressions} impressions)`,
    });
  }
  return actions;
}

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Content decay: pages whose trailing-7-day clicks dropped >= 30% vs the
 * prior 7 days, with at least 10 clicks in the prior week so noise on
 * tiny pages can't fire it. Windows anchor on the newest date present in
 * the data (GSC lags ~2 days; "today" would silently shrink the window).
 */
export function contentDecay(gscDaily: SeoGscDailyRow[]): RankedAction[] {
  if (gscDaily.length === 0) return [];

  let maxDate = gscDaily[0].date;
  for (const row of gscDaily) {
    if (row.date > maxDate) maxDate = row.date;
  }
  const trailingStart = addDaysIso(maxDate, -6); // trailing 7d inclusive
  const priorStart = addDaysIso(maxDate, -13); // prior 7d inclusive

  const byPage = new Map<string, { trailing: number; prior: number }>();
  for (const row of gscDaily) {
    if (row.date < priorStart || row.date > maxDate) continue;
    let entry = byPage.get(row.page);
    if (!entry) {
      entry = { trailing: 0, prior: 0 };
      byPage.set(row.page, entry);
    }
    if (row.date >= trailingStart) {
      entry.trailing += row.clicks;
    } else {
      entry.prior += row.clicks;
    }
  }

  const actions: RankedAction[] = [];
  for (const [page, entry] of byPage.entries()) {
    if (entry.prior < DECAY_MIN_BASELINE_CLICKS) continue;
    const drop = (entry.prior - entry.trailing) / entry.prior;
    if (drop < DECAY_DROP_THRESHOLD) continue;
    const lostClicks = entry.prior - entry.trailing;
    actions.push({
      action_type: "refresh_content",
      target: page,
      // Lost weekly clicks, weighted so a real decay outranks a modest
      // quick win but stays under broken-page fixes.
      score: round2(lostClicks * 10 * drop),
      rationale:
        `Clicks down ${Math.round(drop * 100)}% week over week ` +
        `(${entry.prior} → ${entry.trailing})`,
    });
  }
  return actions;
}

/**
 * CTR anomalies: page+query combos ranking in the top 5 with meaningful
 * impressions whose CTR is under HALF what the curve expects at that
 * position. That gap is almost always a title/meta problem, so the
 * action is rewrite_meta on the page.
 */
export function ctrAnomalies(gscDaily: SeoGscDailyRow[]): RankedAction[] {
  const actions: RankedAction[] = [];
  for (const agg of aggregateByPageQuery(gscDaily)) {
    if (agg.impressions < CTR_ANOMALY_MIN_IMPRESSIONS) continue;
    if (agg.avgPosition > CTR_ANOMALY_MAX_POSITION || agg.avgPosition < 1) continue;
    const expected = expectedCtrAtPosition(agg.avgPosition);
    const actualCtr = agg.impressions > 0 ? agg.clicks / agg.impressions : 0;
    if (actualCtr >= expected / 2) continue;
    actions.push({
      action_type: "rewrite_meta",
      target: agg.page,
      // Clicks left on the table for this query at its current position.
      score: round2(agg.impressions * (expected - actualCtr)),
      rationale:
        `"${agg.query}" ranks pos ${round2(agg.avgPosition)} but CTR is ` +
        `${round2(actualCtr * 100)}% vs ~${round2(expected * 100)}% expected ` +
        `(${agg.impressions} impressions)`,
    });
  }
  return actions;
}

/**
 * Crude singular stem, enough to make "agents"/"agent" and
 * "running"/"run" match. Deliberately not a real stemmer: this only
 * feeds an advisory warning, so predictability beats linguistic
 * accuracy.
 */
function stemTerm(term: string): string {
  if (term.length > 4 && term.endsWith("ing")) {
    const stem = term.slice(0, -3);
    // "running" -> "runn" -> "run", so it matches a title saying "run".
    const doubled = stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2];
    return doubled ? stem.slice(0, -1) : stem;
  }
  // Plurals only ("boxes" -> "box"). Silent-e forms are left alone, so
  // "closing" and "close" do NOT meet; that is a known miss, and the
  // reason the threshold is advisory rather than authoritative.
  if (term.length > 3 && term.endsWith("es")) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s")) return term.slice(0, -1);
  return term;
}

/** Lowercase, split on non-alphanumerics, stem, drop stopwords and single chars. */
export function significantTerms(text: string): string[] {
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stemTerm)
    .filter((t) => t.length > 1 && !DUPLICATE_STOPWORDS.has(t));
  return [...new Set(terms)];
}

interface DuplicateCandidate {
  path: string;
  /** Share of the keyword's significant terms the page already covers, 0-1. */
  coverage: number;
}

/**
 * Best live page that looks like it already serves `keyword`, or null.
 * Scored on how much of the keyword the page's path plus title covers,
 * so "aeon agent hosting" matches /agents/aeon titled "Aeon Agent
 * Hosting: Runs on Your GitHub" while "run claude code on a raspberry
 * pi" does not match /agents/claude-code.
 *
 * Term overlap only: it cannot see that "keep codex running after
 * closing terminal" is already answered by a page titled "How to run
 * Codex 24/7 in the cloud". Semantic duplicates still need a human
 * read of the backlog.
 */
export function findDuplicateCandidate(
  keyword: string,
  livePageTitles: SeoPageTitleRow[],
): DuplicateCandidate | null {
  const keywordTerms = significantTerms(keyword);
  if (keywordTerms.length === 0) return null;

  let best: DuplicateCandidate | null = null;
  for (const page of livePageTitles) {
    const pageTerms = new Set(significantTerms(`${page.path} ${page.title}`));
    const matched = keywordTerms.filter((term) => pageTerms.has(term)).length;
    if (matched < DUPLICATE_MIN_MATCHED_TERMS) continue;
    const coverage = matched / keywordTerms.length;
    if (coverage < DUPLICATE_COVERAGE_THRESHOLD) continue;
    // Ties break on path so the same inputs always name the same page.
    if (!best || coverage > best.coverage || (coverage === best.coverage && page.path < best.path)) {
      best = { path: page.path, coverage };
    }
  }
  return best;
}

/**
 * Backlog fill: open keyword targets with no live page behind them. A
 * target counts as "live" only when its target_url exists in the page
 * inventory with a healthy status — a pre-filled URL for a page that
 * does not exist yet still needs the content created.
 *
 * A target whose target_url was never filled in is the phantom-gap case:
 * the page may already exist and simply never got back-linked to its
 * row. When `livePageTitles` is supplied, those targets are matched
 * against live page paths and titles. A confident match is never
 * dropped (that would bury a real gap) — it is annotated and damped so
 * genuine gaps outrank it, and a human confirms before writing.
 */
export function backlogFill(
  targets: SeoTargetRow[],
  pageInventory: SeoPageInventoryRow[],
  livePageTitles: SeoPageTitleRow[] = [],
): RankedAction[] {
  // Inventory rows store absolute URLs (https://hivra.cloud/agents/foo) while
  // seo_targets.target_url stores site-relative paths (/agents/foo) — compare
  // by pathname so a live page is recognized as live.
  const toPath = (u: string): string => {
    try {
      const path = new URL(u, "https://hivra.cloud").pathname;
      return path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;
    } catch {
      return u;
    }
  };
  const livePaths = new Set(
    pageInventory
      .filter((row) => row.last_status === 200 || row.last_status === 301)
      .map((row) => toPath(row.url)),
  );

  // Include a titled page unless the inventory positively says it is broken.
  //
  // Gating on presence in the inventory instead would make this blind for up
  // to a week: the inventory sweep runs Mondays, and a page is most likely to
  // strand an unlinked target in the days right after it ships. The title
  // index is compiled from the deployed bundle's own constants, so a page in
  // it is a static route that exists; that is fresher evidence than the crawl.
  const brokenPaths = new Set(
    pageInventory
      .filter((row) => row.last_status !== 200 && row.last_status !== 301)
      .map((row) => toPath(row.url)),
  );
  const liveTitles = livePageTitles.filter((row) => !brokenPaths.has(toPath(row.path)));

  const actions: RankedAction[] = [];
  for (const target of targets) {
    if (target.status !== "open") continue;
    if (target.target_url && livePaths.has(toPath(target.target_url))) continue;

    // Priority is 0-100; scale so a priority-90 keyword ranks alongside
    // mid-size quick wins but below decays and broken pages.
    const baseScore = target.priority * 2;
    const duplicate = target.target_url ? null : findDuplicateCandidate(target.keyword, liveTitles);
    const rationale =
      `Open target in "${target.cluster}" cluster (priority ${target.priority})` +
      (target.target_url ? `; planned URL ${target.target_url} is not live` : "; no URL planned");

    actions.push({
      action_type: "create_content",
      target: target.keyword,
      score: round2(duplicate ? baseScore * DUPLICATE_SCORE_FACTOR : baseScore),
      rationale: duplicate
        ? `${rationale}. WARNING: ${duplicate.path} may already serve this keyword ` +
          `(${Math.round(duplicate.coverage * 100)}% term overlap). Confirm it does not before ` +
          `writing, then back-link the target row instead. Writing a second page here risks ` +
          `cannibalizing the one that already ranks`
        : rationale,
      ...(duplicate ? { possible_existing_url: duplicate.path } : {}),
    });
  }
  return actions;
}

/**
 * Inventory regressions: pages that no longer return 200/301, or whose
 * canonical is wrong. These bleed existing equity, so they score near
 * the top of every brief.
 */
export function inventoryRegressions(pageInventory: SeoPageInventoryRow[]): RankedAction[] {
  const actions: RankedAction[] = [];
  for (const row of pageInventory) {
    const badStatus = row.last_status !== 200 && row.last_status !== 301;
    if (!badStatus && row.canonical_ok) continue;
    const problems: string[] = [];
    if (badStatus) {
      problems.push(`status ${row.last_status ?? "unknown"}`);
    }
    if (!row.canonical_ok) {
      problems.push("canonical mismatch");
    }
    actions.push({
      action_type: "fix_page",
      target: row.url,
      score: badStatus ? FIX_PAGE_STATUS_SCORE : FIX_PAGE_CANONICAL_SCORE,
      rationale: `Inventory regression: ${problems.join(", ")}`,
    });
  }
  return actions;
}

/**
 * Run every scorer, merge, sort by score descending with a stable
 * tiebreak (target, then action_type), and cap at 50 actions.
 */
export function rankActions(inputs: DecisionEngineInputs): RankedAction[] {
  const actions: RankedAction[] = [
    ...inventoryRegressions(inputs.pageInventory),
    ...contentDecay(inputs.gscDaily),
    ...quickWins(inputs.gscDaily),
    ...ctrAnomalies(inputs.gscDaily),
    ...backlogFill(inputs.targets, inputs.pageInventory, inputs.livePageTitles ?? []),
  ];
  actions.sort(
    (a, b) =>
      b.score - a.score ||
      a.target.localeCompare(b.target) ||
      a.action_type.localeCompare(b.action_type),
  );
  return actions.slice(0, MAX_ACTIONS);
}

const ACTIVE_ACTION_STATUSES = new Set(["proposed", "pr_open", "merged", "live"]);

/**
 * Do not queue work that is already moving through the PR or publication
 * lifecycle. The action ledger is deliberately applied after scoring so the
 * ranking functions stay pure with respect to current GSC and inventory data.
 */
export function suppressActiveActions(
  rankedActions: RankedAction[],
  priorActions: SeoPriorActionRow[],
): RankedAction[] {
  const active = new Set(
    priorActions
      .filter((action) => ACTIVE_ACTION_STATUSES.has(action.status))
      .map((action) => `${action.action_type}\u0000${action.target}`),
  );

  return rankedActions.filter(
    (action) => !active.has(`${action.action_type}\u0000${action.target}`),
  );
}

export interface WowMetric {
  current: number;
  previous: number;
  /** Percent change, rounded to 1dp; null when the previous week is 0. */
  change_pct: number | null;
}

export interface WowMetrics {
  clicks_wow: WowMetric;
  impressions_wow: WowMetric;
  nonbrand_impressions_wow: WowMetric;
}

function isBrandQuery(query: string): boolean {
  const q = query.toLowerCase();
  return q.includes("hivra") || q.includes("hermes");
}

function wowMetric(current: number, previous: number): WowMetric {
  return {
    current,
    previous,
    change_pct:
      previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null,
  };
}

/**
 * Week-over-week totals for the analyst brief: trailing 7 days vs the
 * prior 7, anchored on the newest date in the data. Nonbrand excludes
 * any query containing "hivra" or "hermes" (case-insensitive).
 */
export function computeWowMetrics(gscDaily: SeoGscDailyRow[]): WowMetrics {
  if (gscDaily.length === 0) {
    const zero = wowMetric(0, 0);
    return { clicks_wow: zero, impressions_wow: zero, nonbrand_impressions_wow: zero };
  }

  let maxDate = gscDaily[0].date;
  for (const row of gscDaily) {
    if (row.date > maxDate) maxDate = row.date;
  }
  const trailingStart = addDaysIso(maxDate, -6);
  const priorStart = addDaysIso(maxDate, -13);

  let clicksCur = 0;
  let clicksPrev = 0;
  let imprCur = 0;
  let imprPrev = 0;
  let nbImprCur = 0;
  let nbImprPrev = 0;

  for (const row of gscDaily) {
    if (row.date < priorStart || row.date > maxDate) continue;
    const trailing = row.date >= trailingStart;
    if (trailing) {
      clicksCur += row.clicks;
      imprCur += row.impressions;
      if (!isBrandQuery(row.query)) nbImprCur += row.impressions;
    } else {
      clicksPrev += row.clicks;
      imprPrev += row.impressions;
      if (!isBrandQuery(row.query)) nbImprPrev += row.impressions;
    }
  }

  return {
    clicks_wow: wowMetric(clicksCur, clicksPrev),
    impressions_wow: wowMetric(imprCur, imprPrev),
    nonbrand_impressions_wow: wowMetric(nbImprCur, nbImprPrev),
  };
}
