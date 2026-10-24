import type { Metadata } from "next";
import type { ReactElement } from "react";

import PublicSite from "@/components/public-site/PublicSite";
import ActionLinks, { type ActionLink } from "@/components/public-editorial/ActionLinks";
import { Breadcrumbs } from "@/components/public-editorial/Editorial";
import TokenSurfaceGate from "@/components/public-editorial/TokenSurfaceGate";
import baseStyles from "@/components/public-editorial/secondary-site.module.css";
import StructuredData from "@/components/StructuredData";
import { getTokenSurfaceView, tokenSurfacesVisible } from "@/lib/compliance/token-surface-view";
import {
  ECOSYSTEM_STAGES,
  ecosystemProductSlug,
  type EcosystemProduct,
  type EcosystemStage,
} from "@/lib/ecosystem-map";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import {
  AGENT_COMPUTERS_LINKS,
  COMPUTER_ROADMAP,
  FIT,
  FOLLOW,
  INTRO,
  LAUNCHPAD_SECTION,
  TOKEN_SECTION,
} from "./ecosystem-content";
import { renderInline } from "./inline";
import styles from "./ecosystem.module.css";

// Copy: Ash's website pack, 05-ecosystem.md (20 October 2026), word for word. The map is in
// lib/ecosystem-map.ts and the prose in ecosystem-content.ts. The browser title is finished
// copy, so it skips the layout's "%s | Hivra" template (absoluteTitle).
const TITLE = "Hivra Ecosystem | What exists, what's next and what's being explored";
const DESCRIPTION =
  "A clear view of Hivra Agent Computers and the planned ecosystem, from permissions and security testing to tools, agent identity and coordinated work.";

export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/ecosystem", title: TITLE, description: DESCRIPTION }),
};

const ECOSYSTEM_URL = `${SITE_URL}/ecosystem`;

// Breadcrumb and page only. No Product, ItemList or FAQ node: a name on this map is not a product that exists.
const ecosystemSchema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Ecosystem", item: ECOSYSTEM_URL },
      ],
    },
    {
      "@type": "WebPage",
      "@id": `${ECOSYSTEM_URL}#webpage`,
      url: ECOSYSTEM_URL,
      name: TITLE,
      description: DESCRIPTION,
      isPartOf: { "@id": `${SITE_URL}/#website` },
    },
  ],
};

/** A product name that has its own section on this page links to it. */
function hrefForProductName(name: string): string | undefined {
  const slug = ecosystemProductSlug(name);
  return slug ? `#${slug}` : undefined;
}

function secondary(links: readonly { label: string; href: string }[]): ActionLink[] {
  return links.map((link) => ({ ...link, kind: "secondary" as const }));
}

function StageMarker({ stage }: { stage: EcosystemStage["id"] }) {
  return <i className={styles.marker} data-stage={stage} aria-hidden="true" />;
}

/** "Next: Make individual agents more useful and accountable", or just "Available now". */
function StageHeading({ stage }: { stage: EcosystemStage }) {
  return (
    <h2 id={`${stage.id}-heading`} className={styles.stageHeading}>
      <span className={styles.stageLabel}>
        <StageMarker stage={stage.id} />
        {stage.title ? `${stage.label}:` : stage.label}
      </span>
      {stage.title ? (
        <>
          {" "}
          <span className={styles.stageTitle}>{stage.title}</span>
        </>
      ) : null}
    </h2>
  );
}

function Tagline({ product }: { product: EcosystemProduct }) {
  return (
    <p className={styles.tagline}>
      <strong>{product.tagline}</strong>
    </p>
  );
}

function Paragraphs({ product }: { product: EcosystemProduct }) {
  return (
    <>
      {product.paragraphs.map((paragraph) => (
        <p key={paragraph} className={styles.body}>
          {renderInline(paragraph)}
        </p>
      ))}
    </>
  );
}

function AvailableNow({ stage }: { stage: EcosystemStage }) {
  const [product] = stage.products;
  const [primary, ...rest] = AGENT_COMPUTERS_LINKS;
  return (
    <section id={stage.id} aria-labelledby={`${stage.id}-heading`} className={styles.live}>
      <StageHeading stage={stage} />
      <article id={product.slug} aria-labelledby={`${product.slug}-name`} className={styles.liveGrid}>
        <div>
          <h3 id={`${product.slug}-name`} className={styles.liveName}>
            {product.name}
          </h3>
          <Tagline product={product} />
        </div>
        <div className={styles.liveCopy}>
          <Paragraphs product={product} />
          <ActionLinks items={[{ ...primary, kind: "primary" }, ...secondary(rest)]} label="Agent Computers links" />
        </div>
      </article>
    </section>
  );
}

function Next({ stage }: { stage: EcosystemStage }) {
  return (
    <section id={stage.id} aria-labelledby={`${stage.id}-heading`} className={styles.nextStage}>
      <div className={styles.rail}>
        <StageHeading stage={stage} />
        {stage.intro ? <p className={styles.stageIntro}>{renderInline(stage.intro)}</p> : null}
      </div>
      <div className={styles.stack}>
        {stage.products.map((product) => (
          <article key={product.slug} id={product.slug} aria-labelledby={`${product.slug}-name`} className={styles.entry}>
            <h3 id={`${product.slug}-name`} className={styles.entryName}>
              {product.name}
            </h3>
            <Tagline product={product} />
            <Paragraphs product={product} />
          </article>
        ))}
      </div>
    </section>
  );
}

function Then({ stage }: { stage: EcosystemStage }) {
  return (
    <section id={stage.id} aria-labelledby={`${stage.id}-heading`} className={styles.thenStage}>
      <div className={styles.thenHead}>
        <StageHeading stage={stage} />
        {stage.intro ? <p className={styles.stageIntro}>{renderInline(stage.intro)}</p> : null}
      </div>
      <div className={styles.grid}>
        {stage.products.map((product) => (
          <article key={product.slug} id={product.slug} aria-labelledby={`${product.slug}-name`} className={styles.cell}>
            <h3 id={`${product.slug}-name`} className={styles.cellName}>
              {product.name}
            </h3>
            <Tagline product={product} />
            <Paragraphs product={product} />
          </article>
        ))}
      </div>
    </section>
  );
}

function Research({ stage }: { stage: EcosystemStage }) {
  return (
    <section id={stage.id} aria-labelledby={`${stage.id}-heading`} className={styles.researchStage}>
      <StageHeading stage={stage} />
      <div className={styles.rows}>
        {stage.products.map((product) => (
          <article key={product.slug} id={product.slug} aria-labelledby={`${product.slug}-name`} className={styles.row}>
            <div>
              <h3 id={`${product.slug}-name`} className={styles.rowName}>
                {product.name}
              </h3>
              <Tagline product={product} />
            </div>
            <div>
              <Paragraphs product={product} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

const STAGE_SECTIONS: Record<EcosystemStage["id"], (props: { stage: EcosystemStage }) => ReactElement> = {
  "available-now": AvailableNow,
  next: Next,
  then: Then,
  research: Research,
};

export default async function EcosystemPage() {
  // Resolved once: the token and launchpad copy, the litepaper link and the token links all follow
  // the same view (switch on and viewer not blocked), so a blocked or default-off page names none of them.
  const view = await getTokenSurfaceView();
  const tokenVisible = tokenSurfacesVisible(view);
  const [leadParagraph, questionsParagraph, pullParagraph] = INTRO.paragraphs;

  const followLinks: ActionLink[] = [
    { ...FOLLOW.launch, kind: "primary" },
    { ...FOLLOW.roadmap, kind: "secondary" },
    ...(tokenVisible ? [{ ...FOLLOW.litepaper, kind: "secondary" as const }] : []),
    ...(FOLLOW.repository ? [{ ...FOLLOW.repository, kind: "secondary" as const }] : []),
  ];

  return (
    <PublicSite className={baseStyles.page} data-page="ecosystem" tokenSurfaces={tokenVisible}>
      <StructuredData schema={ecosystemSchema} />
      <main id="main-content" className={baseStyles.main}>
        <Breadcrumbs items={[{ label: "Ecosystem" }]} />

        <header className={styles.masthead}>
          <h1 className={styles.title}>
            {INTRO.titleLead} <em className={styles.titleTail}>{INTRO.titleTail}</em>
          </h1>
        </header>

        <div className={styles.intro}>
          <div className={styles.introText}>
            <p className={styles.lead}>{renderInline(leadParagraph)}</p>
            <p>{renderInline(questionsParagraph)}</p>
            <p className={styles.pull}>{renderInline(pullParagraph)}</p>
          </div>
          <div className={styles.guide}>
            <p>{renderInline(INTRO.guide)}</p>
            <nav aria-label="The four groups on this map">
              <ul className={styles.key}>
                {ECOSYSTEM_STAGES.map((stage) => (
                  <li key={stage.id}>
                    <a href={`#${stage.id}`}>
                      <StageMarker stage={stage.id} />
                      <span>{stage.label}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </div>

        {ECOSYSTEM_STAGES.map((stage) => {
          const Section = STAGE_SECTIONS[stage.id];
          return <Section key={stage.id} stage={stage} />;
        })}

        <section aria-labelledby="computer-roadmap-heading" className={styles.note}>
          <h2 id="computer-roadmap-heading">{COMPUTER_ROADMAP.heading}</h2>
          <p>{renderInline(COMPUTER_ROADMAP.paragraph)}</p>
        </section>

        <section aria-labelledby="fit-heading" className={styles.fit}>
          <div className={styles.fitHead}>
            <h2 id="fit-heading">{FIT.heading}</h2>
            <p>{FIT.intro}</p>
          </div>
          <div>
            <ol role="list" className={styles.steps}>
              {FIT.steps.map((step) => (
                <li key={step}>
                  <span>{renderInline(step, { hrefForBold: hrefForProductName })}</span>
                </li>
              ))}
            </ol>
            {FIT.outro.map((paragraph) => (
              <p key={paragraph} className={styles.fitOutro}>
                {renderInline(paragraph)}
              </p>
            ))}
          </div>
        </section>

        <TokenSurfaceGate view={view}>
          <section aria-labelledby="token-heading" className={styles.quiet}>
            <h2 id="token-heading">{TOKEN_SECTION.heading}</h2>
            <div>
              {TOKEN_SECTION.paragraphs.map((paragraph) => (
                <p key={paragraph}>{renderInline(paragraph)}</p>
              ))}
              <ActionLinks items={secondary(TOKEN_SECTION.links)} label="Token pages" />
            </div>
          </section>
          <section aria-labelledby="launchpad-heading" className={`${styles.quiet} ${styles.quietResearch}`}>
            <h2 id="launchpad-heading">{LAUNCHPAD_SECTION.heading}</h2>
            <div>
              {LAUNCHPAD_SECTION.paragraphs.map((paragraph) => (
                <p key={paragraph}>{renderInline(paragraph)}</p>
              ))}
            </div>
          </section>
        </TokenSurfaceGate>

        <section aria-labelledby="follow-heading" className={styles.follow}>
          <h2 id="follow-heading">{FOLLOW.heading}</h2>
          <div>
            <p>{FOLLOW.paragraph}</p>
            <ActionLinks items={followLinks} label="Where to go next" />
          </div>
        </section>
      </main>
    </PublicSite>
  );
}
