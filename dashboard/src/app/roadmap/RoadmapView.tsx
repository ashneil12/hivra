import PublicSite from "@/components/public-site/PublicSite";
import { ActionLinks, type ActionLink } from "@/components/public-editorial/ActionLinks";
import { Breadcrumbs } from "@/components/public-editorial/Editorial";
import styles from "@/components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import { LITEPAPER_HREF } from "@/components/public-site/PublicLink";
import { Inline } from "@/lib/inline-copy";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import {
  ROADMAP_REPOSITORY_URL,
  type ResolvedBlock,
  type ResolvedRoadmap,
  type ResolvedSection,
  type ResolvedStage,
  type RoadmapAction,
} from "@/lib/roadmap-content";
import { SITE_URL } from "@/lib/seo-urls";
import local from "./roadmap.module.css";

// Where each {placeholder} in the copy points. The litepaper link is only ever in the copy
// of a viewer who may see token surfaces, so a hidden viewer never receives it.
const HREFS: Record<string, string> = {
  start: PUBLIC_START_HREF,
  litepaper: LITEPAPER_HREF,
  repository: ROADMAP_REPOSITORY_URL,
};

function resolveHref(href: string): string {
  return href.replace(/^\{(\w+)\}$/, (whole, name: string) => HREFS[name] ?? whole);
}

function toActionLinks(actions: RoadmapAction[]): ActionLink[] {
  return actions.map(({ label, href, kind }) => ({ label, href: resolveHref(href), kind }));
}

function Block({ block }: { block: ResolvedBlock }) {
  if (block.kind === "text") {
    return (
      <p className={local.prose}>
        <Inline text={block.text} hrefs={HREFS} />
      </p>
    );
  }
  if (block.kind === "terms") {
    return (
      <ul className={local.terms}>
        {block.items.map((item) => (
          <li key={item}>
            <Inline text={item} hrefs={HREFS} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className={local.topic} data-topic={block.id}>
      <h3>{block.heading}</h3>
      <div>
        {block.paragraphs.map((paragraph) => (
          <p key={paragraph}>
            <Inline text={paragraph} hrefs={HREFS} />
          </p>
        ))}
      </div>
    </div>
  );
}

function Stage({ stage }: { stage: ResolvedStage }) {
  const headingId = `roadmap-${stage.id}`;
  return (
    <section className={local.stage} data-stage={stage.id} aria-labelledby={headingId}>
      <h2 id={headingId}>
        <span className={local.marker} aria-hidden="true" />
        {stage.heading}
      </h2>
      <div className={local.stageBody}>
        {stage.blocks.map((block, index) => (
          <Block key={`${block.kind}-${index}`} block={block} />
        ))}
      </div>
    </section>
  );
}

function Row({ section, className }: { section: ResolvedSection; className?: string }) {
  const headingId = `roadmap-${section.id}`;
  return (
    <section className={[local.row, className].filter(Boolean).join(" ")} aria-labelledby={headingId}>
      <h2 id={headingId} className={local.rowTitle}>
        {section.heading}
      </h2>
      <div className={local.rowBody}>
        {section.paragraphs.map((paragraph) => (
          <p key={paragraph}>
            <Inline text={paragraph} hrefs={HREFS} />
          </p>
        ))}
        <ActionLinks items={toActionLinks(section.actions)} />
      </div>
    </section>
  );
}

export interface RoadmapViewProps {
  roadmap: ResolvedRoadmap;
  /** The HIVRA_NEW_TOKEN_SURFACES switch, for the shared header and footer (not the geo decision). */
  tokenSurfaces: boolean;
  title: string;
  description: string;
}

export default function RoadmapView({ roadmap, tokenSurfaces, title, description }: RoadmapViewProps) {
  const url = `${SITE_URL}/roadmap`;
  const schema = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: "Roadmap", item: url },
        ],
      },
      {
        "@type": "WebPage",
        "@id": `${url}#webpage`,
        url,
        name: title,
        description,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        about: { "@type": "SoftwareApplication", name: "Hivra" },
      },
    ],
  };

  const { masthead, stages, history, progress, closing } = roadmap;
  return (
    <PublicSite className={styles.page} data-page="roadmap" tokenSurfaces={tokenSurfaces}>
      <StructuredData schema={schema} />
      <main className={`${styles.main} ${local.end}`} id="main-content">
        <Breadcrumbs items={[{ label: "Roadmap" }]} />
        <header className={`${styles.masthead} ${local.masthead}`}>
          <h1>{masthead.heading}</h1>
          {masthead.paragraphs.map((paragraph) => (
            <p key={paragraph}>
              <Inline text={paragraph} hrefs={HREFS} />
            </p>
          ))}
          <ActionLinks items={toActionLinks(masthead.actions)} />
        </header>
        <div className={`${styles.articleBody} ${local.stages}`}>
          {stages.map((stage) => (
            <Stage key={stage.id} stage={stage} />
          ))}
        </div>
        <div className={`${styles.articleBody} ${local.after}`}>
          <Row section={history} className={local.archive} />
          <Row section={progress} />
          <Row section={closing} className={local.closing} />
        </div>
      </main>
    </PublicSite>
  );
}
