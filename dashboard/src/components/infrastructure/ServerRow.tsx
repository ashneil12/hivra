"use client";

import { ChevronDown, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { StatusText } from "@/components/ui/StatusText";
import type { HivraCloudCapacityDto } from "@/lib/infrastructure/hivra-cloud-client";

import styles from "./Infrastructure.module.css";

export type ServerRowMenuItem = {
  label: string;
  onSelect: () => void;
  /** Destructive items read red. */
  danger?: boolean;
};

export type ServerStatusTone = "ok" | "busy" | "error" | "off";

/**
 * One server as one calm line: its name, where it runs, a status word and the
 * one thing to do next. Everything else lives behind "More" (the occasional
 * actions) and "Details" (the full technical card, handed in as children).
 */
export function ServerRow({
  name,
  provider,
  status,
  tone,
  action,
  menu,
  defaultOpen = false,
  children,
}: {
  name: string;
  provider: string;
  status: string;
  tone: ServerStatusTone;
  /** The main action. A button or link; null when there is none yet. */
  action: ReactNode;
  menu: readonly ServerRowMenuItem[];
  /** Open the Details on first render, e.g. when the server needs attention. */
  defaultOpen?: boolean;
  /** The technical card: IDs, versions, raw states. */
  children: ReactNode;
}) {
  const [detailsOpen, setDetailsOpen] = useState(defaultOpen);
  const detailsId = useId();
  return (
    <article className={styles.serverRow} aria-label={`${name}, ${provider}`}>
      <div className={styles.serverRowMain}>
        <div className={styles.serverRowName}>
          <strong>{name}</strong>
          <small>{provider}</small>
        </div>
        <StatusText value={status} className={styles.serverRowStatus} data-tone={tone} />
        <div className={styles.serverRowActions}>
          {action}
          <MoreMenu name={name} items={menu} />
          <button
            type="button"
            className={styles.serverRowToggle}
            aria-expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((current) => !current)}
          >
            Details <ChevronDown size={14} aria-hidden="true" data-open={detailsOpen} />
          </button>
        </div>
      </div>
      <div
        id={detailsId}
        className={detailsOpen ? styles.serverRowDetails : `${styles.serverRowDetails} ${styles.serverRowDetailsClosed}`}
      >
        {children}
      </div>
    </article>
  );
}

function MoreMenu({ name, items }: { name: string; items: readonly ServerRowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  if (items.length === 0) return null;
  return (
    <div
      ref={root}
      className={styles.serverMore}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={styles.serverMoreTrigger}
        aria-label={`More actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>
      {open ? (
        <ul id={menuId} role="menu" aria-label={`Actions for ${name}`} className={styles.serverMoreMenu}>
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                data-danger={item.danger ? "true" : undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Hivra Cloud, in one line: the plan, what is in use, and a way up when there
 * is one. The managed computers it hosts are listed on Home.
 */
export function HivraCloudLine({
  capacity,
  onUpgrade,
}: {
  capacity: HivraCloudCapacityDto;
  onUpgrade: () => void;
}) {
  const { plan, usage } = capacity;
  if (!capacity.subscribed || !plan || !usage) return null;
  const isFree = plan.key === "free";
  const canUpgradeInPlace = !isFree && plan.canChangePlanInPlace && plan.source === "stripe";
  return (
    <section className={styles.cloudLine} aria-label="Hivra Cloud">
      <strong>Hivra Cloud</strong>
      <span>{plan.name}</span>
      <span className={styles.cloudLineUse}>
        {usage.agentCount} of {usage.maxAgents} computers in use
        {" · "}
        {formatNumber(usage.usedCpu)} of {formatNumber(usage.totalCpu)} CPU
      </span>
      {isFree ? (
        <button type="button" className={styles.cloudLineLink} onClick={onUpgrade}>Upgrade</button>
      ) : canUpgradeInPlace ? (
        <Link className={styles.cloudLineLink} href="/dashboard/billing">Upgrade</Link>
      ) : null}
    </section>
  );
}
