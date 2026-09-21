import { auth } from '@clerk/nextjs/server';

import { DashboardPageShell } from '@/components/layout/DashboardPageShell';
import { AgentActivityPanel } from '@/components/dashboard/AgentActivityPanel';

export const dynamic = 'force-dynamic';

/**
 * "Your agent at work" — the per-user usage surface. The panel fetches the
 * signed-in user's own agent activity from /api/billing/agent-activity; the
 * page just gates on auth and renders the shell.
 */
export default async function UsagePage() {
  await auth.protect();

  return (
    <DashboardPageShell
      maxWidth={1100}
      marginBottom="8rem"
      padding="0 clamp(16px, 5vw, 24px)"
      topPadding="1rem"
      style={{ position: 'relative', zIndex: 1 }}
    >
      <AgentActivityPanel />
    </DashboardPageShell>
  );
}
