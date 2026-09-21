"use client";

import {
  ArrowRight,
  Cloud,
  Cpu,
  Gauge,
  MemoryStick,
  Settings2,
} from "lucide-react";
import Link from "next/link";

import type { HivraCloudCapacityDto } from "@/lib/infrastructure/hivra-cloud-client";

import styles from "./Infrastructure.module.css";

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatRam(megabytes: number): string {
  const gigabytes = megabytes / 1024;
  return `${formatNumber(gigabytes)} GB`;
}

export function HivraCloudCapacityCard({
  capacity,
  onUpgrade,
}: {
  capacity: HivraCloudCapacityDto;
  onUpgrade: () => void;
}) {
  const plan = capacity.plan;
  const usage = capacity.usage;
  if (!capacity.subscribed || !plan || !usage) return null;

  const remainingCpu = Math.max(0, usage.totalCpu - usage.usedCpu);
  const remainingRam = Math.max(0, usage.totalRam - usage.usedRam);
  const isFree = plan.key === "free";

  return (
    <article className={styles.managedCapacityCard}>
      <header className={styles.managedCapacityHeader}>
        <span className={styles.managedCapacityIcon} aria-hidden="true">
          <Cloud size={22} />
        </span>
        <div>
          <span className={styles.sectionLabel}>Hivra operated</span>
          <h3>Hivra Cloud</h3>
          <p>
            Your plan&apos;s CPU and RAM allowance, shared across your managed agents.
            This is not the capacity of the underlying Proxmox hosts.
          </p>
        </div>
        <div className={styles.managedCapacityPlan}>
          <span>{plan.name}</span>
          <strong>{isFree ? "Starter capacity" : "Managed plan active"}</strong>
        </div>
      </header>

      <div className={styles.managedCapacityFacts} aria-label="Hivra Cloud capacity">
        <div>
          <Cpu size={15} aria-hidden="true" />
          <span>CPU available</span>
          <strong>{formatNumber(remainingCpu)} of {formatNumber(usage.totalCpu)}</strong>
        </div>
        <div>
          <MemoryStick size={15} aria-hidden="true" />
          <span>Memory available</span>
          <strong>{formatRam(remainingRam)} of {formatRam(usage.totalRam)}</strong>
        </div>
        <div>
          <Gauge size={15} aria-hidden="true" />
          <span>Computers</span>
          <strong>{usage.agentCount} of {usage.maxAgents}</strong>
        </div>
      </div>

      <div className={styles.managedCapacityBody}>
        <div>
          <div className={styles.managedCapacitySubhead}>
            <div>
              <span className={styles.sectionLabel}>Managed computers</span>
              <h4>{usage.instances.length > 0 ? "Already connected to your account" : "No agents use this pool yet"}</h4>
            </div>
            <Link className={styles.tertiaryButton} href="/dashboard/launch?start=1&kind=agent">
              Launch an agent <ArrowRight size={13} aria-hidden="true" />
            </Link>
            <Link className={styles.tertiaryButton} href="/dashboard/launch?start=1&kind=computer">
              Launch a computer <ArrowRight size={13} aria-hidden="true" />
            </Link>
          </div>

          {usage.instances.length > 0 ? (
            <div className={styles.managedComputerList}>
              {usage.instances.map((computer) => (
                <div
                  key={`${computer.source}-${computer.id}`}
                  className={styles.managedComputerRow}
                >
                  <span className={styles.managedComputerState} data-state={computer.status} aria-hidden="true" />
                  <span>
                    <strong>{computer.name}</strong>
                    <small>{computer.source === "hermes" ? "Hermes" : computer.type || "Hivra agent"}</small>
                  </span>
                  <span>{formatNumber(computer.cpu)} CPU</span>
                  <span>{formatRam(computer.ram)}</span>
                  <Link href={computer.source === "hermes"
                    ? `/dashboard/instances/${encodeURIComponent(computer.id)}`
                    : `/dashboard/agent/${encodeURIComponent(computer.id)}`}
                    aria-label={`Open ${computer.name}`}>
                    Open <ArrowRight size={13} aria-hidden="true" />
                  </Link>
                  {computer.source === "hivra" ? (
                    <a href={`/dashboard/agent/${encodeURIComponent(computer.id)}?tab=manage#resources`} aria-label={`Manage resources for ${computer.name}`}>
                      Manage resources
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className={styles.managedCapacityEmpty}>
              Choose an agent, then allocate a supported CPU and RAM size from this pool.
            </p>
          )}
        </div>

        <aside className={styles.managedCapacityControls}>
          <Settings2 size={18} aria-hidden="true" />
          <strong>Capacity is flexible.</strong>
          <p>
            Resize individual Hivra agents from their computer settings. Plan limits
            remain the server-side authority for every launch and resize.
          </p>
          {isFree ? (
            <button type="button" className={styles.primaryButton} onClick={onUpgrade}>
              Buy more capacity <ArrowRight size={13} aria-hidden="true" />
            </button>
          ) : (
            <Link className={styles.secondaryButton} href="/dashboard/billing">
              Manage cloud plan <ArrowRight size={13} aria-hidden="true" />
            </Link>
          )}
        </aside>
      </div>
    </article>
  );
}
