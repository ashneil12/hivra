import type { Metadata } from "next";
import PublicSite from "@/components/public-site/PublicSite";
import { Breadcrumbs } from "@/components/public-editorial/Editorial";
import { ActionLinks } from "@/components/public-editorial/ActionLinks";
import { absoluteTitle, buildWebsiteMetadata } from "@/lib/metadata";
import { SUPPORT_EMAIL } from "@/lib/support-channels";
import editorial from "@/components/public-editorial/secondary-site.module.css";
import styles from "./your-cloud.module.css";

const TITLE = "Hivra in your cloud | Customer-cloud pilot";
const DESCRIPTION = "Discuss a scoped pilot for a coding agent on customer-paid infrastructure, with compatibility checks and a written handover.";
const enquiryBody = [
  "Company and website:",
  "Current coding agent:",
  "Where it runs today:",
  "One workflow or hosting problem:",
  "Preferred infrastructure:",
  "Reply address:",
  "",
  "Please do not include passwords, API keys or client data.",
].join("\n\n");
const enquiryHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("[Hivra pilot] Customer cloud")}&body=${encodeURIComponent(enquiryBody)}`;

export const metadata: Metadata = {
  title: absoluteTitle(TITLE),
  description: DESCRIPTION,
  ...buildWebsiteMetadata({ path: "/your-cloud", title: TITLE, description: DESCRIPTION }),
  robots: { index: false, follow: false },
};

export default function YourCloudPage() {
  return (
    <PublicSite className={editorial.page} data-page="your-cloud" tokenSurfaces={false}>
      <main className={editorial.main} id="main-content">
        <Breadcrumbs items={[{ label: "Your cloud" }]} />
        <header className={`${editorial.masthead} ${styles.hero}`}>
          <span className={editorial.eyebrow}>CUSTOMER-CLOUD PILOT</span>
          <h1>Your coding agent.<br />Your cloud account.</h1>
          <p>Already using a coding agent? We are preparing a hands-on pilot to give it a persistent computer on infrastructure you pay for directly.</p>
          <p className={styles.scope}>One operator. One supported agent. One development workflow.</p>
          <ActionLinks items={[{ label: "Discuss a pilot", href: enquiryHref, kind: "primary" }]} />
          <p className={styles.note}>Pilot availability is subject to a compatibility review.</p>
        </header>
        <div className={editorial.articleBody}>
          <section className={styles.section} aria-labelledby="pilot-scope">
            <div>
              <span className={editorial.eyebrow}>01 / THE SETUP</span>
              <h2 id="pilot-scope">A small setup.<br />A clear handover.</h2>
              <p>We check your infrastructure and agent before agreeing the scope, price or start date.</p>
            </div>
            <ol className={styles.steps}>
              <li><h3>Check the fit</h3><p>Review the infrastructure, access and one workflow together.</p></li>
              <li><h3>Set up one environment</h3><p>Use an agreed supported target and a non-production repository, with permissions you control.</p></li>
              <li><h3>Check persistence and reconnection</h3><p>Verify what survives closing the client and what requires recovery. A persistent computer does not guarantee uninterrupted agent work.</p></li>
              <li><h3>Hand it over</h3><p>Get written operating instructions and a one-hour handover call.</p></li>
            </ol>
          </section>
          <section className={styles.section} aria-labelledby="pilot-ownership">
            <div>
              <span className={editorial.eyebrow}>02 / RESPONSIBILITIES</span>
              <h2 id="pilot-ownership">Know who runs what.</h2>
            </div>
            <div>
              <h3 className={styles.firstHeading}>A fixed quote after the compatibility check</h3>
              <p>You pay your infrastructure provider and AI provider directly. Updates, recovery and support can be scoped separately after the pilot.</p>
              <h3>Choose the arrangement</h3>
              <p>Connecting your infrastructure to hosted Hivra and independently hosting Hivra are separate arrangements. We record the chosen arrangement, who can access it and who maintains it before setup.</p>
              <h3>Agree access before setup</h3>
              <p>You sign in to your own accounts and approve owner-only steps. We agree any temporary operator access and how it will be removed. You do not share your account passwords with us.</p>
              <p>Model providers and connected services still receive the data your agent sends them. We agree access and credential responsibilities before setup.</p>
              <p>Hivra is open source. <a href="https://github.com/ashneil12/hivra" target="_blank" rel="noopener noreferrer">View the source</a>.</p>
            </div>
          </section>
          <section className={styles.enquiry} aria-labelledby="pilot-enquiry">
            <span className={editorial.eyebrow}>03 / NEXT STEP</span>
            <h2 id="pilot-enquiry">Start with the workflow.</h2>
            <p>Email your company, current agent, where it runs and what is getting in the way. We review compatibility together and agree a written scope before payment or resources are created.</p>
            <ActionLinks items={[{ label: "Discuss a pilot", href: enquiryHref, kind: "primary" }]} />
            <p className={styles.note}>The button opens a draft in your email app. You can also email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Please do not send passwords, API keys or client data.</p>
          </section>
        </div>
      </main>
    </PublicSite>
  );
}
