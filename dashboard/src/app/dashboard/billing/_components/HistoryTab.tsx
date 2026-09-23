'use client';

import Link from "next/link";
import type { Variants } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { BillingActivityPanel } from "@/components/billing/BillingActivityPanel";
import type { BillingController } from "../useBillingController";
import styles from "../Billing.module.css";

export function HistoryTab({ c, variants }: { c: BillingController; variants: Variants }) {
  return (
    <div className={styles.stack}>
      <BillingActivityPanel
        activity={c.activity}
        loading={c.activityLoading}
        error={c.activityError}
        variants={variants}
        managedVeniceBriefLimit={5}
      />
      <div>
        <Link href="/dashboard/billing/activity" className={`${styles.button} ${styles.secondary}`}>
          View all activity
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
