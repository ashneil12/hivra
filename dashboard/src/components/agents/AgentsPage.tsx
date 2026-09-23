"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Bot, ChevronDown, Plus } from "lucide-react";

import {
  HivraAgentsPanel,
  type HermesInstanceLite,
} from "@/components/dashboard/command-center/HivraAgentsPanel";
import { AGENTS, getAgent as getCatalogAgent } from "@/lib/hivra/agent-catalog";
import { getHivraPreview } from "@/lib/hivra/preview-catalog";
import styles from "./AgentsPage.module.css";

const deepSeekHarness = getCatalogAgent("deepseek-harness");
const deepSeekPreview = getHivraPreview("deepseek-harness");
// Height of the opened catalog that must already show before it is scrolled to.
const CATALOG_PEEK = 120;

type InstanceSummary = {
  id: string;
  name: string;
  provider?: string | null;
  status: string;
  config?: { model?: unknown } | null;
};

export function AgentsPage() {
  const router = useRouter();
  const [hermesInstances, setHermesInstances] = useState<HermesInstanceLite[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const catalogBodyRef = useRef<HTMLDivElement>(null);

  const loadHermesInstances = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/instances?summary=true", {
        cache: "no-store",
      });
      const payload = await response.json();
      if (
        !response.ok ||
        payload?.success !== true ||
        !Array.isArray(payload.data)
      )
        throw new Error(
          payload?.error || "Could not load existing Hermes agents.",
        );
      setHermesInstances(
        (payload.data as InstanceSummary[])
          .filter((instance) => instance.status !== "deleted")
          .map((instance) => ({
            id: instance.id,
            name: instance.name,
            provider: instance.provider || undefined,
            status: instance.status,
            model:
              typeof instance.config?.model === "string"
                ? instance.config.model
                : null,
          })),
      );
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load existing Hermes agents.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHermesInstances();
  }, [loadHermesInstances]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>
            <Bot size={13} aria-hidden />
            Your workspace
          </p>
          <h1>Agents</h1>
          <p>Find your agent and return to its work.</p>
        </div>
        <Link
          className={styles.primaryButton}
          href="/dashboard/launch?kind=agent&start=1"
        >
          <Plus size={14} aria-hidden />
          Launch agent
        </Link>
      </header>
      <HivraAgentsPanel
        hermesInstances={hermesInstances}
        hermesLoading={loading}
        hermesError={error}
        onRetryHermes={() => void loadHermesInstances()}
        onOpenInstance={(id) =>
          router.push(`/dashboard/instances/${encodeURIComponent(id)}`)
        }
        onOpenConsole={(id) =>
          router.push(`/dashboard/instances/${encodeURIComponent(id)}/console`)
        }
      />
      <details
        className={styles.catalog}
        onToggle={(event) => {
          const details = event.currentTarget;
          const body = catalogBodyRef.current;
          if (!details.open || !body) return;
          // On phones the body can open below the fold (or behind the bottom
          // navigation, its scroll margin). Bring the section heading to the
          // top so the tap visibly did something and collapse stays in reach.
          const reserved =
            Number.parseFloat(getComputedStyle(body).scrollMarginBlockEnd) || 0;
          if (
            body.getBoundingClientRect().top + CATALOG_PEEK >
            window.innerHeight - reserved
          )
            details.scrollIntoView?.({ block: "start" });
        }}
      >
        <summary>
          <span>
            <strong>Browse agent runtimes</strong>
            <small>
              Explore the catalog when you’re ready to add an agent.
            </small>
          </span>
          <ChevronDown size={15} className={styles.disclosureIcon} aria-hidden />
        </summary>
        <div ref={catalogBodyRef} className={styles.catalogBody}>
          <ul className={styles.runtimeList}>
            {AGENTS.filter((agent) => agent.resourceKind !== "computer").map(
              (agent) => (
                <li key={agent.id}>
                  <strong>{agent.name}</strong>
                  <span>{agent.tagline}</span>
                  <small>
                    {agent.available ? "Available to configure" : "Unavailable"}
                  </small>
                </li>
              ),
            )}
          </ul>
          <article id="deepseek-harness" className={styles.previewRuntime}>
            <span className={styles.kicker}>Private preview</span>
            <h2>{deepSeekHarness?.name || "DeepSeek Harness"}</h2>
            <p>{deepSeekPreview?.summary || deepSeekHarness?.tagline}</p>
            <Link href="/dashboard/runtimes/deepseek-harness">
              Inspect runtime <ArrowRight size={13} aria-hidden />
            </Link>
          </article>
          <Link
            className={styles.catalogLink}
            href="/dashboard/welcome?step=agent-type"
          >
            Open full runtime catalog <ArrowRight size={13} aria-hidden />
          </Link>
        </div>
      </details>
    </main>
  );
}
