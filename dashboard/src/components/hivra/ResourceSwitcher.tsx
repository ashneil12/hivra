"use client";

import { Bot, Monitor, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState, type RefObject } from "react";

import { AgentSwitcherMenu } from "@/components/workspace/AgentSwitcherMenu";
import { useWorkspaceAgents } from "@/components/workspace/useWorkspaceAgents";
import styles from "./WorkspaceIdentity.module.css";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";
import { listRecents, recentHref } from "@/lib/workspace/recents";
import { fleetEntryHref } from "@/lib/hivra/fleet-sections";

/**
 * The fleet switcher, on the canonical resource route.
 *
 * The dropdown that replaced the sidebar lived inside UnifiedWorkspace, which is
 * the route the merge retired. Without this, merging the routes would have
 * quietly deleted the switcher: the "Chat" nav item would land on one agent with
 * no way to reach another except the back button.
 *
 * It is the same AgentSwitcherMenu and the same useWorkspaceAgents hook the
 * workspace used — the picker is not reimplemented, just re-hosted, so its
 * behaviour (search, Agents/Computers grouping, per-source retry, Add agent,
 * click-away and Escape dismissal) is identical.
 *
 * Selecting a different resource navigates rather than swapping in place,
 * because every resource is its own route. `router.push` is the honest model
 * here: the URL is the state. Each one reopens on the surface you last left it
 * on, and the ones you used recently are listed first.
 */
export interface ResourceSwitcherProps {
  /** uid of the resource currently shown, so the menu can mark it. */
  currentUid: string | null;
  name?: string;
  kind?: "agent" | "computer";
  status?: string;
  /**
   * Whether the caption names the kind ("Agent · Running"). A host whose bar
   * already has a button with that word passes false, so the caption keeps
   * only the status instead of saying it twice.
   */
  showKind?: boolean;
}

/** The kind word the caption shows, so a host can tell when it already says it. */
export function resourceKindLabel(kind?: "agent" | "computer"): string {
  return kind === "computer" ? "Computer" : "Agent";
}

/** Colour family for the status word; unknown in-progress labels read as busy. */
export function statusTone(status: string): "ok" | "busy" | "off" | "error" {
  const value = status.trim().toLowerCase();
  if (value === "running") return "ok";
  if (value === "error" || value === "failed") return "error";
  if (value === "stopped" || value === "suspended" || value === "paused") return "off";
  return "busy";
}

function agentHref(agent: UnifiedAgent): string {
  // An agent added to a computer opens that computer's Chat tab, not its Desktop.
  if (agent.attachment) return fleetEntryHref(agent);
  return agent.kind === "hermes"
    ? `/dashboard/instances/${encodeURIComponent(agent.id)}`
    : `/dashboard/agent/${encodeURIComponent(agent.id)}`;
}

export function ResourceSwitcher({ currentUid, name, kind, status, showKind = true }: ResourceSwitcherProps) {
  const router = useRouter();
  const [opened, setOpened] = useState(false);

  return (
    <ResourceSwitcherTrigger
      currentUid={currentUid}
      name={name}
      kind={kind}
      status={status}
      showKind={showKind}
      router={router}
      onFirstOpen={() => setOpened(true)}
      opened={opened}
    />
  );
}

/**
 * The trigger, split out so the fleet list is fetched only once the menu is
 * actually opened.
 *
 * Rendering the switcher used to mount useWorkspaceAgents unconditionally, which
 * meant every resource page fired two extra requests (instances + hivra agents)
 * on load — a fleet-wide list nobody asked for, on a page that renders one
 * resource. It also collided with the page's own fetch-driven failure paths,
 * consuming the responses their tests stand in for. Deferring the hook behind
 * the first open fixes both.
 */
function ResourceSwitcherTrigger({
  currentUid,
  name,
  kind,
  status,
  showKind,
  router,
  opened,
  onFirstOpen,
}: {
  currentUid: string | null;
  name?: string;
  kind?: "agent" | "computer";
  status?: string;
  showKind: boolean;
  router: ReturnType<typeof useRouter>;
  opened: boolean;
  onFirstOpen: () => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const statusId = useId();
  const [open, setOpen] = useState(false);

  // Focus returns to the trigger only when it would otherwise be lost with
  // the menu. A click into a Terminal or Desktop frame, or onto another
  // control, keeps the focus it took.
  const close = useCallback((options?: { restoreFocus?: boolean }) => {
    setOpen(false);
    if (options?.restoreFocus === false) return;
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      triggerRef.current?.focus();
    }, 0);
  }, []);

  const toggle = useCallback(() => {
    setOpen((value) => {
      if (!value) onFirstOpen();
      return !value;
    });
  }, [onFirstOpen]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={name ? `Switch agent or computer: ${name}` : "Switch agent or computer"}
        // The label replaces the visible copy, so the status rides along as
        // the description; narrow hosts also hide its word.
        aria-describedby={name && status ? statusId : undefined}
        title={name ? `Switch from ${name}` : "Switch agent or computer"}
        onClick={toggle}
        className={styles.switcher}
      >
        {name ? <>
          {kind === "computer" ? <Monitor size={18} aria-hidden /> : <Bot size={18} aria-hidden />}
          {/* Parts are tagged so a narrow host can fold this onto one line
              (name, then a status dot and word) without a second markup. */}
          <span className={styles.copy}><strong>{name}</strong>{showKind || status ? <small>
            {showKind ? <span data-switcher-part="kind">{resourceKindLabel(kind)}</span> : null}
            {status ? <>{showKind ? <span data-switcher-part="separator" aria-hidden="true"> · </span> : null}<span id={statusId} data-switcher-part="status" data-tone={statusTone(status)}>{status}</span></> : null}
          </small> : null}</span>
        </> : <span>Switch</span>}
        <ChevronDown aria-hidden="true" size={12} className="shrink-0 text-[var(--text-muted)]" />
      </button>

      {/* Only mounted once opened, so the hook below never runs for a page
          nobody has asked to leave. */}
      {opened ? (
        <ResourceSwitcherMenu
          open={open}
          currentUid={currentUid}
          router={router}
          triggerRef={triggerRef}
          onClose={close}
        />
      ) : null}
    </>
  );
}

function ResourceSwitcherMenu({
  open,
  currentUid,
  router,
  triggerRef,
  onClose,
}: {
  open: boolean;
  currentUid: string | null;
  router: ReturnType<typeof useRouter>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: (options?: { restoreFocus?: boolean }) => void;
}) {
  // Fetches only while this component is mounted, i.e. after the first open.
  // A menu: it lists what is held at once, and reads again behind it only
  // when that is more than a few seconds old.
  const workspaceAgents = useWorkspaceAgents({ reuseHeldList: true });
  // Read at each open, so the Recent group includes the resource just left.
  const [recents, setRecents] = useState(listRecents);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setRecents(listRecents());
  }

  // The route carries a raw backing id while the fleet list speaks
  // source-qualified uids (`x-<id>`), so accept either or the menu opens with
  // nothing marked and no way to see where you are.
  const matched = workspaceAgents.agents.find(
    (agent) => agent.uid === currentUid || agent.id === currentUid,
  );

  return (
    <AgentSwitcherMenu
      open={open}
      agents={workspaceAgents.agents}
      selectedUid={matched?.uid ?? null}
      loading={workspaceAgents.loading}
      hermesError={workspaceAgents.hermesError}
      hivraError={workspaceAgents.hivraError}
      anchorRef={triggerRef}
      recents={recents}
      onSelect={(agent) => {
        onClose();
        router.push(recentHref(agent.uid, agentHref(agent)));
      }}
      onClose={onClose}
      onRetryHermes={() => void workspaceAgents.retryHermes()}
      onRetryHivra={() => void workspaceAgents.retryHivra()}
    />
  );
}
