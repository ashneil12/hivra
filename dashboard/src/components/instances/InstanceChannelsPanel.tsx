"use client";

// InstanceChannelsPanel — the "Channels" surface for a Hermes instance.
//
// The backend already wires ~20 platforms (INTEGRATION_DEFINITIONS → the
// /api/instances/[id]/integrations switch → the gateway's per-platform
// connectors). Until now only Telegram had a UI. This panel renders a tile per
// channel with live connect status (from the route's GET statuses) and opens a
// connect flow per tile:
//
//   - Telegram → the existing bespoke <InstanceTelegramConnect> (unchanged UX)
//   - everything else → the generic <InstanceChannelConnect>, which posts the
//     definition's fields to the SAME route and reuses the same guides.
//
// One GET feeds every tile's status; each connect modal re-reads on close so the
// grid reflects connect/disconnect immediately.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2, Plug, X } from "lucide-react";

import { SafePortal } from "@/components/ui/SafePortal";
import { InstanceTelegramConnect } from "@/components/instances/InstanceTelegramConnect";
import { InstanceChannelConnect } from "@/components/instances/InstanceChannelConnect";
import { CHANNEL_SURFACE } from "@/lib/integrations/channel-surface";

type StatusMap = Record<string, { configured?: boolean; partial?: boolean }>;

async function readJson(r: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono), monospace",
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: "0.14em",
  fontWeight: 700,
};

export function InstanceChannelsPanel({
  instanceId,
  agentName,
  initialChannel = null,
}: {
  instanceId: string;
  agentName?: string | null;
  /** Open straight into this channel's connect flow (deep-link from a tile). */
  initialChannel?: string | null;
}) {
  const [statuses, setStatuses] = useState<StatusMap | null>(null);
  const [open, setOpen] = useState<string | null>(() =>
    initialChannel && CHANNEL_SURFACE.some((c) => c.id === initialChannel) ? initialChannel : null,
  );

  // Fetches the current statuses without touching React state — the caller
  // decides when/whether to commit. Keeping the network read pure of setState
  // lets the mount effect commit inside a guarded callback (the lint rule
  // forbids synchronous setState in an effect body).
  const fetchStatuses = useCallback(async (): Promise<StatusMap> => {
    try {
      const r = await fetch(`/api/instances/${instanceId}/integrations`, { cache: "no-store" });
      const j = await readJson(r);
      const data = (j?.data ?? null) as { statuses?: StatusMap } | null;
      return data?.statuses ?? {};
    } catch {
      return {};
    }
  }, [instanceId]);

  // Imperative refresh used by the modal-close handler (already outside an
  // effect body, so a direct commit here is fine).
  const loadStatuses = useCallback(() => {
    void fetchStatuses().then(setStatuses);
  }, [fetchStatuses]);

  useEffect(() => {
    let alive = true;
    void fetchStatuses().then((next) => {
      if (alive) setStatuses(next);
    });
    return () => {
      alive = false;
    };
  }, [fetchStatuses]);

  // Close the modal + refresh the grid so connect/disconnect reflects at once.
  const closeModal = useCallback(() => {
    setOpen(null);
    void loadStatuses();
  }, [loadStatuses]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeModal]);

  const groups = useMemo(
    () => ({
      messaging: CHANNEL_SURFACE.filter((c) => c.category === "messaging"),
      tools: CHANNEL_SURFACE.filter((c) => c.category === "tools"),
    }),
    [],
  );

  const renderTile = (id: string) => {
    const meta = CHANNEL_SURFACE.find((c) => c.id === id)!;
    const Icon = meta.icon;
    const st = statuses?.[id];
    const connected = Boolean(st?.configured);
    const partial = Boolean(st?.partial);
    return (
      <button
        key={id}
        type="button"
        onClick={() => setOpen(id)}
        data-testid={`channel-tile-${id}`}
        style={{
          textAlign: "left",
          border: "1px solid var(--etched-border)",
          background: connected ? "rgba(34,197,94,0.05)" : "rgba(255,255,255,0.02)",
          padding: 14,
          display: "grid",
          gap: 8,
          cursor: "pointer",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              border: "1px solid var(--etched-border)",
              color: "var(--ink-black)",
              flexShrink: 0,
            }}
          >
            <Icon size={15} />
          </span>
          <span className="serif" style={{ fontSize: 15, color: "var(--ink-black)", fontWeight: 400 }}>
            {meta.label ?? meta.id}
          </span>
          <span style={{ flex: 1 }} />
          {statuses === null ? (
            <Loader2 size={13} style={{ animation: "spin 1s linear infinite", opacity: 0.4 }} />
          ) : connected ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e" }} />
              <span className="mono" style={{ ...mono, color: "#16a34a" }}>
                Connected
              </span>
            </span>
          ) : partial ? (
            <span className="mono" style={{ ...mono, color: "var(--amber, #d97706)" }}>
              Incomplete
            </span>
          ) : (
            <span className="mono" style={{ ...mono, color: "var(--text-muted)" }}>
              Connect
            </span>
          )}
        </div>
        <span style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>{meta.tagline}</span>
      </button>
    );
  };

  const grid: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
    gap: 12,
  };

  return (
    <div style={{ display: "grid", gap: 22 }}>
      <div style={{ display: "grid", gap: 12 }}>
        <div className="mono" style={{ ...mono, color: "var(--text-secondary)", opacity: 0.8 }}>
          Messaging channels
        </div>
        <div style={grid}>{groups.messaging.map((c) => renderTile(c.id))}</div>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <div className="mono" style={{ ...mono, color: "var(--text-secondary)", opacity: 0.8 }}>
          Tools &amp; integrations
        </div>
        <div style={grid}>{groups.tools.map((c) => renderTile(c.id))}</div>
      </div>

      {open ? (
        <SafePortal>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Connect ${open}`}
            onClick={closeModal}
            style={{
              position: "fixed",
              inset: 0,
              background: "color-mix(in srgb, var(--overlay-bg) 78%, rgba(0,0,0,0.22))",
              backdropFilter: "blur(10px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 9999,
              padding: "clamp(16px, 2.4vw, 30px)",
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                position: "relative",
                width: "min(600px, calc(100vw - 32px))",
                maxHeight: "calc(100vh - 64px)",
                overflow: "auto",
                background: "color-mix(in srgb, var(--bg-surface) 96%, transparent)",
                border: "1px solid var(--etched-border)",
                boxShadow: "0 24px 80px rgba(0, 0, 0, 0.22)",
              }}
            >
              <button
                type="button"
                autoFocus
                onClick={closeModal}
                aria-label="Close"
                style={{
                  position: "absolute",
                  top: 12,
                  right: 12,
                  zIndex: 1,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  color: "var(--text-muted)",
                  padding: 6,
                  display: "inline-flex",
                }}
              >
                <X size={16} />
              </button>
              {open === "Telegram" ? (
                <InstanceTelegramConnect instanceId={instanceId} agentName={agentName} />
              ) : (
                <InstanceChannelConnect instanceId={instanceId} platform={open} agentName={agentName} />
              )}
            </div>
          </div>
        </SafePortal>
      ) : null}
    </div>
  );
}
