"use client";

import Link from "next/link";
import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";

import { RollingNumber } from "@/components/ui/RollingNumber";
import { useAgentsDeployedPolling } from "@/hooks/useAgentsDeployedPolling";
import { useLocale } from "@/components/i18n/LocaleProvider";

interface Stats {
  total: number;
  last24h: number;
  last7d: number;
}

/**
 * Compact, live "agents deployed" readout for the hero — strong social proof,
 * placed under the CTAs. Polls the same endpoint as the /stats counter; the
 * whole readout links through to the full stats page.
 */
export default function AgentsDeployedStatClient({ initial }: { initial: Stats | null }) {
  const reduceMotion = useReducedMotion();
  const { copy, locale } = useLocale();
  const t = copy.stats.hero;
  const { stats, bumped } = useAgentsDeployedPolling({ initial });

  const total = stats?.total ?? null;
  const last24h = stats?.last24h ?? null;

  const todayWord = useMemo(() => {
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "day");
    } catch {
      return "today";
    }
  }, [locale]);

  return (
    <Link
      href="/stats"
      aria-label={
        total === null
          ? t.label
          : `${total.toLocaleString(locale)} ${t.label} — ${t.fullStats.replace("→", "").trim()}`
      }
      className="agents-deployed-stat"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: "10px 16px",
        border: "1px solid var(--etched-border)",
        background: "var(--hivra-red-soft)",
        textDecoration: "none",
        color: "var(--ink-black)",
      }}
    >
      <motion.span
        aria-hidden="true"
        animate={reduceMotion ? undefined : { opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: "#16c66a",
          boxShadow: "0 0 8px #16c66a",
          flexShrink: 0,
        }}
      />

      {total === null ? (
        <span className="serif" style={{ fontSize: "1.5rem", fontWeight: 700, color: "var(--text-muted)", lineHeight: 1 }}>
          —
        </span>
      ) : (
        <motion.span
          animate={bumped && !reduceMotion ? { scale: [1, 1.06, 1] } : undefined}
          transition={{ duration: 0.5, ease: "easeOut" }}
          style={{ display: "inline-flex" }}
        >
          <RollingNumber
            value={total}
            locale={locale}
            ariaLabel={`${total.toLocaleString(locale)} ${t.label}`}
            className="serif"
            style={{ fontSize: "1.55rem", fontWeight: 700, color: "var(--ink-black)", lineHeight: 1, letterSpacing: "-0.01em" }}
          />
        </motion.span>
      )}

      <span style={{ fontSize: "0.9rem", color: "var(--text-secondary)", fontWeight: 500 }}>
        {t.label}
        {last24h !== null && last24h > 0 && (
          <>
            {" "}
            <span style={{ color: "var(--gold-leaf)", fontWeight: 700 }}>
              +{last24h.toLocaleString(locale)} {todayWord}
            </span>
          </>
        )}
      </span>

      <span
        className="mono"
        style={{
          marginLeft: "auto",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          fontWeight: 700,
          color: "var(--text-muted)",
          whiteSpace: "nowrap",
        }}
      >
        {t.fullStats}
      </span>
    </Link>
  );
}
