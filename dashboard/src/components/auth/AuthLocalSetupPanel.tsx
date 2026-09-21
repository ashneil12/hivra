'use client';

import { AlertTriangle } from 'lucide-react';

import type { ClerkRuntimeEnvironment } from '@/lib/clerk-runtime-config';

function buildHostEntry(origin: string): string {
  return origin.replace(/^https?:\/\//i, "");
}

export function AuthLocalSetupPanel({
  runtime,
}: {
  runtime: ClerkRuntimeEnvironment;
}) {
  const recommendedHost = buildHostEntry(runtime.recommendedLiveKeyDebugOrigin);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "2rem",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 760,
          border: "1px solid rgba(239,68,68,0.24)",
          background: "rgba(255,255,255,0.92)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.08)",
          padding: "1.5rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <AlertTriangle size={18} style={{ color: "var(--red)", flexShrink: 0, marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p
              className="mono"
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.14em",
                fontWeight: 700,
                marginBottom: 8,
                color: "var(--red)",
              }}
            >
              Local Auth Setup Required
            </p>
            <h1 className="serif" style={{ fontSize: "2rem", lineHeight: 1.05, marginBottom: 12 }}>
              This sign-in screen can&apos;t load on <code>{runtime.runtimeOrigin}</code>.
            </h1>
            <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-secondary)", marginBottom: 14 }}>
              This local app is using Hivra&apos;s live Clerk keys. Clerk intentionally blocks
              live keys on <code>{runtime.runtimeOrigin}</code>, so the hosted sign-in form will
              never finish loading on this URL.
            </p>
            <div
              style={{
                border: "1px solid var(--etched-border)",
                background: "var(--bg-elevated)",
                padding: "12px 14px",
                marginBottom: 14,
              }}
            >
              <p className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: 8 }}>
                Best Option For Everyday Local Work
              </p>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
                Replace the live Clerk keys in <code>.env.local</code> with Clerk development
                keys: <code>pk_test_...</code> and <code>sk_test_...</code>. If you just changed
                that file, restart <code>npm run dev</code> so Next reloads the public Clerk env
                values.
              </p>
            </div>
            <div
              style={{
                border: "1px solid var(--etched-border)",
                background: "var(--bg-elevated)",
                padding: "12px 14px",
              }}
            >
              <p className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: 8 }}>
                If You Need To Debug The Live Clerk Instance
              </p>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
                Add <code>127.0.0.1 {recommendedHost}</code> to <code>/etc/hosts</code>, run{" "}
                <code>sudo npm run dev:live-auth</code>, then open{" "}
                <code>{runtime.recommendedLiveKeyDebugOrigin}</code>. Social sign-in providers can
                still need matching redirect URLs if you test the live flow this way.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
