import { auth } from "@clerk/nextjs/server";

import { AgentActivityPanel } from "@/components/dashboard/AgentActivityPanel";
import { DashboardPageShell } from "@/components/layout/DashboardPageShell";
import { isLocalAuthMode } from "@/lib/self-host/config";

export const dynamic = "force-dynamic";

/**
 * Account activity covers both agent families: recorded lifecycle activity and
 * desktop sessions for Hivra boxes, plus metered token usage where a managed
 * Hermes agent reports it. It does not infer task progress or claim live
 * computer events that Hivra has not observed. Live runtime state remains on
 * each agent or computer surface.
 */
export default async function ActivityPage() {
  await auth.protect();

  return (
    <DashboardPageShell
      maxWidth={1100}
      marginBottom="8rem"
      padding="0 clamp(16px, 5vw, 24px)"
      topPadding="1rem"
      style={{ position: "relative", zIndex: 1 }}
    >
      <section aria-label="Activity" style={{ display: "grid", gap: 18 }}>
        <header style={{ display: "grid", gap: 6 }}>
          <p
            className="mono"
            style={{
              margin: 0,
              color: "var(--text-muted)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            Recorded account activity
          </p>
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5 }}>
            Recorded lifecycle activity and desktop sessions for your agents and computers, plus
            metered token usage where a managed agent reports it. Live state stays on each resource,
            and Hivra does not estimate task completion.
          </p>
        </header>
        {isLocalAuthMode() ? (
          <div
            role="status"
            style={{
              border: "1px solid var(--etched-border)",
              background: "rgba(255,255,255,0.025)",
              padding: "2rem 1.5rem",
              color: "var(--text-secondary)",
              fontSize: 14,
              lineHeight: 1.6,
              textAlign: "center",
            }}
          >
            No managed-agent activity is recorded in this local installation yet. Live computers
            and agents appear on Home and their resource pages.
          </div>
        ) : (
          <AgentActivityPanel />
        )}
      </section>
    </DashboardPageShell>
  );
}
