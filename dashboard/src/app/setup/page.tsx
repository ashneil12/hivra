import type { Metadata } from "next";
import { headers } from "next/headers";
import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs } from "@/components/public-editorial/Editorial";
import { ActionLinks } from "@/components/public-editorial/ActionLinks";
import editorial from "@/components/public-editorial/secondary-site.module.css";
import CopyButton from "@/components/tools/CopyButton";
import { ENTRY_PLAN_PRICE, HOSTED_COMPUTE_NEEDS_PLAN_SHORT } from "@/lib/blog/plan-facts";
import { setupPrompt } from "@/lib/agent-setup/setup-md";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { SITE_URL } from "@/lib/seo-urls";
import styles from "./setup.module.css";

const TITLE = "Set up Hivra from your coding agent | Hivra";
const DESCRIPTION = "Paste one line into Claude Code, Codex or Cursor. It sets you up with an AI agent on a cloud computer of its own.";

export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/setup", title: TITLE, description: DESCRIPTION }),
};

// The prompt names the site serving the page, so Canary's prompt points at Canary.
export const dynamic = "force-dynamic";

const STEPS = [
  { title: "Paste the line", body: "Into Claude Code, Codex, Cursor or any coding agent that can read a web page." },
  { title: "Sign in and press Launch", body: "Your coding agent picks the agent with you and opens Launch with it filled in." },
  { title: "Chat", body: "Your agent has its own cloud computer. It keeps working when your laptop is closed." },
] as const;

async function siteOrigin(): Promise<string> {
  const store = await headers();
  const host = store.get("x-forwarded-host") ?? store.get("host");
  if (!host || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) return SITE_URL;
  const proto = store.get("x-forwarded-proto") === "http" ? "http" : "https";
  return `${proto}://${host}`;
}

export default async function SetupPage() {
  const origin = await siteOrigin();
  const prompt = setupPrompt(origin);
  return (
    <PublicSite className={editorial.page} data-page="setup" tokenSurfaces={false}>
      <main className={editorial.main} id="main-content">
        <Breadcrumbs items={[{ label: "Set up from your coding agent" }]} />
        <header className={editorial.masthead}>
          <h1>Set up Hivra from your coding agent.</h1>
          <p>Paste one line into Claude Code, Codex or Cursor. It sets you up with an AI agent that runs on a cloud computer of its own.</p>
        </header>

        <section className={styles.promptBox} aria-labelledby="setup-prompt">
          <h2 id="setup-prompt" className={styles.label}>Paste this into your coding agent</h2>
          <p className={styles.prompt}><code>{prompt}</code></p>
          <CopyButton text={prompt} label="Copy prompt" ariaLabel="Copy the setup prompt" />
        </section>

        <section className={styles.section} aria-labelledby="setup-how">
          <h2 id="setup-how">How it works</h2>
          <ol className={styles.steps}>
            {STEPS.map((step) => (
              <li key={step.title}><strong>{step.title}</strong>{step.body}</li>
            ))}
          </ol>
        </section>

        <section className={styles.section} aria-labelledby="setup-move">
          <h2 id="setup-move">Move your coding work to the cloud</h2>
          <p className={styles.body}>
            Ask Claude Code or Codex to move itself. It sets up the same agent on Hivra, pushes your branch once you say so,
            and writes a handoff note for the cloud copy to pick up from. Your keys never go into the note.
          </p>
        </section>

        <p className={styles.body}>
          {HOSTED_COMPUTE_NEEDS_PLAN_SHORT} Paid plans start at {ENTRY_PLAN_PRICE} a month. You sign in and press Launch yourself:
          your coding agent never sees your password or pays for anything.
        </p>
        <ActionLinks items={[
          { label: "Read setup.md", href: "/setup.md", kind: "secondary", cta: "setup-md" },
          { label: "Launch it yourself", href: "/dashboard/launch?kind=agent&start=1", kind: "secondary", cta: "setup-launch" },
        ]} />
      </main>
    </PublicSite>
  );
}
