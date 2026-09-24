"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  ChevronDown,
  Cloud,
  Loader2,
  Monitor,
  Plus,
  RefreshCw,
  Server,
  Search,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";

import {
  INVENTORY_FILTERS,
  matchesInventoryFilter,
  type InventoryFilter,
} from "@/components/dashboard/command-center/HivraAgentsPanel";
import { listAgentsResult, type HivraAgent } from "@/lib/hivra/agent-api";
import { getAgent as getCatalogAgent } from "@/lib/hivra/agent-catalog";
import {
  OMARCHY_TEMPLATE,
  UBUNTU_DESKTOP_TEMPLATE,
  WINDOWS_TEMPLATE,
  getComputerTemplate,
} from "@/lib/hivra/computer-catalog";
import {
  unifiedStateLabel,
  unifyAll,
  type UnifiedAgent,
} from "@/lib/hivra/unified-agent";
import { ATTACH_NOT_AVAILABLE, attachPairLine, attachSupported } from "@/lib/agent-computers/attach-plan";

import styles from "./ComputerCatalogPage.module.css";

const PROFILE_ANCHORS = ["#linux-sandbox", "#omarchy", "#windows"];
// Height of the opened catalog that must already show before it is scrolled to.
const CATALOG_PEEK = 120;

type ComputerState = UnifiedAgent["state"];

/** Computers read the same status words as agents (Running, Starting, …). */
function computerState(computer: HivraAgent): ComputerState {
  return unifyAll([], [computer])[0].state;
}

function statusTone(state: ComputerState): string {
  if (state === "running") return styles.running;
  if (state === "error") return styles.error;
  if (state === "provisioning" || state === "updating") return styles.working;
  return styles.stopped;
}

function computerTypeLabel(computer: HivraAgent): string {
  return (
    (computer.computer_profile
      ? getComputerTemplate(computer.computer_profile)?.name
      : null) ||
    getCatalogAgent(computer.type)?.name ||
    "Cloud computer"
  );
}

function ComputerRow({ computer, addingAgent = false }: { computer: HivraAgent; addingAgent?: boolean }) {
  const isDesktop = getCatalogAgent(computer.type)?.resourceKind === "computer";
  const desktopQuery = computer.computer_profile === "windows"
    ? "?tab=desktop&open=fast"
    : "?tab=desktop";
  // Choosing a computer for an agent (Launch's "Put an agent on a computer I
  // already have") opens its Manage, where Add an agent has its own gate.
  const canTakeAgent = addingAgent && attachSupported(computer);
  const href = `/dashboard/agent/${encodeURIComponent(computer.id)}${canTakeAgent ? "?tab=manage&addAgent=1" : isDesktop ? desktopQuery : ""}`;
  const state = computerState(computer);
  return (
    <Link className={styles.computerRow} href={href}>
      <span
        className={`${styles.statusDot} ${statusTone(state)}`}
        aria-hidden="true"
      />
      <span className={styles.computerIdentity}>
        <strong>{computer.name}</strong>
        {/* Choosing a computer for an agent: the honest pair line, or why not. */}
        <small>{addingAgent ? canTakeAgent ? attachPairLine(computer.name) : ATTACH_NOT_AVAILABLE : computerTypeLabel(computer)}</small>
      </span>
      <span className={styles.computerMeta}>
        {computer.cpu} vCPU · {computer.ram} GB
      </span>
      <span className={styles.computerStatus}>{unifiedStateLabel(state)}</span>
      <ArrowRight size={15} aria-hidden="true" />
    </Link>
  );
}

export function ComputerCatalogPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const launchQuery = new URLSearchParams({ kind: "computer", start: "1" });
  for (const targetId of searchParams?.getAll("targetId") ?? [])
    launchQuery.append("targetId", targetId);
  const launchHref = `/dashboard/launch?${launchQuery.toString()}`;
  const profileLaunchHref = (
    profile: "ubuntu-desktop" | "linux-terminal" | "omarchy" | "windows",
  ) => {
    const query = new URLSearchParams(launchQuery);
    query.set("profile", profile);
    return `/dashboard/launch?${query.toString()}`;
  };
  const [hivraComputers, setHivraComputers] = useState<HivraAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<InventoryFilter>("all");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const osGridRef = useRef<HTMLDivElement>(null);
  const addingAgent = searchParams?.get("addAgent") === "1";

  useEffect(() => {
    if (searchParams?.get("launch") === "1") router.replace(launchHref);
  }, [launchHref, router, searchParams]);

  const load = useCallback(async () => {
    setLoading(true);
    const errors: string[] = [];
    const agents = await listAgentsResult();
    if (!agents.error)
      setHivraComputers(
        agents.agents.filter(
          (agent) =>
            agent.status !== "deleted" &&
            getCatalogAgent(agent.type)?.resourceKind === "computer",
        ),
      );
    if (agents.error) errors.push(agents.error);

    setLoadError(errors.length ? errors.join(" ") : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Inventory state is populated only after the API promises settle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const total = hivraComputers.length;
  const visibleComputers = useMemo(
    () =>
      hivraComputers.filter(
        (computer) =>
          matchesInventoryFilter(computerState(computer), filter) &&
          `${computer.name} ${computerTypeLabel(computer)}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [hivraComputers, filter, query],
  );

  useEffect(() => {
    const revealProfile = () => {
      if (PROFILE_ANCHORS.includes(window.location.hash))
        setCatalogOpen(true);
    };
    revealProfile();
    window.addEventListener("hashchange", revealProfile);
    return () => window.removeEventListener("hashchange", revealProfile);
  }, []);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.kicker}>
            <Monitor size={14} aria-hidden /> Your workspace
          </span>
          <h1>Computers</h1>
          <p>{addingAgent
            ? "Choose the computer to add an agent to. It works there as its own user, in your Hivra folder."
            : "Open your computer and return to its desktop or tools."}</p>
        </div>
        <Link className={styles.primaryButton} href={launchHref}>
          <Plus size={14} /> Launch computer
        </Link>
      </header>

      <section className={styles.inventory} aria-labelledby="inventory-heading">
        <div className={styles.sectionHeader}>
          <div>
            <h2 id="inventory-heading">
              Your computers{" "}
              <span className={styles.inventoryCount}>
                {(loading || loadError) && total === 0 ? "" : total}
              </span>
            </h2>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Refresh computers"
          >
            <RefreshCw
              size={14}
              className={loading ? styles.spin : undefined}
            />{" "}
            Refresh
          </button>
        </div>
        <div className={styles.toolbar}>
          <label className={styles.search}>
            <Search size={15} aria-hidden />
            <input
              type="search"
              aria-label="Search computers"
              placeholder="Find a computer…"
              enterKeyHint="search"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className={styles.filters} aria-label="Filter computers">
            {INVENTORY_FILTERS.map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {loadError ? (
          <div className={styles.loadError} role="alert">
            <AlertTriangle size={15} aria-hidden />
            <span>
              <strong>Computers could not be refreshed.</strong>
              <span>{loadError}</span>
              {total > 0 ? (
                <small>Showing the last successful inventory.</small>
              ) : null}
            </span>
            <button type="button" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : null}
        <div className={styles.computerList}>
          {visibleComputers.map((computer) => (
            <ComputerRow key={computer.id} computer={computer} addingAgent={addingAgent} />
          ))}
          {!loading && !loadError && total === 0 ? (
            <div className={styles.empty}>
              <Monitor size={20} />
              <strong>No computers yet</strong>
              <span>Choose Launch to launch your first computer.</span>
            </div>
          ) : null}
          {!loading && total > 0 && visibleComputers.length === 0 ? (
            <div className={styles.empty}>
              <strong>No matching computers</strong>
              <span>Try another name, operating system, or status.</span>
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Clear search and filters
              </button>
            </div>
          ) : null}
          {loading && total === 0 ? (
            <div className={styles.empty}>
              <Loader2 size={20} className={styles.spin} />
              <span>Loading computers…</span>
            </div>
          ) : null}
        </div>
      </section>

      <details
        className={styles.osSection}
        open={catalogOpen}
        onToggle={(event) => {
          const details = event.currentTarget;
          setCatalogOpen(details.open);
          const grid = osGridRef.current;
          if (!details.open || !grid) return;
          // A linked profile (#omarchy, #windows) is brought into view.
          const hash = window.location.hash;
          const card =
            PROFILE_ANCHORS.includes(hash) &&
            grid.querySelector<HTMLElement>(hash);
          if (card) {
            card.scrollIntoView?.({ block: "nearest" });
            return;
          }
          // On phones the grid can open below the fold (or behind the bottom
          // navigation, its scroll margin). Bring the section heading to the
          // top so the tap visibly did something and collapse stays in reach.
          const reserved =
            Number.parseFloat(getComputedStyle(grid).scrollMarginBlockEnd) || 0;
          if (
            grid.getBoundingClientRect().top + CATALOG_PEEK >
            window.innerHeight - reserved
          )
            details.scrollIntoView?.({ block: "start" });
        }}
      >
        <summary className={styles.catalogSummary}>
          <span>
            <strong>Browse operating systems</strong>
            <small>
              Compare computer profiles when you’re ready to launch.
            </small>
          </span>
          <ChevronDown size={15} className={styles.disclosureIcon} aria-hidden />
        </summary>
        <div ref={osGridRef} className={styles.osGrid}>
          <article className={styles.osCard}>
            <div className={styles.osIcon}>
              <Cloud size={21} />
            </div>
            <span className={styles.availableBadge}>Available</span>
            <h3>Ubuntu Desktop</h3>
            <p>{UBUNTU_DESKTOP_TEMPLATE.summary}</p>
            <div className={styles.osFacts}>
              <span>{UBUNTU_DESKTOP_TEMPLATE.requirements.cpu} CPU</span>
              <span>{UBUNTU_DESKTOP_TEMPLATE.requirements.ramGb} GB RAM</span>
              <span>Linux desktop in your browser</span>
            </div>
            <details className={styles.technical}>
              <summary>Technical details</summary>
              <p>
                Alpha. Ubuntu {UBUNTU_DESKTOP_TEMPLATE.upstream.release} virtual
                machine on Proxmox KVM, streamed to your browser.
              </p>
            </details>
            <Link
              className={styles.primaryButton}
              href={profileLaunchHref("ubuntu-desktop")}
            >
              Launch Ubuntu Desktop <ArrowRight size={14} />
            </Link>
          </article>

          <article id="linux-sandbox" className={styles.osCard}>
            <div className={styles.osIcon}>
              <SquareTerminal size={21} />
            </div>
            <span className={styles.availableBadge}>Available</span>
            <h3>Linux Sandbox</h3>
            <p>A small Linux computer with a terminal and no desktop, for scripts, builds and agents that only need a shell.</p>
            <div className={styles.osFacts}>
              <span>From 0.5 CPU</span>
              <span>From 1 GB RAM</span>
              <span>Terminal only</span>
            </div>
            <p>Runs on your own server once it is ready for Linux Sandbox. Add one in Capacity first.</p>
            <details className={styles.technical}>
              <summary>Technical details</summary>
              <p>Runs in a gVisor application-kernel sandbox on a server you connect.</p>
            </details>
            <Link
              className={styles.primaryButton}
              href={profileLaunchHref("linux-terminal")}
            >
              Launch Linux Sandbox <ArrowRight size={14} />
            </Link>
          </article>

          <article
            id="omarchy"
            className={`${styles.osCard} ${styles.previewCard}`}
          >
            <div className={styles.osIcon}>O.</div>
            <span className={styles.previewBadge}>Preview</span>
            <h3>Omarchy</h3>
            <p>{OMARCHY_TEMPLATE.summary}</p>
            <div className={styles.osFacts}>
              <span>{OMARCHY_TEMPLATE.requirements.cpu} CPU</span>
              <span>{OMARCHY_TEMPLATE.requirements.ramGb} GB RAM</span>
              <span>Full Linux desktop in your browser</span>
            </div>
            <details className={styles.technical}>
              <summary>Technical details</summary>
              <div className={styles.omarchyTruth}>
                <ShieldCheck size={15} aria-hidden />
                <span>
                  <strong>Prepared computer.</strong> Opens the pinned{" "}
                  {OMARCHY_TEMPLATE.upstream.release} desktop through an
                  interactive browser setup console. Runs on Proxmox KVM.
                </span>
              </div>
            </details>
            <Link
              className={styles.primaryButton}
              href={profileLaunchHref("omarchy")}
            >
              Launch Omarchy <ArrowRight size={14} />
            </Link>
          </article>

          <article
            id="windows"
            className={`${styles.osCard} ${styles.futureCard}`}
          >
            <div className={styles.osIcon}>
              <SquareTerminal size={21} />
            </div>
            <h3>Windows</h3>
            <p>{WINDOWS_TEMPLATE.summary}</p>
            <div className={styles.osFacts}>
              <span>{WINDOWS_TEMPLATE.requirements.cpu} CPU</span>
              <span>{WINDOWS_TEMPLATE.requirements.ramGb} GB RAM</span>
              <span>Remote Windows desktop</span>
            </div>
            <p>Needs your own server that can run Windows. Add one in Capacity first.</p>
            <details className={styles.technical}>
              <summary>Technical details</summary>
              <p>Browser access uses RDP through Guacamole.</p>
            </details>
            <Link
              className={styles.primaryButton}
              href={profileLaunchHref("windows")}
            >
              Launch Windows <ArrowRight size={14} />
            </Link>
          </article>
        </div>
      </details>

      <section className={styles.agentNote}>
        <Bot size={18} />
        <div>
          <strong>Looking for Codex, Claude Code or Hermes?</strong>
          <span>Agents run on their own computer. Open them, and their computer, from Agents.</span>
        </div>
        <Link href="/dashboard/agents">
          Open Agents <ArrowRight size={13} />
        </Link>
        <Link href="/dashboard/infrastructure">
          <Server size={13} />
          Capacity
        </Link>
      </section>
    </main>
  );
}
