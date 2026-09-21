"use client";

import { useState } from "react";

import { Monitor } from "lucide-react";

import { ConnectDesktopModal } from "./ConnectDesktopModal";

/**
 * On-brand, self-contained entry point for the Hermes Desktop setup guide.
 * Drop it anywhere: <ConnectDesktopButton instanceId={instance.id} />.
 * Renders nothing heavy until clicked.
 */
export function ConnectDesktopButton({
  instanceId,
  variant = "outline",
}: {
  instanceId: string;
  variant?: "outline" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          padding: "8px 12px",
          border:
            variant === "outline" ? "1px solid var(--etched-border)" : "1px solid transparent",
          background: "transparent",
          color: "var(--text-primary)",
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          cursor: "pointer",
        }}
      >
        <Monitor size={13} /> Connect Desktop
      </button>
      {open ? (
        <ConnectDesktopModal instanceId={instanceId} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
