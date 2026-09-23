'use client';

import { useState } from 'react';
import Link from 'next/link';

import { Sparkline } from '@/components/stats/Sparkline';
import type { ConversionFunnelStats } from '@/lib/conversion-funnel';
import type { ActivationCohortStats } from '@/lib/activation-cohorts';
import type { TelegramActivationStats } from '@/lib/telegram-activation';
import type {
  PlatformStats,
  PlatformStatsDay,
  UsageBreakdown,
} from '@/lib/platform-stats';

interface RangeOption {
  key: string;
  label: string;
}

interface Props {
  stats: PlatformStats;
  funnel: ConversionFunnelStats;
  activation: ActivationCohortStats;
  telegram: TelegramActivationStats;
  rangeKey: string;
  rangeLabel: string;
  rangeOptions: RangeOption[];
}

// ---------- formatting ----------

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function fmtUsdMicro(micro: number): string {
  return `$${(micro / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function fmtBytesGB(bytes: number): string {
  if (!bytes) return '0 GB';
  return `${(bytes / 1_000_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })} GB`;
}

function fmtHours(seconds: number): string {
  return `${(seconds / 3600).toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
}

// ---------- aggregation helpers ----------

function sumKey(series: PlatformStatsDay[], key: keyof PlatformStatsDay): number {
  return series.reduce((acc, d) => {
    const v = d[key];
    return acc + (typeof v === 'number' ? v : 0);
  }, 0);
}

function sumNullableKey(series: PlatformStatsDay[], key: keyof PlatformStatsDay): number | null {
  let total = 0;
  let seen = false;
  for (const d of series) {
    const v = d[key];
    if (typeof v === 'number') {
      total += v;
      seen = true;
    }
  }
  return seen ? total : null;
}

function mergeUsage(
  series: PlatformStatsDay[],
  key: 'model_distribution' | 'provider_distribution' | 'byo_model_distribution'
): Record<string, UsageBreakdown> {
  const out: Record<string, UsageBreakdown> = {};
  for (const d of series) {
    const dist = d[key];
    if (!dist) continue;
    for (const [label, v] of Object.entries(dist)) {
      if (!out[label]) out[label] = { requests: 0, tokens: 0 };
      out[label].requests += v.requests;
      out[label].tokens += v.tokens;
    }
  }
  return out;
}

function toSeries(series: PlatformStatsDay[], key: keyof PlatformStatsDay) {
  return series.map((d) => ({
    date: d.stat_date,
    count: typeof d[key] === 'number' ? (d[key] as number) : 0,
  }));
}

interface BarItem {
  label: string;
  value: number;
  hint?: string;
}

// ---------- presentational ----------

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      style={{
        border: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
        padding: '1.25rem 1.2rem',
        boxShadow: '0 6px 18px rgba(0,0,0,0.04)',
      }}
    >
      <p
        className="mono"
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          color: 'var(--text-muted)',
          marginBottom: 8,
        }}
      >
        {label}
      </p>
      <p style={{ fontSize: 28, lineHeight: 1, color: 'var(--ink-black)', fontWeight: 700 }}>{value}</p>
      {sub && (
        <p className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8 }}>
          {sub}
        </p>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      className="serif"
      style={{ fontSize: '1.6rem', color: 'var(--ink-black)', margin: '2.5rem 0 1.25rem' }}
    >
      {children}
    </h2>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid var(--etched-border)',
        background: 'var(--bg-surface)',
        padding: '1.25rem',
        boxShadow: '0 6px 18px rgba(0,0,0,0.04)',
      }}
    >
      <p
        className="mono"
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.14em',
          color: 'var(--text-muted)',
          marginBottom: '1rem',
        }}
      >
        {title}
      </p>
      {children}
    </div>
  );
}

function BarList({ items, format }: { items: BarItem[]; format: (n: number) => string }) {
  const top = [...items].sort((a, b) => b.value - a.value).slice(0, 10);
  const max = Math.max(1, ...top.map((i) => i.value));

  if (top.length === 0) {
    return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No data in range.</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
      {top.map((item) => (
        <div key={item.label}>
          <div className="flex justify-between" style={{ marginBottom: 4 }}>
            <span style={{ fontSize: 13, color: 'var(--ink-black)', fontWeight: 500, wordBreak: 'break-word' }}>
              {item.label}
            </span>
            <span className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', marginLeft: 8 }}>
              {format(item.value)}
              {item.hint ? <span style={{ color: 'var(--text-muted)' }}> · {item.hint}</span> : null}
            </span>
          </div>
          <div style={{ height: 6, background: 'rgba(0,0,0,0.05)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${(item.value / max) * 100}%`,
                height: '100%',
                background: 'var(--gold-leaf)',
                opacity: 0.7,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- interactive filters ----------

const controlStyle: React.CSSProperties = {
  padding: '7px 10px',
  border: '1px solid var(--etched-border)',
  background: 'var(--bg-surface)',
  color: 'var(--ink-black)',
  fontSize: 12,
  letterSpacing: '0.04em',
  maxWidth: 240,
};

function MetricToggle({
  metric,
  onChange,
}: {
  metric: 'tokens' | 'requests';
  onChange: (m: 'tokens' | 'requests') => void;
}) {
  return (
    <div className="flex" style={{ border: '1px solid var(--etched-border)' }}>
      {(['tokens', 'requests'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className="mono pointer-coarse:min-h-[44px]"
          style={{
            padding: '7px 12px',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            background: metric === m ? 'var(--ink-black)' : 'var(--bg-surface)',
            color: metric === m ? 'var(--vellum-bg)' : 'var(--ink-black)',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

/**
 * Pick a single model/provider and see its day-by-day usage across the window
 * (runtime-sourced, true per-day activity), plus the full ranking. All derived
 * from the already-loaded series — no extra fetch.
 */
function UsageExplorer({
  series,
  distKey,
  rangeLabel,
  noun,
}: {
  series: PlatformStatsDay[];
  distKey: 'model_distribution' | 'provider_distribution';
  rangeLabel: string;
  noun: string;
}) {
  const [metric, setMetric] = useState<'tokens' | 'requests'>('tokens');
  const [selected, setSelected] = useState<string | null>(null);

  const merged = mergeUsage(series, distKey);
  const labels = Object.keys(merged).sort((a, b) => merged[b].tokens - merged[a].tokens);
  const active = selected && merged[selected] ? selected : labels[0] ?? null;

  if (labels.length === 0) {
    return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No {noun} data in range.</p>;
  }

  const daily = active
    ? series.map((d) => ({ date: d.stat_date, count: d[distKey][active]?.[metric] ?? 0 }))
    : [];
  const windowTotal = active ? merged[active][metric] : 0;
  const rankingItems: BarItem[] = labels.map((l) => ({
    label: l,
    value: merged[l][metric],
    hint: metric === 'tokens' ? `${fmtInt(merged[l].requests)} req` : `${fmtInt(merged[l].tokens)} tok`,
  }));

  return (
    <div>
      <div className="flex flex-wrap" style={{ gap: 8, marginBottom: '0.9rem', alignItems: 'center' }}>
        <select
          aria-label={`Filter by ${noun}`}
          value={active ?? ''}
          onChange={(e) => setSelected(e.target.value)}
          className="mono pointer-coarse:min-h-[44px]"
          style={controlStyle}
        >
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <MetricToggle metric={metric} onChange={setMetric} />
      </div>

      {active && (
        <div style={{ marginBottom: '1rem' }}>
          <p className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
            {active} · {fmtInt(windowTotal)} {metric} in {rangeLabel}
          </p>
          <Sparkline
            data={daily}
            height={140}
            labels={{ peak: 'peak day', total: `${rangeLabel} total`, barLabel: `{date}: {count} ${metric}` }}
            ariaLabel={`${active} ${metric} per day`}
          />
        </div>
      )}

      <BarList items={rankingItems} format={fmtInt} />
    </div>
  );
}

/**
 * Pick a single tier / surface / backend and see its day-by-day live count
 * (point-in-time, meaningful from the first snapshot forward), plus the
 * current ranking.
 */
function CountExplorer({
  series,
  distKey,
  noun,
}: {
  series: PlatformStatsDay[];
  distKey: 'tier_distribution' | 'product_surface_distribution' | 'backend_distribution';
  noun: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  const latest = series.length ? series[series.length - 1] : null;
  const latestDist = latest?.[distKey] ?? {};
  const labelSet = new Set<string>();
  for (const d of series) for (const k of Object.keys(d[distKey] ?? {})) labelSet.add(k);
  const labels = [...labelSet].sort((a, b) => (latestDist[b] ?? 0) - (latestDist[a] ?? 0));
  const active = selected && labels.includes(selected) ? selected : labels[0] ?? null;

  if (labels.length === 0) {
    return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No {noun} data in range.</p>;
  }

  const daily = active ? series.map((d) => ({ date: d.stat_date, count: d[distKey][active] ?? 0 })) : [];
  const rankingItems: BarItem[] = labels.map((l) => ({ label: l, value: latestDist[l] ?? 0 }));

  return (
    <div>
      <div className="flex flex-wrap" style={{ gap: 8, marginBottom: '0.9rem', alignItems: 'center' }}>
        <select
          aria-label={`Filter by ${noun}`}
          value={active ?? ''}
          onChange={(e) => setSelected(e.target.value)}
          className="mono pointer-coarse:min-h-[44px]"
          style={controlStyle}
        >
          {labels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>

      {active && (
        <div style={{ marginBottom: '1rem' }}>
          <p className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
            {active} · {fmtInt(latestDist[active] ?? 0)} live now
          </p>
          <Sparkline
            data={daily}
            height={140}
            labels={{ peak: 'peak day', total: 'sum of days', barLabel: `{date}: {count}` }}
            ariaLabel={`${active} ${noun} over time`}
          />
        </div>
      )}

      <BarList items={rankingItems} format={fmtInt} />
    </div>
  );
}

// ---------- conversion funnel ----------

function fmtPct(part: number, whole: number): string {
  if (!whole) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

const cohortHeadStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  color: 'var(--text-muted)',
  textAlign: 'right',
  padding: '0 0 8px 12px',
  whiteSpace: 'nowrap',
};

const cohortCellStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  textAlign: 'right',
  padding: '6px 0 6px 12px',
  whiteSpace: 'nowrap',
  borderTop: '1px solid var(--etched-border)',
};

function CohortCell({ count, signups }: { count: number; signups: number }) {
  return (
    <td className="mono" style={cohortCellStyle}>
      {fmtInt(count)}
      <span style={{ color: 'var(--text-muted)' }}> · {fmtPct(count, signups)}</span>
    </td>
  );
}

function WeeklyCohortTable({ cohorts }: { cohorts: ConversionFunnelStats['weeklyCohorts'] }) {
  // Newest cohort first — that's the one being watched.
  const rows = [...cohorts].reverse();
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th className="mono" style={{ ...cohortHeadStyle, textAlign: 'left', padding: '0 0 8px' }}>
              Week of
            </th>
            <th className="mono" style={cohortHeadStyle}>Signups</th>
            <th className="mono" style={cohortHeadStyle}>Deployed</th>
            <th className="mono" style={cohortHeadStyle}>Active</th>
            <th className="mono" style={cohortHeadStyle}>Day 1+</th>
            <th className="mono" style={cohortHeadStyle}>Paid</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.weekStart}>
              <td className="mono" style={{ ...cohortCellStyle, textAlign: 'left', padding: '6px 0', color: 'var(--ink-black)' }}>
                {c.weekStart}
              </td>
              <td className="mono" style={{ ...cohortCellStyle, color: 'var(--ink-black)', fontWeight: 700 }}>
                {fmtInt(c.signups)}
              </td>
              <CohortCell count={c.deployed} signups={c.signups} />
              <CohortCell count={c.wentActive} signups={c.signups} />
              <CohortCell count={c.usedPastDay1} signups={c.signups} />
              <CohortCell count={c.paidNow} signups={c.signups} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FunnelSection({ funnel }: { funnel: ConversionFunnelStats }) {
  const last7 = funnel.daily.slice(-7);
  const signups7d = last7.reduce((acc, d) => acc + d.signups, 0);
  const payments7d = last7.reduce((acc, d) => acc + d.payments, 0);
  const split = funnel.upgradeSplit;
  const inferred = funnel.upgradeTimestampSource === 'period_start_inference';
  const planMixItems: BarItem[] = [
    { label: 'free', value: funnel.currentTotals.free },
    ...Object.entries(funnel.currentTotals.paidByPlan).map(([label, value]) => ({ label, value })),
  ];
  const dailyOf = (key: 'signups' | 'deploys' | 'activations' | 'payments') =>
    funnel.daily.map((d) => ({ date: d.date, count: d[key] }));

  return (
    <>
      <SectionTitle>Conversion funnel</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Signups / day (7d avg)"
          value={(signups7d / 7).toLocaleString('en-US', { maximumFractionDigits: 1 })}
          sub={`${fmtInt(signups7d)} signups in 7d`}
        />
        <KpiCard
          label="Paid conversions (7d)"
          value={fmtInt(payments7d)}
          sub={inferred ? 'inferred from period start (incl. renewals)' : 'from upgraded_at'}
        />
        <KpiCard
          label="Engaged free pool (now)"
          value={fmtInt(funnel.engagedFreePool)}
          sub="free plan · live agent · activity ≤ 7d"
        />
        <KpiCard
          label="Day-0 vs later upgrades (8w)"
          value={`${fmtInt(split.day0)} / ${fmtInt(split.later)}`}
          sub={split.unclear > 0 ? `${fmtInt(split.unclear)} unclear` : 'bought day 0 / upgraded later'}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2" style={{ marginTop: '1rem' }}>
        <Panel title="Weekly signup cohorts — last 8 weeks">
          <WeeklyCohortTable cohorts={funnel.weeklyCohorts} />
        </Panel>
        <Panel title="Current plan mix (active subscriptions)">
          <BarList items={planMixItems} format={fmtInt} />
        </Panel>
      </div>
      <div className="grid gap-4 md:grid-cols-2" style={{ marginTop: '1rem' }}>
        <Panel title="Signups per day (14d)">
          <Sparkline data={dailyOf('signups')} height={140} labels={{ peak: 'peak day', total: '14d total', barLabel: '{date}: {count} signups' }} ariaLabel="Signups per day" />
        </Panel>
        <Panel title="Deploys per day (14d)">
          <Sparkline data={dailyOf('deploys')} height={140} labels={{ peak: 'peak day', total: '14d total', barLabel: '{date}: {count} deploys' }} ariaLabel="Deploys per day" />
        </Panel>
        <Panel title="Activations per day (14d)">
          <Sparkline data={dailyOf('activations')} height={140} labels={{ peak: 'peak day', total: '14d total', barLabel: '{date}: {count} activations' }} ariaLabel="Activations per day" />
        </Panel>
        <Panel title="Paid conversions per day (14d)">
          <Sparkline data={dailyOf('payments')} height={140} labels={{ peak: 'peak day', total: '14d total', barLabel: '{date}: {count} payments' }} ariaLabel="Paid conversions per day" />
        </Panel>
      </div>
    </>
  );
}

// ---------- activation + retention cohorts ----------

const N_A = 'n/a';

/**
 * One cell in the activation table. When `known` is false (cohort predates
 * first_usage_at instrumentation) we render n/a instead of a misleading 0.
 */
function ActivationCell({
  count,
  deployed,
  known = true,
}: {
  count: number;
  deployed: number;
  known?: boolean;
}) {
  if (!known) {
    return (
      <td className="mono" style={{ ...cohortCellStyle, color: 'var(--text-muted)' }}>
        {N_A}
      </td>
    );
  }
  return (
    <td className="mono" style={cohortCellStyle}>
      {fmtInt(count)}
      <span style={{ color: 'var(--text-muted)' }}> · {fmtPct(count, deployed)}</span>
    </td>
  );
}

function ActivationCohortTable({ cohorts }: { cohorts: ActivationCohortStats['cohorts'] }) {
  // Newest cohort first — that's the one being watched.
  const rows = [...cohorts].reverse();
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th className="mono" style={{ ...cohortHeadStyle, textAlign: 'left', padding: '0 0 8px' }}>
              Deploy week
            </th>
            <th className="mono" style={cohortHeadStyle}>Deployed</th>
            <th className="mono" style={cohortHeadStyle}>Booted</th>
            <th className="mono" style={cohortHeadStyle}>Used</th>
            <th className="mono" style={cohortHeadStyle}>Paid</th>
            <th className="mono" style={cohortHeadStyle}>Retained</th>
            <th className="mono" style={cohortHeadStyle}>Digest&nbsp;email</th>
            <th className="mono" style={cohortHeadStyle}>Standing&nbsp;task</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.weekStart}>
              <td className="mono" style={{ ...cohortCellStyle, textAlign: 'left', padding: '6px 0', color: 'var(--ink-black)' }}>
                {c.weekStart}
              </td>
              <td className="mono" style={{ ...cohortCellStyle, color: 'var(--ink-black)', fontWeight: 700 }}>
                {fmtInt(c.deployed)}
              </td>
              <ActivationCell count={c.booted} deployed={c.deployed} />
              <ActivationCell count={c.used} deployed={c.deployed} known={c.usedKnown} />
              <ActivationCell count={c.paid} deployed={c.deployed} />
              <ActivationCell count={c.retained} deployed={c.deployed} />
              <ActivationCell count={c.digestEmailed} deployed={c.deployed} />
              <ActivationCell count={c.withStandingTask} deployed={c.deployed} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivationSection({ activation }: { activation: ActivationCohortStats }) {
  // Headline: across instrumented cohorts, what share of booted boxes were
  // actually used? That gap is the leak this section exists to surface.
  const instrumented = activation.cohorts.filter((c) => c.usedKnown);
  const bootedKnown = instrumented.reduce((acc, c) => acc + c.booted, 0);
  const usedKnown = instrumented.reduce((acc, c) => acc + c.used, 0);
  const deployedKnown = instrumented.reduce((acc, c) => acc + c.deployed, 0);
  const retainedAll = activation.cohorts.reduce((acc, c) => acc + c.retained, 0);
  const deployedAll = activation.cohorts.reduce((acc, c) => acc + c.deployed, 0);

  return (
    <>
      <SectionTitle>Activation &amp; retention (by deploy week)</SectionTitle>
      <p style={{ color: 'var(--text-secondary)', maxWidth: 980, lineHeight: 1.7, fontSize: '0.95rem', marginBottom: '1.25rem' }}>
        Cohorts keyed on the instance <em>deploy</em> week. <strong>Booted</strong> is the box
        reaching <code>first_active_at</code> (VM boot) — <strong>Used</strong> is a human actually
        touching it (<code>first_usage_at</code>). The booted-vs-used gap is the activation leak.
        <code>first_usage_at</code> has only been stamped since {activation.firstUsageInstrumentedFrom},
        so earlier cohorts show <em>{N_A}</em> for Used rather than a misleading 0.{' '}
        <strong>Retained</strong> = still paying past cycle 1 or still active &gt;{activation.retentionDays}d
        after deploy.
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Used / booted (instrumented)"
          value={fmtPct(usedKnown, bootedKnown)}
          sub={`${fmtInt(usedKnown)} used of ${fmtInt(bootedKnown)} booted`}
        />
        <KpiCard
          label="Used / deployed (instrumented)"
          value={fmtPct(usedKnown, deployedKnown)}
          sub={`since ${activation.firstUsageInstrumentedFrom}`}
        />
        <KpiCard
          label="Booted / deployed (instrumented)"
          value={fmtPct(bootedKnown, deployedKnown)}
          sub={`${fmtInt(bootedKnown)} booted of ${fmtInt(deployedKnown)} deployed`}
        />
        <KpiCard
          label="Retained / deployed (8w)"
          value={fmtPct(retainedAll, deployedAll)}
          sub={`still paying / active >${activation.retentionDays}d`}
        />
      </div>
      <div style={{ marginTop: '1rem' }}>
        <Panel title="Weekly deploy cohorts — booted vs used vs paid vs retained (last 8 weeks)">
          <ActivationCohortTable cohorts={activation.cohorts} />
        </Panel>
      </div>
    </>
  );
}

function TelegramActivationSection({ telegram }: { telegram: TelegramActivationStats }) {
  const pct = Math.round(telegram.rate * 100);
  const onTarget = pct >= 70;
  return (
    <>
      <SectionTitle>Telegram activation</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={`Deployers who connected (${telegram.windowDays}d)`}
          value={`${pct}%`}
          sub={`${fmtInt(telegram.connectedDeployers)} / ${fmtInt(telegram.deployers)} deployers · target 70–90%${onTarget ? ' ✓' : ''}`}
        />
        <KpiCard
          label={`Connections made (${telegram.windowDays}d)`}
          value={fmtInt(telegram.connectionsInWindow.total)}
          sub={`${fmtInt(telegram.connectionsInWindow.hermes)} hermes · ${fmtInt(telegram.connectionsInWindow.hivra)} hivra`}
        />
      </div>
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="action-button"
      style={{ padding: '10px 20px', fontSize: 10, letterSpacing: '0.1em' }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied' : 'Copy Headline Numbers'}
    </button>
  );
}

// ---------- main ----------

export function AdminInsightsContent({ stats, funnel, activation, telegram, rangeKey, rangeLabel, rangeOptions }: Props) {
  const { series, latest, liveTotals } = stats;

  const tokensWindow = sumKey(series, 'tokens_total');
  const tokensInWindow = sumKey(series, 'tokens_in');
  const tokensOutWindow = sumKey(series, 'tokens_out');
  const messagesWindow = sumKey(series, 'messages');
  const conversationsWindow = sumKey(series, 'conversations_started');
  const newAgentsWindow = sumKey(series, 'new_agents');
  const newSignupsWindow = sumKey(series, 'new_signups');
  const costWindow = sumKey(series, 'inference_cost_micro_usd');
  const requestsWindow = sumKey(series, 'inference_requests');
  const chatSecondsWindow = sumKey(series, 'chat_seconds');
  const sessionsWindow = sumNullableKey(series, 'agent_sessions');
  const apiCallsWindow = sumNullableKey(series, 'api_calls');
  const toolCallsWindow = sumNullableKey(series, 'tool_calls');

  // Models/providers are runtime-sourced (the agent state.db, what the WebUI
  // analytics read). The interactive explorers below derive their own per-day
  // series + ranking from `series`, so no pre-aggregation is needed here.
  const skillItems: BarItem[] = Object.entries(latest?.skills_distribution ?? {}).map(
    ([label, value]) => ({ label, value })
  );

  const productItems: BarItem[] = Object.entries(latest?.product_surface_distribution ?? {}).map(
    ([label, value]) => ({ label, value })
  );
  const backendItems: BarItem[] = Object.entries(latest?.backend_distribution ?? {}).map(
    ([label, value]) => ({ label, value })
  );
  const countryItems: BarItem[] = Object.entries(latest?.country_distribution ?? {}).map(
    ([label, value]) => ({ label, value })
  );
  const copyText = [
    'Hivra — platform numbers',
    `Window: ${rangeLabel} (generated ${new Date(stats.generatedAt).toISOString()})`,
    '',
    `Agents deployed (all-time): ${fmtInt(liveTotals.total_agents_deployed)}`,
    `Active agents (now): ${fmtInt(liveTotals.active_agents)}`,
    `Total users: ${fmtInt(liveTotals.total_users)}`,
    latest ? `Paid users: ${fmtInt(latest.paid_users)}` : null,
    latest ? `DAU / WAU / MAU: ${fmtInt(latest.active_users)} / ${fmtInt(latest.wau)} / ${fmtInt(latest.mau)}` : null,
    '',
    `New agents (window): ${fmtInt(newAgentsWindow)}`,
    `New signups (window): ${fmtInt(newSignupsWindow)}`,
    `Tokens processed (window): ${fmtInt(tokensWindow)} (in ${fmtInt(tokensInWindow)} / out ${fmtInt(tokensOutWindow)})`,
    `Inference requests (window): ${fmtInt(requestsWindow)}`,
    `Inference spend (window): ${fmtUsdMicro(costWindow)}`,
    `Messages (window): ${fmtInt(messagesWindow)}`,
    `Conversations (window): ${fmtInt(conversationsWindow)}`,
    `Chat time (window): ${fmtHours(chatSecondsWindow)}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const hasData = series.length > 0;

  return (
    <>
      <div
        className="flex flex-col md:flex-row md:justify-between"
        style={{ gap: '1.5rem', alignItems: 'flex-start', marginBottom: '2.5rem' }}
      >
        <div style={{ maxWidth: 900 }}>
          <p
            className="mono"
            style={{
              fontSize: 12,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              opacity: 0.5,
              color: 'var(--ink-black)',
              fontWeight: 700,
              marginTop: '1rem',
              marginBottom: 0,
            }}
          >
            Internal — Admin Only
          </p>
          <h1
            className="serif"
            style={{
              fontSize: 'clamp(2.5rem, 8vw, 3.5rem)',
              fontWeight: 400,
              lineHeight: 1,
              color: 'var(--ink-black)',
              margin: 0,
              marginBottom: '0.5rem',
            }}
          >
            Platform insights.
          </h1>
          <p style={{ color: 'var(--text-secondary)', maxWidth: 980, lineHeight: 1.8, fontSize: '1.05rem', marginTop: '1rem' }}>
            Aggregate growth, usage, and economics across the whole fleet — for trend tracking and
            partner conversations. Counts and distributions only; no user identities or content.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <CopyButton text={copyText} />
          <Link
            href={`/dashboard/insights?range=${rangeKey}`}
            className="action-button"
            style={{ padding: '10px 20px', fontSize: 10, letterSpacing: '0.1em', textDecoration: 'none' }}
          >
            Refresh
          </Link>
        </div>
      </div>

      {/* Range toggle */}
      <div className="flex flex-wrap gap-2" style={{ marginBottom: '1.5rem' }}>
        {rangeOptions.map((opt) => {
          const isActive = opt.key === rangeKey;
          return (
            <Link
              key={opt.key}
              href={`/dashboard/insights?range=${opt.key}`}
              style={{
                padding: '8px 14px',
                border: '1px solid var(--etched-border)',
                background: isActive ? 'var(--ink-black)' : 'var(--bg-surface)',
                color: isActive ? 'var(--vellum-bg)' : 'var(--ink-black)',
                textDecoration: 'none',
                fontSize: 12,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              {opt.label}
            </Link>
          );
        })}
      </div>

      {!hasData && (
        <div
          style={{
            border: '1px solid rgba(245,158,11,0.45)',
            background: 'rgba(245,158,11,0.08)',
            padding: '0.75rem 1rem',
            marginBottom: '1.5rem',
            fontSize: 13,
            color: '#92400e',
          }}
        >
          No daily snapshots yet. The rollup cron writes one row per day at 23:50 UTC — headline
          totals below are live, the trends fill in as snapshots accrue.
        </div>
      )}

      {/* Headline KPIs */}
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-4">
        <KpiCard label="Agents Deployed (all-time)" value={fmtInt(liveTotals.total_agents_deployed)} />
        <KpiCard label="Active Agents (now)" value={fmtInt(liveTotals.active_agents)} sub={`${fmtInt(liveTotals.live_instances)} live instances`} />
        <KpiCard label="Total Users" value={fmtInt(liveTotals.total_users)} />
        <KpiCard label="Paid Users" value={fmtInt(latest?.paid_users ?? 0)} />
        <KpiCard label={`Tokens (${rangeLabel})`} value={fmtInt(tokensWindow)} sub={`in ${fmtInt(tokensInWindow)} · out ${fmtInt(tokensOutWindow)}`} />
        <KpiCard label={`Inference Spend (${rangeLabel})`} value={fmtUsdMicro(costWindow)} sub={`${fmtInt(requestsWindow)} requests`} />
        <KpiCard label={`Messages (${rangeLabel})`} value={fmtInt(messagesWindow)} sub={`${fmtInt(conversationsWindow)} conversations`} />
        <KpiCard label="DAU · WAU · MAU" value={`${fmtInt(latest?.active_users ?? 0)} · ${fmtInt(latest?.wau ?? 0)} · ${fmtInt(latest?.mau ?? 0)}`} />
      </div>

      {/* Growth */}
      <SectionTitle>Growth &amp; adoption</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title={`New agents per day · ${fmtInt(newAgentsWindow)} in ${rangeLabel}`}>
          <Sparkline data={toSeries(series, 'new_agents')} labels={{ peak: 'peak day', total: `${rangeLabel} total`, barLabel: '{date}: {count} agents' }} ariaLabel="New agents per day" />
        </Panel>
        <Panel title={`New signups per day · ${fmtInt(newSignupsWindow)} in ${rangeLabel}`}>
          <Sparkline data={toSeries(series, 'new_signups')} labels={{ peak: 'peak day', total: `${rangeLabel} total`, barLabel: '{date}: {count} signups' }} ariaLabel="New signups per day" />
        </Panel>
        <Panel title="Signups by country (cumulative)">
          <BarList items={countryItems} format={fmtInt} />
        </Panel>
        <Panel title="Daily active users">
          <Sparkline data={toSeries(series, 'active_users')} labels={{ peak: 'peak day', total: 'sum (user-days)', barLabel: '{date}: {count} active' }} ariaLabel="Daily active users" />
        </Panel>
      </div>

      {/* Conversion funnel */}
      <FunnelSection funnel={funnel} />

      {/* Activation + retention cohorts */}
      <ActivationSection activation={activation} />

      <TelegramActivationSection telegram={telegram} />

      {/* Usage & engagement */}
      <SectionTitle>Usage &amp; engagement</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title={`Tokens processed per day · ${fmtInt(tokensWindow)} in ${rangeLabel}`}>
          <Sparkline data={toSeries(series, 'tokens_total')} labels={{ peak: 'peak day', total: `${rangeLabel} total`, barLabel: '{date}: {count} tokens' }} ariaLabel="Tokens per day" />
        </Panel>
        <Panel title={`Messages per day · ${fmtInt(messagesWindow)} in ${rangeLabel}`}>
          <Sparkline data={toSeries(series, 'messages')} labels={{ peak: 'peak day', total: `${rangeLabel} total`, barLabel: '{date}: {count} messages' }} ariaLabel="Messages per day" />
        </Panel>
      </div>
      <div className="grid gap-4 md:grid-cols-3" style={{ marginTop: '1rem' }}>
        <KpiCard label={`Agent sessions (${rangeLabel})`} value={sessionsWindow === null ? '—' : fmtInt(sessionsWindow)} sub={sessionsWindow === null ? 'awaiting runtime harvest' : undefined} />
        <KpiCard label={`API calls (${rangeLabel})`} value={apiCallsWindow === null ? '—' : fmtInt(apiCallsWindow)} sub={apiCallsWindow === null ? 'awaiting runtime harvest' : undefined} />
        <KpiCard label={`Tool calls (${rangeLabel})`} value={toolCallsWindow === null ? '—' : fmtInt(toolCallsWindow)} sub={toolCallsWindow === null ? 'awaiting runtime harvest' : undefined} />
      </div>

      {/* Models & providers */}
      <SectionTitle>Models &amp; providers</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title={`Models (${rangeLabel}) — filter & trend`}>
          <UsageExplorer series={series} distKey="model_distribution" noun="model" rangeLabel={rangeLabel} />
        </Panel>
        <Panel title={`Providers (${rangeLabel}) — filter & trend`}>
          <UsageExplorer series={series} distKey="provider_distribution" noun="provider" rangeLabel={rangeLabel} />
        </Panel>
        {skillItems.length > 0 && (
          <Panel title="Skills used (agents, latest)">
            <BarList items={skillItems} format={fmtInt} />
          </Panel>
        )}
      </div>

      {/* Tiers, product, infra */}
      <SectionTitle>Tiers, product &amp; fleet</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Live agents by tier — filter & trend">
          <CountExplorer series={series} distKey="tier_distribution" noun="tier" />
        </Panel>
        <Panel title="Live agents by product surface">
          <BarList items={productItems} format={fmtInt} />
        </Panel>
        <Panel title="Live agents by backend">
          <BarList items={backendItems} format={fmtInt} />
        </Panel>
        <Panel title="Fleet footprint (now)">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            <div className="flex justify-between">
              <span style={{ fontSize: 13, color: 'var(--ink-black)' }}>RAM in use</span>
              <span className="mono" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{fmtBytesGB(latest?.fleet_ram_bytes ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ fontSize: 13, color: 'var(--ink-black)' }}>Disk in use</span>
              <span className="mono" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{fmtBytesGB(latest?.fleet_disk_bytes ?? 0)}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ fontSize: 13, color: 'var(--ink-black)' }}>Chat time ({rangeLabel})</span>
              <span className="mono" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{fmtHours(chatSecondsWindow)}</span>
            </div>
          </div>
        </Panel>
      </div>

      <p className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: '2.5rem', letterSpacing: '0.1em' }}>
        Generated {new Date(stats.generatedAt).toISOString()} · point-in-time trends (active agents,
        tiers, fleet) accrue from the first daily snapshot forward.
      </p>
    </>
  );
}
