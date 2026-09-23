'use client';

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowLeft, Loader2 } from "lucide-react";

import {
  BillingActivityPanel,
  type BillingActivityData,
} from "@/components/billing/BillingActivityPanel";
import { buildHermesFadeSlideVariants } from "@/components/ui/motion";
import { clientLog } from "@/lib/client/logger";
import styles from "./activity.module.css";

// Standalone activity view. The main /dashboard/billing page truncates the
// Managed Venice activity to 5 most recent rows; this page renders the full
// stream so users can audit every entry without scrolling past plan/credits
// controls.
export default function BillingActivityPage() {
  const [activity, setActivity] = useState<BillingActivityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();
  const sectionVariants = buildHermesFadeSlideVariants(Boolean(reduceMotion), { offset: 16 });

  useEffect(() => {
    // Loading/error state is initialized via useState defaults so we don't
    // call setState synchronously inside the effect body (forbidden by
    // react-hooks/set-state-in-effect under React 19). All transitions
    // happen inside async then/catch/finally callbacks instead.
    fetch("/api/billing/activity")
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setActivity(d.data);
        } else {
          setError(d.error || "Billing activity is unavailable right now.");
        }
      })
      .catch((err) => {
        clientLog.error("Billing activity fetch failed", err, {
          source: "billing-activity-page",
        });
        setError("Billing activity is unavailable right now.");
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className={styles.page}
    >
      <header style={{ marginBottom: "2rem" }}>
        <Link href="/dashboard/billing" className={styles.backLink}>
          <ArrowLeft size={14} aria-hidden="true" />
          Back to billing
        </Link>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--btn-bg)",
              color: "var(--btn-text)",
              display: "inline-block",
            }}
          />
          <span
            className="mono"
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.2em",
              color: "var(--text-secondary)",
            }}
          >
            Billing · Activity
          </span>
        </div>
        <h1
          className="serif"
          style={{ fontSize: "clamp(2rem, 6vw, 2.75rem)", fontWeight: 300, lineHeight: 1.1 }}
        >
          Full <em>activity log</em>.
        </h1>
      </header>

      {loading && !activity ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "3rem 0" }}>
          <Loader2 size={20} style={{ opacity: 0.3, animation: "spin 1s linear infinite" }} />
        </div>
      ) : (
        <BillingActivityPanel
          activity={activity}
          loading={loading}
          error={error}
          variants={sectionVariants}
          managedVeniceBriefLimit={null}
        />
      )}
    </motion.div>
  );
}
