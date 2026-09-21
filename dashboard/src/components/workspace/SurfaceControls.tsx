"use client";

import {
  AppWindow,
  Folder,
  GitBranch,
  Globe,
  LayoutGrid,
  MessageSquare,
  Monitor,
  Terminal,
} from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import type {
  WorkspaceSurface,
  WorkspaceSurfaceAvailability,
  WorkspaceSurfaceDescriptor,
} from "@/lib/workspace/workspace-contracts";

export interface SurfaceControlsProps {
  descriptors: readonly WorkspaceSurfaceDescriptor[];
  selectedSurface: WorkspaceSurface;
  onSelect: (surface: WorkspaceSurface, trigger: HTMLButtonElement) => void;
}

// Desktop leads the non-chat surfaces because for the resources that have one,
// it IS the resource. A computer whose tabs read "Files · Git · Terminal ·
// Desktop" buries its primary surface behind three secondary ones. Chat agents
// never declare a desktop, so their order is unchanged.
const SURFACE_ORDER: readonly WorkspaceSurface[] = [
  "conversation",
  "desktop",
  "workspace",
  "native",
  "files",
  "git",
  "terminal",
  "browser",
];
const SURFACE_SET = new Set<WorkspaceSurface>(SURFACE_ORDER);
const AVAILABILITY_SET = new Set<WorkspaceSurfaceAvailability>([
  "available",
  "unavailable",
  "unknown",
]);
const SURFACE_ICONS = {
  conversation: MessageSquare,
  workspace: LayoutGrid,
  native: AppWindow,
  files: Folder,
  git: GitBranch,
  terminal: Terminal,
  browser: Globe,
  desktop: Monitor,
} as const;

function strictDescriptors(
  descriptors: readonly WorkspaceSurfaceDescriptor[],
): WorkspaceSurfaceDescriptor[] {
  const accepted = new Map<WorkspaceSurface, WorkspaceSurfaceDescriptor>();

  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor !== "object") continue;
    if (!SURFACE_SET.has(descriptor.surface)) continue;
    if (!AVAILABILITY_SET.has(descriptor.availability)) continue;
    if (typeof descriptor.label !== "string" || !descriptor.label.trim()) continue;
    if (accepted.has(descriptor.surface)) continue;

    accepted.set(descriptor.surface, {
      surface: descriptor.surface,
      label: descriptor.label.trim(),
      availability: descriptor.availability,
      ...(typeof descriptor.reason === "string" && descriptor.reason.trim()
        ? { reason: descriptor.reason.trim() }
        : {}),
    });
  }

  return SURFACE_ORDER.flatMap((surface) => {
    const descriptor = accepted.get(surface);
    return descriptor ? [descriptor] : [];
  });
}

function disabledReason(descriptor: WorkspaceSurfaceDescriptor): string {
  if (descriptor.reason) return descriptor.reason;
  if (descriptor.availability === "unknown") {
    return `${descriptor.label} state is unknown.`;
  }
  return `${descriptor.label} is unavailable right now.`;
}

export function SurfaceControls({
  descriptors,
  selectedSurface,
  onSelect,
}: SurfaceControlsProps) {
  const controls = useMemo(() => strictDescriptors(descriptors), [descriptors]);
  const controlRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusedReason, setFocusedReason] = useState<string | null>(null);
  const selectedIndex = controls.findIndex(
    (descriptor) => descriptor.surface === selectedSurface,
  );

  function activate(
    descriptor: WorkspaceSurfaceDescriptor,
    trigger: HTMLButtonElement,
  ) {
    if (descriptor.availability !== "available") {
      setFocusedReason(disabledReason(descriptor));
      return;
    }
    setFocusedReason(null);
    onSelect(descriptor.surface, trigger);
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    descriptor: WorkspaceSurfaceDescriptor,
    index: number,
  ) {
    if (controls.length === 0) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % controls.length;
    if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + controls.length) % controls.length;
    }
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = controls.length - 1;

    if (nextIndex !== null) {
      event.preventDefault();
      controlRefs.current[nextIndex]?.focus();
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(descriptor, event.currentTarget);
    }
  }

  return (
    <div className="shrink-0 border-b border-[var(--etched-border)] bg-[var(--bg-surface)]">
      <div
        role="tablist"
        aria-label="Agent surfaces"
        className="flex min-h-[44px] min-w-0 gap-0.5 overflow-x-auto px-3.5 sm:px-3.5 [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]"
      >
        {controls.map((descriptor, index) => {
          const Icon = SURFACE_ICONS[descriptor.surface];
          const selected = descriptor.surface === selectedSurface;
          const usable = descriptor.availability === "available";
          const reason = usable ? undefined : disabledReason(descriptor);

          return (
            <button
              key={descriptor.surface}
              ref={(element) => {
                controlRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              aria-label={descriptor.label}
              aria-selected={selected}
              aria-disabled={usable ? undefined : "true"}
              aria-describedby={reason ? `surface-reason-${descriptor.surface}` : undefined}
              tabIndex={selectedIndex === -1 ? (index === 0 ? 0 : -1) : selected ? 0 : -1}
              onClick={(event) => activate(descriptor, event.currentTarget)}
              onFocus={() => setFocusedReason(reason ?? null)}
              onBlur={() => setFocusedReason(null)}
              onKeyDown={(event) => handleKeyDown(event, descriptor, index)}
              className={[
                "mono relative inline-flex min-h-[43px] shrink-0 items-center gap-1.5 border-b-2 px-3 pb-0.5 pt-0.5 text-[13px] font-semibold outline-none",
                "motion-safe:transition-colors motion-safe:duration-150 motion-reduce:transition-none",
                "focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2",
                selected && usable
                  ? "border-b-[var(--hivra-red)] bg-[var(--bg-elevated)] text-[var(--ink-black)]"
                  : "border-b-transparent text-[var(--text-muted)]",
                usable
                  ? "hover:bg-[var(--bg-elevated)] hover:text-[var(--ink-black)]"
                  : "cursor-not-allowed opacity-70",
              ].join(" ")}
            >
              <Icon aria-hidden="true" size={16} className="shrink-0" />
              <span>{descriptor.label}</span>
              {reason ? (
                <span id={`surface-reason-${descriptor.surface}`} className="sr-only">
                  {reason}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {focusedReason ? (
        <p
          role="status"
          className="border-t border-[var(--etched-border)] px-4 py-2 text-[12px] leading-[1.3] text-[var(--text-muted)] sm:px-6"
        >
          {focusedReason}
        </p>
      ) : null}
    </div>
  );
}
