import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs } from "@/components/public-editorial/Editorial";
import styles from "../../components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import { buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import { loadWeekBoard, type WeekBoardLoaded } from "@/lib/week-board-github";
import type { ShippedPull, StuckPull } from "@/lib/week-board";

const WEEK_URL = `${SITE_URL}/week`;
// The root layout appends " | Hivra", so this renders as "This week | Hivra".
const TITLE = "This week";
const DESCRIPTION =
  "Pull requests merged to main this week, and open pull requests that are drafts or have had no update for 7 days.";

export const revalidate = 300;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  ...buildWebsiteMetadata({
    path: "/week",
    title: "This week | Hivra",
    description: DESCRIPTION,
  }),
};

function formatMerged(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function movingLine(count: number): string | null {
  if (count <= 0) return null;
  if (count === 1) return "1 open pull request was updated in the last 7 days and is still moving.";
  return `${count} open pull requests were updated in the last 7 days and are still moving.`;
}

function PullRow({ pull, detail }: { pull: { number: number; title: string; url: string }; detail: string }) {
  return (
    <a className={styles.row} href={pull.url} target="_blank" rel="noopener noreferrer">
      <span className={styles.rowNumber}>#{pull.number}</span>
      <h3>{pull.title}</h3>
      <span className={styles.metadata}>{detail}</span>
      <ArrowUpRight className={styles.rowArrow} size={18} aria-hidden="true" />
    </a>
  );
}

function ShippedSection({ board }: { board: WeekBoardLoaded }) {
  return (
    <section aria-labelledby="shipped-heading">
      <div className={styles.indexHead}>
        <h2 id="shipped-heading">Shipped this week</h2>
      </div>
      {board.shipped.length > 0 ? (
        <div className={styles.rows}>
          {board.shipped.map((pull: ShippedPull) => (
            <PullRow key={pull.number} pull={pull} detail={formatMerged(pull.mergedAt)} />
          ))}
        </div>
      ) : (
        <p>Nothing merged to main this week.</p>
      )}
      {board.shippedMayBeCapped ? <p>This list may be capped at 100 pull requests.</p> : null}
    </section>
  );
}

function StuckSection({ board }: { board: WeekBoardLoaded }) {
  const moving = movingLine(board.moving);
  return (
    <section aria-labelledby="stuck-heading">
      <div className={styles.indexHead}>
        <h2 id="stuck-heading">Stuck</h2>
      </div>
      {board.stuck.length > 0 ? (
        <div className={styles.rows}>
          {board.stuck.map((pull: StuckPull) => (
            <PullRow key={pull.number} pull={pull} detail={pull.reason} />
          ))}
        </div>
      ) : (
        <p>Nothing stuck.</p>
      )}
      {moving ? <p>{moving}</p> : null}
      {board.openMayBeCapped ? <p>This list may be capped at 100 pull requests.</p> : null}
    </section>
  );
}

export default async function WeekPage() {
  const board = await loadWeekBoard(new Date());

  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "This week", item: WEEK_URL },
        ],
      },
      {
        "@type": "WebPage",
        "@id": `${WEEK_URL}#webpage`,
        url: WEEK_URL,
        name: TITLE,
        description: DESCRIPTION,
        isPartOf: { "@id": `${SITE_URL}/#website` },
      },
    ],
  };

  return (
    <PublicSite className={styles.page} data-page="week">
      <StructuredData schema={schema} />
      <main className={styles.main} id="main-content">
        <Breadcrumbs items={[{ label: "This week" }]} />
        <header className={styles.masthead}>
          <span className={styles.eyebrow}>This week</span>
          <h1>What shipped, and what is stuck</h1>
          <p>
            Merges to main since Monday (UTC), and open pull requests that are drafts or have had no update for 7 days.
          </p>
          <div className={styles.changeLinks}>
            <Link href="/changelog">
              Changelog <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
            <Link href="/roadmap">
              Roadmap <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
          </div>
        </header>
        {board.ok ? (
          <>
            <ShippedSection board={board} />
            <StuckSection board={board} />
          </>
        ) : (
          <p>This page could not load. GitHub did not return the pull requests.</p>
        )}
      </main>
    </PublicSite>
  );
}
