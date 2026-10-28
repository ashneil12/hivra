import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AGENTS_STAT } from "@/components/landing/home/content";
import { formatAsOf, type AgentsDeployedSnapshot } from "@/components/landing/home/agents-deployed-format";
import styles from "@/components/landing/home/home.module.css";

/**
 * The hero's live count of launches, linking to /stats. Plain server HTML: the
 * number and its date arrive as props from the page (read once, cached, on the
 * server), and nothing renders when there is no count to show.
 */
export default function AgentsDeployedStat({ total, asOf }: Partial<AgentsDeployedSnapshot>) {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0 || !asOf) return null;
  const count = total.toLocaleString("en-GB");
  const date = formatAsOf(asOf);
  return (
    <Link href={AGENTS_STAT.href} className={styles.stat} data-cta="hero-stat" aria-label={`${count} ${AGENTS_STAT.label}, ${AGENTS_STAT.asOf} ${date}. ${AGENTS_STAT.link}`}>
      <strong>{count}</strong>
      <span className={styles.statLabel}>
        {AGENTS_STAT.label}
        <small>
          {AGENTS_STAT.asOf} {date}
        </small>
      </span>
      <span className={styles.statLink}>
        {AGENTS_STAT.link}
        <ArrowRight size={14} aria-hidden="true" />
      </span>
    </Link>
  );
}
