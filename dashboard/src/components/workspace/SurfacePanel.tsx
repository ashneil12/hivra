"use client";

import { useEffect, useRef, type ReactNode } from "react";

import type { WorkspaceSurface } from "@/lib/workspace/workspace-contracts";

type ComputerSurface = Exclude<WorkspaceSurface, "conversation">;

export interface SurfacePanelProps {
  agentUid: string;
  agentName: string;
  surface: ComputerSurface;
  surfaceLabel: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The content area when a surface tab is selected.
 *
 * This used to be a second column: a `clamp(440px,42vw,720px)` right-hand pane
 * that rendered alongside the conversation, carrying its own 48px header with a
 * "Back to conversation" button and the surface name in display serif. Selecting
 * the Terminal tab therefore produced the word "Terminal" twice and a 440px
 * conversation squeezed beside an iframe, all to avoid doing the obvious thing —
 * putting the terminal where the conversation was.
 *
 * Now it fills the content area the conversation occupied, which is what a tab
 * means. Escape and the header's close button both return to the conversation.
 */
export function SurfacePanel({
  agentUid,
  agentName,
  surface,
  surfaceLabel,
  onClose,
  children,
}: SurfacePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      role="region"
      aria-label={`${surfaceLabel} surface for ${agentName}`}
      tabIndex={-1}
      data-agent-uid={agentUid}
      data-surface={surface}
      data-testid="surface-panel"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-surface)]"
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
        {children}
      </div>
    </div>
  );
}
