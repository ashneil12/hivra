import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import editorial from "@/components/public-editorial/secondary-site.module.css";
import { TOOLS_CLOSING, TOOLS_CTA } from "@/lib/tools/tool-catalog";
import styles from "./tools.module.css";

// Closing call to action for the /tools pages. EditorialCTA carries a speed
// claim and a single button; these pages need a secondary /pricing link and
// describe the plan by price and size, because checkout and the public ladder
// still use different plan names. The words are TOOLS_CLOSING, the same on every
// tools page (see the note there).
export default function ToolsCta({ title }: { title: ReactNode }) {
  return (
    <section className={editorial.cta} aria-label="Get started">
      <div className={styles.ctaCopy}>
        <h2>{title}</h2>
        <p>
          {TOOLS_CLOSING.offer} {TOOLS_CLOSING.staysOn} {TOOLS_CLOSING.aiUsage} {TOOLS_CLOSING.claudeCodeSignIn}{" "}
          {TOOLS_CLOSING.guaranteeLead}{" "}
          <Link href={TOOLS_CLOSING.guaranteeHref}>{TOOLS_CLOSING.guarantee}</Link>.
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
