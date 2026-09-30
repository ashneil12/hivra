"use client";

import { useState } from "react";

import { Monitor } from "lucide-react";

import { ConnectDesktopModal } from "./ConnectDesktopModal";

/**
 * On-brand, self-contained entry point for the Hermes Desktop setup guide.
 * Drop it anywhere: <ConnectDesktopButton instanceId={instance.id} />.
 * Renders nothing heavy until clicked. Pass `onOpen` to own the modal
 * yourself, e.g. when the trigger moves between layouts.
 */
export function ConnectDesktopButton({
  instanceId,
  variant = "outline",
  fullWidth = false,
  onOpen,
}: {
  instanceId: string;
  variant?: "outline" | "ghost";
  /** Stretch to the container, e.g. inside the phone console's Actions list. */
  fullWidth?: boolean;
  /** Called instead of opening the built-in modal. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => (onOpen ? onOpen() : setOpen(true))}
        className="mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          minHeight: fullWidth ? 44 : 40,
          width: fullWidth ? "100%" : undefined,
          padding: "8px 12px",
          border:
            variant === "outline" ? "1px solid var(--etched-border)" : "1px solid transparent",
          background: "transparent",
          color: "var(--text-primary)",
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          cursor: "pointer",
        }}
      >
        <Monitor size={13} /> Connect Desktop
      </button>
      {open && !onOpen ? (
        <ConnectDesktopModal instanceId={instanceId} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
