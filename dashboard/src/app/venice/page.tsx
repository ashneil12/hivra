import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";
import { ArrowRight, Bot, MessagesSquare, Sparkles } from "lucide-react";
import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs } from "@/components/public-editorial/Editorial";
import { ActionLinks } from "@/components/public-editorial/ActionLinks";
import editorial from "@/components/public-editorial/secondary-site.module.css";
import VeniceAttributionCapture from "@/components/venice/VeniceAttributionCapture";
import VenicePromo from "@/components/venice/VenicePromo";
import { ENTRY_PLAN_PRICE } from "@/lib/blog/plan-facts";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { buildVeniceLaunchHref } from "@/lib/venice/launch-link";
import { SUPPORT_DISCORD_URL, VENICE_API_KEYS_URL, VENICE_DOCS_URL, veniceSetupCallLink } from "@/lib/venice/onboarding";
import styles from "./venice.module.css";

const TITLE = "Run your Venice agent 24/7 | Hivra";
const DESCRIPTION = `Launch Hermes, OpenClaw or Agent Zero on Venice in minutes. No server setup. Plans from ${ENTRY_PLAN_PRICE}/month.`;

export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/venice", title: TITLE, description: DESCRIPTION }),
};

// The promo flag is read at request time (computed env key), not frozen at build.
export const dynamic = "force-dynamic";

const TILES = [
  { id: "hermes", Icon: Sparkles, line: "Your everyday agent. The default." },
  { id: "openclaw", Icon: MessagesSquare, line: "An agent you reach from your messaging apps." },
  { id: "agent-zero", Icon: Bot, line: "Give it a goal. It plans, runs and reports." },
] as const;

const STEPS = [
  { title: "Pick an agent", body: "Hermes, OpenClaw or Agent Zero." },
  { title: "Launch", body: "Hivra sets up its own computer for it." },
  { title: "Chat", body: "Talk to it. It keeps working when you close the tab." },
] as const;

export default async function VenicePage() {
  const { userId } = await auth();
  const setupCall = veniceSetupCallLink();
  return (
    <PublicSite className={editorial.page} data-page="venice" tokenSurfaces={false}>
      <VeniceAttributionCapture />
      <main className={editorial.main} id="main-content">
        <Breadcrumbs items={[{ label: "Venice" }]} />
        <header className={`${editorial.masthead} ${styles.hero}`}>
          <h1>Run your Venice agent 24/7. No server setup.</h1>
          <p>Pick an agent. Hivra gives it a computer and runs it on Venice.</p>
          <VenicePromo signedIn={Boolean(userId)} />
        </header>

        <section aria-labelledby="venice-agents">
          <h2 id="venice-agents" className={styles.sectionTitle}>Choose your agent</h2>
          <ul className={styles.tiles}>
            {TILES.map(({ id, Icon, line }) => (
              <li key={id}>
                <a className={styles.tile} href={buildVeniceLaunchHref(id, "venice")} data-cta={`venice-agent-${id}`}>
                  <Icon size={28} className={styles.tileIcon} aria-hidden="true" />
                  <span className={styles.tileName}>{getAgent(id)?.name ?? id}</span>
                  <span className={styles.tileLine}>{line}</span>
                  <span className={styles.tileGo}>Launch <ArrowRight size={16} aria-hidden="true" /></span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.section} aria-labelledby="venice-access">
          <h2 id="venice-access">Two ways to power it</h2>
          <div className={styles.options}>
            <div className={styles.option}>
              <h3>Use Hivra credits</h3>
              <p className={styles.optionTag}>Easiest. No Venice account needed.</p>
              <ol className={styles.optionSteps}>
                <li>Pick an agent and choose <strong>Hivra credits</strong> when it asks how to connect to AI.</li>
                <li>Add credit if your balance is $0. Pick a Venice model, or keep the default.</li>
                <li>Launch. Model usage comes out of your credits at Venice&apos;s rates.</li>
              </ol>
              <ActionLinks items={[{ label: "Launch with Hivra credits", href: buildVeniceLaunchHref("hermes", "venice"), kind: "primary", cta: "venice-credits" }]} />
            </div>
            <div className={styles.option}>
              <h3>Bring your Venice API key</h3>
              <p className={styles.optionTag}>Use the Venice account you already have.</p>
              <ol className={styles.optionSteps}>
                <li>Create an API key in your Venice settings.</li>
                <li>Paste it when Launch asks how to connect to AI. Hivra checks it and lists the models it can use.</li>
                <li>Launch. Venice bills your usage directly.</li>
              </ol>
              <ActionLinks items={[
                { label: "Launch with my key", href: buildVeniceLaunchHref("hermes", "venice-key"), kind: "secondary", cta: "venice-own-key" },
                { label: "Get a Venice API key", href: VENICE_API_KEYS_URL, kind: "secondary", cta: "venice-get-key" },
              ]} />
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="venice-how">
          <h2 id="venice-how">How it works</h2>
          <ol className={styles.steps}>
            {STEPS.map((step) => (
              <li key={step.title}><strong>{step.title}</strong>{step.body}</li>
            ))}
          </ol>
        </section>

        <section className={styles.section} aria-labelledby="venice-help">
          <h2 id="venice-help">Want a hand getting set up?</h2>
          <p className={styles.helpLead}>Book a short call and we&apos;ll get your agent running on Venice with you, or ask in our Discord.</p>
          <ActionLinks items={[
            { label: "Book a setup call", href: setupCall.href, kind: "primary", cta: "venice-setup-call" },
            { label: "Ask in Discord", href: SUPPORT_DISCORD_URL, kind: "secondary", cta: "venice-discord" },
          ]} />
          <p className={styles.helpNote}>
            Questions about your Venice account, its keys or its billing? <a href={VENICE_DOCS_URL} rel="noopener noreferrer" target="_blank">Venice&apos;s docs</a> cover those.
          </p>
        </section>

        <p className={styles.price}>Plans from {ENTRY_PLAN_PRICE}/month.</p>
        <p className={styles.privacy}>
          Private Venice models do not keep your prompts. Each agent runs on its own computer. Venice models that come from other companies follow those companies&apos; own rules.
        </p>
      </main>
    </PublicSite>
  );
}
