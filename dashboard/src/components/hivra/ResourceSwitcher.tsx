"use client";

import { Bot, Monitor, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, type RefObject } from "react";

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
  const [open, setOpen] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
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
        title={name ? `Switch from ${name}` : "Switch runtime"}
        onClick={toggle}
        className={styles.switcher}
      >
        {name ? <>
          {kind === "computer" ? <Monitor size={18} aria-hidden /> : <Bot size={18} aria-hidden />}
          <span className={styles.copy}><strong>{name}</strong><small>{kind === "computer" ? "Computer" : "Agent"}{status ? ` · ${status}` : ""}</small></span>
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
  onClose: () => void;
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
