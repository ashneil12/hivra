import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

import StructuredData from "@/components/StructuredData";
import PublicSite from "@/components/public-site/PublicSite";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { buildAbsoluteSiteUrl, buildWebsiteMetadata } from "@/lib/metadata";

import styles from "../page.module.css";

const PAGE_PATH = "/why-hivra/evolution";
const SITE_ROOT = buildAbsoluteSiteUrl("/");
const PAGE_URL = buildAbsoluteSiteUrl(PAGE_PATH);
const PAGE_TITLE = "Why Hivra? The Evolution of HermesOS";
const PAGE_DESCRIPTION =
  "HermesOS (Hermes Agent OS) is evolving into Hivra as the platform expands beyond one agent framework. Existing users, deployments, accounts, and $HermesOS continue working.";

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  ...buildWebsiteMetadata({
    path: PAGE_PATH,
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    twitterTitle: "Why Hivra? The Evolution of HermesOS",
    twitterDescription:
      "HermesOS is becoming Hivra. Here is what changes, what stays the same, and why the platform is expanding.",
  }),
};

const pageSchema = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE_ROOT },
        { "@type": "ListItem", position: 2, name: "Why Hivra?", item: PAGE_URL },
      ],
    },
    {
      "@type": "WebPage",
      "@id": `${PAGE_URL}#webpage`,
      url: PAGE_URL,
      name: PAGE_TITLE,
      description: PAGE_DESCRIPTION,
      isPartOf: { "@id": `${SITE_ROOT}/#website` },
      about: [
        { "@type": "SoftwareApplication", name: "Hivra", alternateName: "HermesOS" },
        { "@type": "SoftwareApplication", name: "HermesOS", alternateName: "Hermes Agent OS" },
      ],
    },
  ],
};

// Availability comes from the agent catalog, so this page cannot drift from
// what the launch flow actually offers.
const agentLineup = [
  { id: "hermes", label: "Hermes Agent", x: 20, y: 22 },
  { id: "claude-code", label: "Claude Code", x: 50, y: 12 },
  { id: "codex", label: "Codex", x: 80, y: 22 },
  { id: "agent-zero", label: "Agent Zero", x: 84, y: 50 },
  { id: "openclaw", label: "OpenClaw", x: 74, y: 80 },
  { id: "aeon", label: "Aeon", x: 42, y: 86 },
  { id: "deepseek-harness", label: "DeepSeek", x: 16, y: 46 },
].map((agent) => ({ ...agent, available: getAgent(agent.id)?.available === true }));

const availableNow = agentLineup.filter((agent) => agent.available).map((agent) => agent.label);
const inPreview = agentLineup.filter((agent) => !agent.available).map((agent) => agent.label);

const CORE = { x: 50, y: 46 };
const ORIGIN = { x: 14, y: 70 };

const networkNodes = [
  { label: "HermesOS", detail: "origin", x: ORIGIN.x, y: ORIGIN.y, variant: "origin" },
  { label: "Hivra", detail: "platform", x: CORE.x, y: CORE.y, variant: "core" },
  ...agentLineup.map((agent) => ({
    label: agent.label,
    detail: agent.available ? "live" : "preview",
    x: agent.x,
    y: agent.y,
    variant: agent.available ? "active" : "future",
  })),
];

function NetworkMap() {
  return (
    <div className={styles.networkCard} aria-label="Hivra agent network map">
      <svg className={styles.networkLines} viewBox="0 0 100 100" aria-hidden="true">
        <path d={`M${ORIGIN.x} ${ORIGIN.y} L${CORE.x} ${CORE.y}`} />
        {agentLineup.map((agent) => (
          <path key={agent.id} d={`M${CORE.x} ${CORE.y} L${agent.x} ${agent.y}`} />
        ))}
        <path
          d={`M${agentLineup.map((agent) => `${agent.x} ${agent.y}`).join(" L")} Z`}
          className={styles.softLine}
        />
      </svg>
      {networkNodes.map((node) => (
        <div
          key={node.label}
          className={`${styles.node} ${styles[`node_${node.variant}`]}`}
          style={{ left: `${node.x}%`, top: `${node.y}%` }}
        >
          <span className={styles.nodeLabel}>{node.label}</span>
          <span className={styles.nodeDetail}>{node.detail}</span>
        </div>
      ))}
      <div className={styles.networkCaption}>
        <span className="mono">HermesOS origin</span>
        <span className="mono">Worker network future</span>
      </div>
    </div>
  );
}

function SectionShell({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.sectionCard} aria-labelledby={`why-hivra-section-${number}`}>
      <div className={styles.sectionLabel}>Section {number}</div>
      <h2 id={`why-hivra-section-${number}`} className={styles.sectionTitle}>
        {title}
      </h2>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

export default function WhyHivraPage() {
  return (
    <PublicSite className={styles.page} data-page="why-hivra">
      <StructuredData schema={pageSchema} />

      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>HermesOS to Hivra</p>
            <h1 className={`serif ${styles.heroTitle}`}>Why Hivra?</h1>
            <div className={styles.subtitleStack}>
              <p>HermesOS started as a platform for deploying Hermes Agent.</p>
              <p>Over time, the vision became much bigger.</p>
            </div>
            <p className={styles.founderNote}>
              This page is here to answer the obvious questions plainly: what is changing, what is not changing, and why the next chapter needs a broader name.
            </p>
          </div>

          <NetworkMap />
        </section>

        <div className={styles.sectionList}>
          <SectionShell number="01" title="Why change the name?">
            <p>HermesOS (the Hermes Agent OS) was originally built around a single agent ecosystem.</p>
            <p>Today the platform is expanding to support multiple AI workers, frameworks, and deployment types.</p>
            <p>The future of the platform is not one agent.</p>
            <p>It is networks of specialised agents working together.</p>
            <p>The name Hivra reflects that broader vision.</p>
          </SectionShell>

          <SectionShell number="02" title="Is HermesOS going away?">
            <p>No.</p>
            <p>HermesOS is evolving into Hivra.</p>
            <p>Existing deployments continue working.</p>
            <p>Existing accounts continue working.</p>
            <p>No action is required from current users.</p>
            <p>This is an evolution of the platform, not a replacement.</p>
          </SectionShell>

          <SectionShell number="03" title="What happens to $HermesOS?">
            <p>Existing $HermesOS holders are grandfathered.</p>
            <p>You keep your access, and you can keep using $HermesOS.</p>
            <p>On Hivra today, $HermesOS is used to:</p>
            <ul className={styles.bulletList}>
              <li>Hold for a compute tier</li>
              <li>Pay for a plan, with the discount for paying in the token</li>
            </ul>
            <div className={styles.sameTokenBox}>
              <p>$HIVRA is a proposed new token on Base, to be launched through Bankr. It does not exist yet.</p>
              <p>Under the proposal, new users would use $HIVRA once it launches.</p>
              <p>Under the proposal, converting your $HermesOS would be optional, and the terms would be published before claims open.</p>
              <p>Under the proposal, paying in the token keeps its discount.</p>
            </div>
            <p>
              Everything about $HIVRA here is a proposal, not final terms. Check contract addresses only on the{" "}
              <Link href="/token">token page</Link>.
            </p>
          </SectionShell>

          <SectionShell number="04" title="What is Hivra?">
            <p>Hivra is a platform for launching and managing AI workers.</p>
            <p>Instead of managing infrastructure, users launch agents.</p>
            <p>Instead of configuring servers, users focus on outcomes.</p>
            <p>The platform handles the complexity.</p>
            <p>Users focus on getting work done.</p>

            <div className={styles.supportGrid}>
              <div className={styles.supportCard}>
                <h3>Available now</h3>
                <ul>
                  {availableNow.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className={styles.supportCard}>
                <h3>In preview</h3>
                <ul>
                  {inPreview.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </SectionShell>

          <SectionShell number="05" title="The Long-Term Vision">
            <p>The future of AI is not a single model.</p>
            <p>The future is teams of specialised agents.</p>
            <p>Hivra is being built as the operating layer for those networks.</p>

            <div className={styles.timelineGrid}>
              <div>
                <span className="mono">Today</span>
                <p>Launch agents.</p>
              </div>
              <div>
                <span className="mono">Tomorrow</span>
                <p>Manage teams of agents.</p>
              </div>
              <div>
                <span className="mono">Later</span>
                <p>Discover, publish, and monetise agents through a shared marketplace.</p>
              </div>
            </div>
          </SectionShell>

          <SectionShell number="06" title="The Relationship Between Hivra And HermesOS">
            <p>Simple version:</p>
            <div className={styles.relationshipBox}>
              <p>Hivra is the platform.</p>
              <p>$HermesOS is the live token today. $HIVRA is the proposed next one.</p>
            </div>
            <p>The platform became bigger than its original name.</p>
            <p>The vision expanded.</p>
            <p>The ecosystem continues.</p>
          </SectionShell>
        </div>

        <section className={styles.closingCta} aria-labelledby="why-hivra-closing-title">
          <p className={styles.eyebrow}>Next chapter</p>
          <h2 id="why-hivra-closing-title" className="serif">
            The mission hasn&apos;t changed.
          </h2>
          <p>Make launching and operating AI agents as easy as launching a website.</p>
          <Link href="/get-started?plan=free" className={`action-button ${styles.ctaButton}`}>
            Launch Your First Agent <span aria-hidden="true">→</span>
          </Link>
        </section>
      </main>

    </PublicSite>
  );
}
