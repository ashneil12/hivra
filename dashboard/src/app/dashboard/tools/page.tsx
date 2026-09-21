import { auth } from '@clerk/nextjs/server';

import { DashboardPageShell } from '@/components/layout/DashboardPageShell';
import { ToolsBrowser } from '@/components/tools/ToolsBrowser';

export const dynamic = 'force-dynamic';

/**
 * Tools — the cross-agent tool catalog. Browse every tool and install it onto any
 * of your agents (CLI boxes and Hermes instances alike) from one place. The
 * browser fetches /api/tools for the catalog + the user's install targets.
 */
export default async function ToolsPage() {
  await auth.protect();

  return (
    <DashboardPageShell
      maxWidth={1100}
      marginBottom="8rem"
      padding="0 clamp(16px, 5vw, 24px)"
      topPadding="1rem"
      style={{ position: 'relative', zIndex: 1 }}
    >
      <div style={{ marginBottom: 22 }}>
        <div
          className="mono"
          style={{
            fontFamily: 'var(--font-mono), monospace', fontSize: 10, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.16em', color: 'var(--text-muted)',
            marginBottom: 8,
          }}
        >
          Tools
        </div>
        <h1
          className="serif"
          style={{ fontSize: 'clamp(1.6rem, 4vw, 2.2rem)', fontWeight: 400, margin: 0, color: 'var(--ink-black)' }}
        >
          Give your agents new powers
        </h1>
        <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', margin: '8px 0 0', lineHeight: 1.55, maxWidth: 620 }}>
          Each tool wires a capability (and any credentials) straight onto the agents you pick — crypto
          intel, scraping, media generation and more. They load on the agent&apos;s next message.
        </p>
      </div>
      <ToolsBrowser />
    </DashboardPageShell>
  );
}
