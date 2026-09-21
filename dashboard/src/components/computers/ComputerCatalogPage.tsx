"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
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

import { listAgentsResult, type HivraAgent } from "@/lib/hivra/agent-api";
import { getAgent as getCatalogAgent } from "@/lib/hivra/agent-catalog";
import {
  OMARCHY_TEMPLATE,
  UBUNTU_DESKTOP_TEMPLATE,
  WINDOWS_TEMPLATE,
  getComputerTemplate,
} from "@/lib/hivra/computer-catalog";

import styles from "./ComputerCatalogPage.module.css";

function statusTone(status: string): string {
  if (status === "running") return styles.running;
  if (status === "error" || status === "failed") return styles.error;
  if (status === "provisioning" || status === "redeploying")
    return styles.working;
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

function ComputerRow({ computer }: { computer: HivraAgent }) {
  const isDesktop = getCatalogAgent(computer.type)?.resourceKind === "computer";
  const desktopQuery = computer.computer_profile === "windows"
    ? "?tab=desktop&open=fast"
    : "?tab=desktop";
  const href = `/dashboard/agent/${encodeURIComponent(computer.id)}${isDesktop ? desktopQuery : ""}`;
  return (
    <Link className={styles.computerRow} href={href}>
      <span
        className={`${styles.statusDot} ${statusTone(computer.status)}`}
        aria-hidden="true"
      />
      <span className={styles.computerIdentity}>
        <strong>{computer.name}</strong>
        <small>{computerTypeLabel(computer)}</small>
      </span>
      <span className={styles.computerMeta}>
        {computer.cpu} vCPU · {computer.ram} GB
      </span>
      <span className={styles.computerStatus}>{computer.status}</span>
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
    profile: "ubuntu-desktop" | "omarchy" | "windows",
  ) => {
    const query = new URLSearchParams(launchQuery);
    query.set("profile", profile);
    return `/dashboard/launch?${query.toString()}`;
  };
  const [hivraComputers, setHivraComputers] = useState<HivraAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [catalogOpen, setCatalogOpen] = useState(false);

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
          (filter === "all" || computer.status === filter) &&
          `${computer.name} ${computerTypeLabel(computer)}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [hivraComputers, filter, query],
  );

  useEffect(() => {
    const revealProfile = () => {
      if (["#omarchy", "#windows"].includes(window.location.hash))
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
          <p>Open your computer and return to its desktop or tools.</p>
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
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className={styles.filters} aria-label="Filter computers">
            {[
              ["all", "All"],
              ["running", "Running"],
              ["error", "Needs attention"],
              ["stopped", "Stopped"],
            ].map(([value, label]) => (
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
            <ComputerRow key={computer.id} computer={computer} />
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
        onToggle={(event) => setCatalogOpen(event.currentTarget.open)}
      >
        <summary className={styles.catalogSummary}>
          <span>
            <strong>Browse operating systems</strong>
            <small>
              Compare computer profiles when you’re ready to launch.
            </small>
          </span>
          <ArrowRight size={15} aria-hidden />
        </summary>
        <div className={styles.osGrid}>
          <article className={styles.osCard}>
            <div className={styles.osIcon}>
              <Cloud size={21} />
            </div>
            <span className={styles.availableBadge}>Available alpha</span>
            <h3>Ubuntu Desktop</h3>
            <p>{UBUNTU_DESKTOP_TEMPLATE.summary}</p>
            <div className={styles.osFacts}>
              <span>{UBUNTU_DESKTOP_TEMPLATE.requirements.cpu} CPU</span>
              <span>{UBUNTU_DESKTOP_TEMPLATE.requirements.ramGb} GB RAM</span>
              <span>Browser desktop</span>
            </div>
            <Link
              className={styles.primaryButton}
              href={profileLaunchHref("ubuntu-desktop")}
            >
              Launch Ubuntu Desktop <ArrowRight size={14} />
            </Link>
          </article>

          <article
            id="omarchy"
            className={`${styles.osCard} ${styles.previewCard}`}
          >
            <div className={styles.osIcon}>O.</div>
            <span className={styles.availableBadge}>
              Canary ready · operating system
            </span>
            <h3>Omarchy</h3>
            <p>{OMARCHY_TEMPLATE.summary}</p>
            <div className={styles.osFacts}>
              <span>{OMARCHY_TEMPLATE.requirements.cpu} CPU</span>
              <span>{OMARCHY_TEMPLATE.requirements.ramGb} GB RAM</span>
              <span>Proxmox KVM</span>
            </div>
            <div className={styles.omarchyTruth}>
              <ShieldCheck size={15} />
              <span>
                <strong>Prepared Canary computer.</strong> Opens the pinned{" "}
                {OMARCHY_TEMPLATE.upstream.release} desktop through an
                interactive browser setup console.
              </span>
            </div>
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
              <span>RDP / Guacamole</span>
            </div>
            <p>Connect compatible customer-owned or self-hosted capacity to continue.</p>
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
          <strong>Looking for Codex, Hermes, or DeepSeek Harness?</strong>
          <span>Those are agent runtimes, not operating systems.</span>
        </div>
        <Link href="/dashboard/agents">
          Open Agents <ArrowRight size={13} />
        </Link>
        <Link href="/dashboard/infrastructure">
          <Server size={13} />
          Infrastructure
        </Link>
      </section>
    </main>
  );
}
