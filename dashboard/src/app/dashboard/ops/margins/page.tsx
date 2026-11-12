import Link from 'next/link';
import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import type { CSSProperties } from 'react';

import { DashboardPageShell } from '@/components/layout/DashboardPageShell';
import {
  loadUsageShareReport,
  parseUsageShareInputs,
  parseUsageShareMonth,
  type UsageShareReport,
} from '@/lib/billing/usage-share-report';
import { getAgent } from '@/lib/hivra/agent-catalog';
import { isOpsAdminUser, verifiedPrimaryEmailOf } from '@/lib/ops-access';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const card: CSSProperties = {
  background: 'var(--hg-glass)',
  border: '1px solid var(--hg-stroke)',
  borderRadius: 'var(--hg-radius-lg)',
  boxShadow: 'var(--hg-glass-edge), var(--hg-shadow-sm)',
  backdropFilter: 'blur(var(--hg-glass-blur)) saturate(1.3)',
  WebkitBackdropFilter: 'blur(var(--hg-glass-blur)) saturate(1.3)',
};
const field: CSSProperties = {
  height: 36,
  padding: '0 10px',
  border: '1px solid var(--hg-stroke-strong)',
  borderRadius: 'var(--hg-radius-md)',
  background: 'var(--hg-fill-1)',
  color: 'var(--hg-text)',
  font: 'inherit',
  fontSize: 13,
  width: '100%',
};
const th: CSSProperties = { padding: '10px 12px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--hg-text-2)', whiteSpace: 'nowrap' };
const td: CSSProperties = { padding: '10px 12px', textAlign: 'right', fontSize: 13, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

function usd(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  return `${sign}$${(Math.abs(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function microUsd(micro: number): string {
  return usd(Math.round(micro / 10_000));
}

function count(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function agentLabel(type: string): { name: string; maker: string } {
  if (type === 'unknown') return { name: 'Unknown agent', maker: 'Removed before its type was recorded' };
  const def = getAgent(type);
  return { name: def?.name ?? type, maker: def?.vendor ?? 'Not in the catalog' };
}

function warningsFor(report: UsageShareReport): string[] {
  const { serverCosts, preview } = report;
  const warnings: string[] = [];
  if (serverCosts.hostsPriced === 0) {
    warnings.push('No server prices are entered, so the amount left over is too high. Add a price per server to hivra_host_costs.');
  } else if (serverCosts.unpricedHosts.length > 0) {
    warnings.push(`These active servers have no price yet: ${serverCosts.unpricedHosts.join(', ')}.`);
  }
  if (serverCosts.missingRates.length > 0) {
    warnings.push(`Server costs in ${serverCosts.missingRates.join(' and ')} are left out until you enter a rate to US dollars.`);
  }
  if (report.unbilledPaidPlans > 0) {
    warnings.push(`${count(report.unbilledPaidPlans)} paid-plan account(s) have no card or App Store subscription on record and are counted at $0.`);
  }
  const quiet = preview.payingPeople - preview.payingPeopleWithUsage;
  if (quiet > 0) {
    warnings.push(`${count(quiet)} of ${count(preview.payingPeople)} paying people have no measured use this month, so their part is not assigned to any agent.`);
  }
  return warnings;
}

export default async function OpsMarginsPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { userId } = await auth();
  await auth.protect();
  const user = await currentUser();
  const userEmail = verifiedPrimaryEmailOf(user);
  const isOpsAdmin = isOpsAdminUser({ userId: userId || user?.id || null, email: userEmail });

  if (!isOpsAdmin) {
    redirect('/dashboard');
    return null;
  }

  if (!supabaseAdmin) {
    return (
      <div className="p-10">
        <h1 className="serif text-3xl">Usage and margins are unavailable.</h1>
        <p style={{ color: 'var(--text-secondary)' }}>The Supabase admin client is not configured.</p>
      </div>
    );
  }

  const raw = await props.searchParams;
  const params: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) params[key] = typeof value === 'string' ? value : undefined;
  const month = parseUsageShareMonth(params.month);
  const inputs = parseUsageShareInputs(params);

  let report: UsageShareReport | null = null;
  let loadError: string | null = null;
  try {
    report = await loadUsageShareReport(supabaseAdmin, month, inputs);
  } catch (error) {
    loadError = error instanceof Error ? error.message : 'The report could not be read.';
  }

  const preview = report?.preview ?? null;
  const warnings = report ? warningsFor(report) : [];
  const tiles = preview
    ? [
        { label: 'Paying people', value: count(preview.payingPeople) },
        { label: 'Subscriptions', value: usd(preview.revenueMinor) },
        { label: 'Payment fees', value: usd(-preview.feesMinor) },
        { label: 'Servers', value: usd(-preview.serverCostMinor) },
        { label: 'Left over', value: usd(preview.netMinor) },
        { label: `Shared at ${inputs.sharePercent}%`, value: usd(preview.poolMinor) },
      ]
    : [];

  return (
    <DashboardPageShell maxWidth={1100} marginBottom="8rem" padding="0 clamp(16px, 5vw, 24px)" topPadding="1rem" style={{ position: 'relative', zIndex: 1 }}>
      <div className="flex flex-col md:flex-row md:justify-between" style={{ gap: '1rem', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
        <div style={{ maxWidth: 760 }}>
          <p className="hg-label" style={{ margin: '1rem 0 6px' }}>Operator</p>
          <h1 style={{ margin: 0, fontSize: 30, fontWeight: 600, letterSpacing: '-0.03em', color: 'var(--hg-text)' }}>Usage and margins</h1>
          <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.6, color: 'var(--hg-text-2)' }}>
            How much each kind of agent was used in a month, what the month cost, and what a share of the remainder would come to if it were split by use. This page only reads. Nothing here is billed or paid.
          </p>
        </div>
        <Link href="/dashboard/ops" className="hg-btn" style={{ textDecoration: 'none' }}>Back to ops</Link>
      </div>

      <form method="get" style={{ ...card, padding: 16, marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, alignItems: 'end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--hg-text-2)' }}>
          Month (UTC)
          <input type="month" name="month" defaultValue={month.label} style={field} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--hg-text-2)' }}>
          Share of what is left, %
          <input type="number" name="share" min={0} max={100} step="any" defaultValue={inputs.sharePercent} style={field} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--hg-text-2)' }}>
          Payment fee, %
          <input type="number" name="fee" min={0} max={100} step="any" defaultValue={inputs.feePercent} style={field} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--hg-text-2)' }}>
          Fixed fee per payment, $
          <input type="number" name="fixed" min={0} max={100} step="any" defaultValue={inputs.feeFixedMinor / 100} style={field} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--hg-text-2)' }}>
          App Store fee, %
          <input type="number" name="appfee" min={0} max={100} step="any" defaultValue={inputs.appStoreFeePercent} style={field} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--hg-text-2)' }}>
          1 EUR in USD
          <input type="number" name="eur" min={0} max={100} step="any" defaultValue={inputs.usdRates.EUR ?? ''} placeholder="for example 1.08" style={field} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--hg-text-2)' }}>
          1 GBP in USD
          <input type="number" name="gbp" min={0} max={100} step="any" defaultValue={inputs.usdRates.GBP ?? ''} placeholder="for example 1.27" style={field} />
        </label>
        <button type="submit" className="hg-btn hg-btn-primary" style={{ height: 36 }}>Update</button>
      </form>

      {loadError && (
        <p role="alert" style={{ ...card, padding: 16, color: 'var(--hg-bad)', fontSize: 13 }}>
          The report could not be read: {loadError}
        </p>
      )}

      {preview && report && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
            {tiles.map((tile) => (
              <div key={tile.label} style={{ ...card, padding: '14px 16px' }}>
                <p style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '-0.03em', color: 'var(--hg-text)', fontVariantNumeric: 'tabular-nums' }}>{tile.value}</p>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--hg-text-2)' }}>{tile.label}</p>
              </div>
            ))}
          </div>

          {warnings.length > 0 && (
            <ul style={{ ...card, margin: '0 0 16px', padding: '12px 16px 12px 32px', fontSize: 13, lineHeight: 1.6, color: 'var(--hg-text-2)' }}>
              {warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}

          <div style={{ ...card, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <caption style={{ captionSide: 'top', textAlign: 'left', padding: '14px 16px 4px', fontSize: 15, fontWeight: 600, color: 'var(--hg-text)' }}>
                By kind of agent, {month.label}
              </caption>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--hg-stroke)' }}>
                  <th scope="col" style={{ ...th, textAlign: 'left', paddingLeft: 16 }}>Agent</th>
                  <th scope="col" style={th}>Agents</th>
                  <th scope="col" style={th}>People</th>
                  <th scope="col" style={th}>Active hours</th>
                  <th scope="col" style={th}>Part of hours</th>
                  <th scope="col" style={th}>Model requests</th>
                  <th scope="col" style={th}>Model margin</th>
                  <th scope="col" style={{ ...th, paddingRight: 16 }}>Would receive</th>
                </tr>
              </thead>
              <tbody>
                {preview.byType.length === 0 && (
                  <tr><td colSpan={8} style={{ ...td, textAlign: 'left', paddingLeft: 16, color: 'var(--hg-text-2)' }}>No measured use in this month.</td></tr>
                )}
                {preview.byType.map((row) => {
                  const label = agentLabel(row.agentType);
                  return (
                    <tr key={row.agentType} style={{ borderBottom: '1px solid var(--hg-stroke-subtle)' }}>
                      <th scope="row" style={{ ...td, textAlign: 'left', paddingLeft: 16, fontWeight: 400 }}>
                        <span style={{ display: 'block', fontWeight: 600, color: 'var(--hg-text)' }}>{label.name}</span>
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--hg-text-2)' }}>{label.maker}</span>
                      </th>
                      <td style={td}>{count(row.agents)}</td>
                      <td style={td}>{count(row.people)}</td>
                      <td style={td}>{count(row.activeHours)}</td>
                      <td style={td}>{percent(row.hoursShare)}</td>
                      <td style={td}>{count(row.inferenceRequests)}</td>
                      <td style={td}>{microUsd(row.inferenceChargedMicroUsd - row.inferenceCostMicroUsd)}</td>
                      <td style={{ ...td, paddingRight: 16, fontWeight: 600, color: 'var(--hg-text)' }}>{usd(row.shareMinor)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={7} style={{ ...td, textAlign: 'left', paddingLeft: 16, fontWeight: 400, color: 'var(--hg-text-2)' }}>
                    Not assigned: paying people with no measured use
                  </th>
                  <td style={{ ...td, paddingRight: 16 }}>{usd(preview.unassignedMinor)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p style={{ margin: '14px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--hg-text-2)' }}>
            An hour counts when an agent made a model request through Hivra credits or reported a run in it. Agents on their own model key are not counted yet. Each paying person&apos;s part of the share follows what they pay, and is split between the agents they used by hours. Subscriptions are counted at the monthly list price for the people on a paid plan today, so earlier months are approximate.
            {preview.appStorePeople > 0 && ` ${count(preview.appStorePeople)} of them pay through the App Store and are counted at the App Store fee.`}
          </p>
        </>
      )}
    </DashboardPageShell>
  );
}
