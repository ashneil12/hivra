"use client";

import { Bot, Monitor, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState, type RefObject } from "react";

import { AgentSwitcherMenu } from "@/components/workspace/AgentSwitcherMenu";
import { useWorkspaceAgents } from "@/components/workspace/useWorkspaceAgents";
import styles from "./WorkspaceIdentity.module.css";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";

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
 * here: the URL is the state.
 */
export interface ResourceSwitcherProps {
  /** uid of the resource currently shown, so the menu can mark it. */
  currentUid: string | null;
  name?: string;
  kind?: "agent" | "computer";
  status?: string;
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
  return agent.kind === "hermes"
    ? `/dashboard/instances/${encodeURIComponent(agent.id)}`
    : `/dashboard/agent/${encodeURIComponent(agent.id)}`;
}

export function ResourceSwitcher({ currentUid, name, kind, status }: ResourceSwitcherProps) {
  const router = useRouter();
  const [opened, setOpened] = useState(false);

  return (
    <ResourceSwitcherTrigger
      currentUid={currentUid}
      name={name}
      kind={kind}
      status={status}
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
  router,
  opened,
  onFirstOpen,
}: {
  currentUid: string | null;
  name?: string;
  kind?: "agent" | "computer";
  status?: string;
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
        aria-label={name ? `Switch agent or computer: ${name}` : "Switch runtime"}
        // The label replaces the visible copy, so the status rides along as
        // the description; narrow hosts also hide its word.
        aria-describedby={name && status ? statusId : undefined}
        title={name ? `Switch from ${name}` : "Switch runtime"}
        onClick={toggle}
        className={styles.switcher}
      >
        {name ? <>
          {kind === "computer" ? <Monitor size={18} aria-hidden /> : <Bot size={18} aria-hidden />}
          {/* Parts are tagged so a narrow host can fold this onto one line
              (name, then a status dot and word) without a second markup. */}
          <span className={styles.copy}><strong>{name}</strong><small>
            <span data-switcher-part="kind">{kind === "computer" ? "Computer" : "Agent"}</span>
            {status ? <><span data-switcher-part="separator" aria-hidden="true"> · </span><span id={statusId} data-switcher-part="status" data-tone={statusTone(status)}>{status}</span></> : null}
          </small></span>
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
  const workspaceAgents = useWorkspaceAgents();

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
      onSelect={(agent) => {
        onClose();
        router.push(agentHref(agent));
      }}
      onClose={onClose}
      onRetryHermes={() => void workspaceAgents.retryHermes()}
      onRetryHivra={() => void workspaceAgents.retryHivra()}
    />
  );
}
