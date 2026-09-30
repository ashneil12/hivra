import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import editorial from "@/components/public-editorial/secondary-site.module.css";
import { TOOLS_CTA } from "@/lib/tools/tool-catalog";
import styles from "./tools.module.css";

// Closing call to action for the /tools pages. EditorialCTA carries a speed
// claim and a single button; these pages need a secondary /pricing link and
// describe the plan by price and size, because checkout and the public ladder
// still use different plan names.
export default function ToolsCta({ title }: { title: ReactNode }) {
  return (
    <section className={editorial.cta} aria-label="Get started">
      <div>
        <h2>{title}</h2>
        <p>
          From $9.99/mo for 2 vCPU and 4 GB, not paused for inactivity. Your own Claude or ChatGPT login, or your own
          model key. 7-day money-back guarantee on card payments.
        </p>
      </div>
      <div className={styles.actions}>
        <Link href={TOOLS_CTA.primaryHref} className={styles.primaryButton}>
          Get started
          <ArrowUpRight size={20} aria-hidden="true" />
        </Link>
        <Link href={TOOLS_CTA.secondaryHref} className={styles.secondaryButton}>
          See pricing
          <ArrowUpRight size={20} aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
