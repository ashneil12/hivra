"use client";

// Authenticated iframe embed for an on-box web runtime (Agent Zero, Aeon, OpenClaw).
//
// Agents whose catalog entry says `surface: "dashboard"` host their OWN web UI on
// the box rather than exposing a chat-CLI endpoint. The workspace used to render
// nothing for them — clicking one in the Chat rail produced a "no conversation"
// notice with no way to reach the runtime at all, even though the runtime was up.
//
// The access dance is the box's `surfaceAuth: post-cookie-v1` handshake: probe
// `/api/meta` for protocol support (never send a bearer to an unverified
// runtime), then POST the token to `/auth/bootstrap` inside a hidden form whose
// target is the iframe, so the credential never lands in a URL. The shared
// hook also signs in again after the box gateway restarts (into a new frame,
// keyed on its generation, so no history entry is added) and waits, for a
// bounded time, for a native runtime (DeepSeek) to be ready before opening it.

import { ExternalLink, Loader2 } from "lucide-react";
import { useId, useRef } from "react";
import { useSurfaceBootstrap } from "@/components/hivra/useSurfaceBootstrap";

export interface RuntimeSurfaceFrameProps {
  /** Clean HTTPS base URL of the box runtime. */
  url: string;
  /** Per-box API token used for the bootstrap POST. */
  token: string | null;
  /** Human label for the surface, used for the iframe title. */
  label: string;
  /** Quiet description shown in the toolbar. */
  description?: string;
  /** Frame background while the guest paints. */
  background?: string;
  /** Optional Manage affordance shown on the failure states. */
  onManage?: () => void;
}

export function RuntimeSurfaceFrame({
  url,
  token,
  label,
  description,
  background = "var(--bg-surface)",
  onManage,
}: RuntimeSurfaceFrameProps) {
  const frameName = `hivra-runtime-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const newTabFormRef = useRef<HTMLFormElement>(null);
  const {
    status: accessStatus,
    generation,
    starting,
    stalled,
    bootstrapUrl,
    destination,
    formRef,
    retry,
  } = useSurfaceBootstrap({ url, token });

  const openInNewTab = () => {
    const form = newTabFormRef.current;
    if (accessStatus !== "ready" || !form || !bootstrapUrl || !destination || !token) return;
    form.requestSubmit();
  };

  return (
    <div
      data-testid="runtime-surface-frame"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      {accessStatus === "ready" ? (
        <>
          <form
            ref={formRef}
            action={bootstrapUrl}
            method="POST"
            target={frameName}
            style={{ display: "none" }}
          >
            <input type="hidden" name="token" value={token ?? ""} />
            <input type="hidden" name="destination" value={destination} />
          </form>
          <form
            ref={newTabFormRef}
            action={bootstrapUrl}
            method="POST"
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "none" }}
          >
            <input type="hidden" name="token" value={token ?? ""} />
            <input type="hidden" name="destination" value={destination} />
          </form>
        </>
      ) : null}

      {/* A quiet status line, not a toolbar. "Open in new tab" sat here as a
          bordered button on every surface — including the ones that render
          perfectly well in the pane — which read as "this tab doesn't actually
          work, open the real thing elsewhere". It is still the honest escape
          hatch when the embed can't connect, so it lives on those states only. */}
      {accessStatus === "ready" ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--etched-border)] px-3 py-1">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#22c55e]"
          />
          <span className="mono truncate text-[11px] text-[var(--text-muted)]">
            {description || label}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={openInNewTab}
            aria-label={`Open ${label} in a new browser tab`}
            title="Open in a new browser tab"
            className="mono inline-flex items-center gap-1.5 px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] outline-none transition-colors hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1"
          >
            <span>New tab</span>
            <ExternalLink size={11} />
          </button>
        </div>
      ) : null}

      {accessStatus === "ready" ? (
        <iframe
          key={generation}
          name={frameName}
          title={label}
          style={{ flex: 1, minHeight: 0, width: "100%", border: 0, background }}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          {accessStatus === "checking" || accessStatus === "starting" ? (
            <Loader2
              size={20}
              className="animate-spin text-[var(--text-muted)]"
              aria-hidden="true"
            />
          ) : null}
          <p className="serif text-[20px] text-[var(--ink-black)]">
            {accessStatus === "checking"
              ? "Connecting securely…"
              : accessStatus === "starting"
                ? starting.title
                : accessStatus === "stalled"
                  ? stalled.title
                  : accessStatus === "upgrade-required"
                    ? "Connection update needed"
                    : "Couldn’t verify secure access"}
          </p>
          <p className="max-w-[460px] text-[13px] leading-[1.6] text-[var(--text-secondary)]">
            {accessStatus === "checking"
              ? "Checking this computer’s connection service."
              : accessStatus === "starting"
                ? starting.detail
                : accessStatus === "stalled"
                  ? stalled.detail
                  : accessStatus === "upgrade-required"
                    ? "This computer uses an older connection service. It needs a runtime update before this surface can be opened securely. Your computer and its data are unchanged."
                    : "The computer’s connection service isn’t reachable yet. Check its status in Manage, then try again."}
          </p>
          {accessStatus !== "checking" ? (
            <div className="flex flex-wrap justify-center gap-2.5">
              {onManage ? (
                <button
                  type="button"
                  onClick={onManage}
                  className="mono border border-[var(--etched-border)] px-3.5 py-2 text-[11px] text-[var(--ink-black)] transition-colors hover:border-[var(--hivra-red-line)]"
                >
                  Open Manage
                </button>
              ) : null}
              {accessStatus === "starting" ? null : (
                <button
                  type="button"
                  onClick={retry}
                  className="mono border border-[var(--etched-border)] px-3.5 py-2 text-[11px] text-[var(--ink-black)] transition-colors hover:border-[var(--hivra-red-line)]"
                >
                  {accessStatus === "upgrade-required" ? "Check again" : "Try again"}
                </button>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
