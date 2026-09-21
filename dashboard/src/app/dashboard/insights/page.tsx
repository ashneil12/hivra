import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

import { DashboardPageShell } from '@/components/layout/DashboardPageShell';
import { isOpsAdminUser } from '@/lib/ops-access';
import { getConversionFunnel } from '@/lib/conversion-funnel';
import { getActivationCohorts } from '@/lib/activation-cohorts';
import { getTelegramActivationStats } from '@/lib/telegram-activation';
import { getPlatformStats } from '@/lib/platform-stats';
import { AdminInsightsContent } from '@/components/admin/AdminInsightsContent.client';

export const dynamic = 'force-dynamic';

const RANGE_OPTIONS = [
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: '90d', label: '90D' },
  { key: '6m', label: '6M' },
  { key: '1y', label: '1Y' },
  { key: 'ytd', label: 'YTD' },
] as const;

const DEFAULT_RANGE = RANGE_OPTIONS[1]; // 30D

// Resolve a range key to a day count. YTD is computed from Jan 1 (UTC) to
// today; everything is clamped to the RPC's 365-day ceiling.
function resolveRangeDays(key: string): number {
  switch (key) {
    case '7d':
      return 7;
    case '90d':
      return 90;
    case '6m':
      return 180;
    case '1y':
      return 365;
    case 'ytd': {
      const now = new Date();
      const yearStart = Date.UTC(now.getUTCFullYear(), 0, 1);
      const days = Math.floor((now.getTime() - yearStart) / 86_400_000) + 1;
      return Math.min(Math.max(days, 1), 365);
    }
    case '30d':
    default:
      return 30;
  }
}

export default async function AdminInsightsPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { userId } = await auth();
  await auth.protect();
  const user = await currentUser();
  const userEmail =
    user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || null;

  if (!isOpsAdminUser({ userId: userId || user?.id || null, email: userEmail })) {
    redirect('/dashboard');
    return null;
  }

  const searchParams = await props.searchParams;
  const rangeRaw = typeof searchParams.range === 'string' ? searchParams.range : DEFAULT_RANGE.key;
  const active = RANGE_OPTIONS.find((o) => o.key === rangeRaw) ?? DEFAULT_RANGE;
  const days = resolveRangeDays(active.key);

  const [stats, funnel, activation, telegram] = await Promise.all([
    getPlatformStats(days),
    getConversionFunnel(),
    getActivationCohorts(),
    getTelegramActivationStats(days),
  ]);

  return (
    <DashboardPageShell
      maxWidth={1100}
      marginBottom="8rem"
      padding="0 clamp(16px, 5vw, 24px)"
      topPadding="1rem"
      style={{ position: 'relative', zIndex: 1 }}
    >
      <AdminInsightsContent
        stats={stats}
        funnel={funnel}
        activation={activation}
        telegram={telegram}
        rangeKey={active.key}
        rangeLabel={active.label}
        rangeOptions={RANGE_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
      />
    </DashboardPageShell>
  );
}
