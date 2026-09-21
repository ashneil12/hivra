"use client";

import { ChevronDown, PanelLeft, X } from "lucide-react";
import type { RefObject } from "react";

import { unifiedStateLabel, type UnifiedAgent } from "@/lib/hivra/unified-agent";

export interface WorkspaceHeaderProps {
  agent: UnifiedAgent;
  headingRef: RefObject<HTMLHeadingElement | null>;
  agentPickerTriggerRef: RefObject<HTMLButtonElement | null>;
  agentPickerOpen: boolean;
  surfaceSelected: boolean;
  onToggleAgentPane: () => void;
  onOpenAgentPicker: () => void;
  onCloseSurface: () => void;
}

/**
 * One compact bar: switcher, identity, then the surface escape hatch.
 *
 * The "Canary test guide" book icon used to live here as a bare glyph with no
 * visible label. Its meaning was unrecoverable from the UI, and it is a
 * contributor-facing panel rather than something an operator uses mid-task, so
 * it moved to the rail's footer where it is written out in words.
 */
export function WorkspaceHeader({
  agent,
  headingRef,
  agentPickerTriggerRef,
  agentPickerOpen,
  surfaceSelected,
  onToggleAgentPane,
  onOpenAgentPicker,
  onCloseSurface,
}: WorkspaceHeaderProps) {
  const iconButton =
    "inline-flex min-h-[32px] min-w-[32px] shrink-0 items-center justify-center border border-transparent text-[var(--text-muted)] outline-none transition-colors hover:bg-[var(--bg-elevated)] hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1";

  return (
    <header
      data-testid="workspace-header"
      className="flex min-h-[40px] min-w-0 shrink-0 items-center gap-1.5 border-b border-[var(--etched-border)] bg-[var(--bg-surface)] px-2 py-0.5"
    >
      <button
        type="button"
        aria-label="Show the agent list"
        title="Agent list (⌘B)"
        onClick={onToggleAgentPane}
        className={iconButton}
      >
        <PanelLeft aria-hidden="true" size={15} />
      </button>

      {/* The switcher opens a menu, not the rail. Expanding the rail from here
          was a lie: the button said "switch agent" and produced a sidebar the
          user then had to read and click again. */}
      <button
        ref={agentPickerTriggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={agentPickerOpen}
        aria-label={`Switch agent — currently ${agent.name}`}
        onClick={onOpenAgentPicker}
        className={[
          "mono flex min-h-[32px] min-w-0 shrink items-center gap-2 border px-2 text-left outline-none",
          "focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-1",
          agentPickerOpen
            ? "border-[var(--hivra-red-line)] bg-[var(--bg-elevated)]"
            : "border-[var(--etched-border)] hover:border-[var(--hivra-red-line)]",
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: agent.dot }}
        />
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="truncate text-[13px] font-semibold leading-[1.2] outline-none"
        >
          {agent.name}
        </h1>
        <span className="hidden shrink-0 text-[11px] text-[var(--text-muted)] sm:inline">
          {agent.typeLabel} · {unifiedStateLabel(agent.state)}
        </span>
        <ChevronDown
          aria-hidden="true"
          size={13}
          className={[
            "shrink-0 text-[var(--text-muted)] motion-safe:transition-transform",
            agentPickerOpen ? "rotate-180" : "",
          ].join(" ")}
        />
      </button>

      <div className="flex-1" />

      {/* A surface is either in the tab strip or gone. The old pane could sit
          open beside a conversation showing the same tab twice; this closes it
          and returns to the conversation, which is the only thing "hide this"
          can honestly mean while one tab is selected. */}
      {surfaceSelected ? (
        <button
          type="button"
          aria-label="Close surface and return to conversation"
          title="Close (Esc)"
          onClick={onCloseSurface}
          className={iconButton}
        >
          <X aria-hidden="true" size={15} />
        </button>
      ) : null}
    </header>
  );
}
