import Link from 'next/link';
import { auth, currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

import { DashboardPageShell } from '@/components/layout/DashboardPageShell';
import { ReleasesConsole } from '@/components/ops/ReleasesConsole';
import { isOpsAdminUser, verifiedPrimaryEmailOf } from '@/lib/ops-access';

export const dynamic = 'force-dynamic';

export default async function OpsReleasesPage() {
  const { userId } = await auth();
  await auth.protect();
  const user = await currentUser();
  const userEmail = verifiedPrimaryEmailOf(user);
  const isOpsAdmin = isOpsAdminUser({ userId: userId || user?.id || null, email: userEmail });

  if (!isOpsAdmin) {
    redirect('/dashboard');
    return null;
  }

  return (
    <DashboardPageShell
      maxWidth={1100}
      marginBottom="8rem"
      padding="0 clamp(16px, 5vw, 24px)"
      topPadding="1rem"
      style={{ position: 'relative', zIndex: 1 }}
    >
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
            Hermes releases
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
            Roll out an update.
          </h1>
          <p style={{ color: 'var(--text-secondary)', maxWidth: 980, lineHeight: 1.8, fontSize: '1.05rem', marginTop: '1rem' }}>
            Register an image, then promote it one stage at a time: early access, one computer, 10%, then everyone. Halt it at any point.
          </p>
        </div>
        <Link
          href="/dashboard/ops"
          className="action-button"
          style={{ padding: '10px 20px', minHeight: 44, display: 'inline-flex', alignItems: 'center', fontSize: 10, letterSpacing: '0.1em', textDecoration: 'none' }}
        >
          Incident feed
        </Link>
      </div>
      <ReleasesConsole />
    </DashboardPageShell>
  );
}
