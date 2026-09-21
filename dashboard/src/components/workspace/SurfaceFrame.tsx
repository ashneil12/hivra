"use client";

import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

const ALLOWED_AGENT_TABS = new Set([
  "chat",
  "aeon",
  "files",
  "git",
  "terminal",
  "box",
  "browser",
]);

function normalizedSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.includes("/") || decoded.includes("\\")) return null;
    return encodeURIComponent(decoded);
  } catch {
    return null;
  }
}

/**
 * Only the two authenticated legacy routes approved for compatibility
 * handoff may cross this boundary. Query strings are reconstructed from the
 * fixed tab allowlist; fragments and every other parameter are discarded.
 */
function sanitizeWorkspaceDestination(value?: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;

  let url: URL;
  try {
    url = new URL(value, "https://workspace.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://workspace.invalid") return null;

  const instanceMatch = url.pathname.match(/^\/dashboard\/instances\/([^/]+)$/);
  if (instanceMatch) {
    const id = normalizedSegment(instanceMatch[1]);
    return id ? `/dashboard/instances/${id}` : null;
  }

  const agentMatch = url.pathname.match(/^\/dashboard\/agent\/([^/]+)$/);
  if (!agentMatch) return null;
  const id = normalizedSegment(agentMatch[1]);
  const tab = url.searchParams.get("tab");
  if (!id || !tab || !ALLOWED_AGENT_TABS.has(tab)) return null;
  return `/dashboard/agent/${id}?tab=${tab}`;
}

export interface SurfaceFrameProps {
  agentName: string;
  surfaceLabel: string;
  accessLabel: string;
  destinationHref?: string | null;
  frameSrc?: string | null;
  onBack?: () => void;
  children?: ReactNode;
}

/**
 * The content frame for one surface tab.
 *
 * This used to render its own 48px header carrying a 20px display-serif title,
 * a "Back to conversation" button, and an "Open in new tab" link — directly
 * beneath the workspace tab strip that already named the same surface. So
 * opening Terminal produced "Terminal" in the tab strip and "Terminal" again as
 * a page title, over a button whose whole job was undoing the tab the user had
 * just clicked. The strip is the only place the surface should be named; what
 * belongs here is the way out of a genuine dead end, and nothing else.
 */
export function SurfaceFrame({
  agentName,
  surfaceLabel,
  accessLabel,
  destinationHref,
  frameSrc,
  children,
}: SurfaceFrameProps) {
  const safeDestination = sanitizeWorkspaceDestination(destinationHref);
  const safeFrameSource = sanitizeWorkspaceDestination(frameSrc);
  const title = `${agentName} — ${surfaceLabel}`;

  return (
    <section
      aria-label={title}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--bg-surface)]"
      data-testid="surface-frame"
    >
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {children}
        {safeFrameSource ? (
          <iframe
            src={safeFrameSource}
            title={title}
            className="h-full min-h-[260px] w-full border-0 bg-[var(--vellum-bg)]"
          />
        ) : null}
        {!children && !safeFrameSource ? (
          <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="mono text-[11.5px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {surfaceLabel} · {agentName}
            </p>
            <p className="max-w-[440px] text-[14px] leading-[1.5] text-[var(--text-secondary)]">
              {safeDestination
                ? "This one has no in-app view yet. It opens on the agent's own page."
                : `This ${surfaceLabel.toLowerCase()} surface isn't available for ${agentName} right now.`}
            </p>
            {safeDestination ? (
              <a
                href={safeDestination}
                className="action-button inline-flex min-h-[36px] items-center gap-2 px-4 text-[12px] font-semibold normal-case tracking-normal no-underline"
              >
                Open {surfaceLabel}
                <ExternalLink aria-hidden="true" size={13} />
              </a>
            ) : null}
            <p className="mono text-[11px] text-[var(--text-muted)]">{accessLabel}</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
