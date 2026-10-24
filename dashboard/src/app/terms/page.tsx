import PublicSite from "@/components/public-site/PublicSite";
import styles from "../../components/public-editorial/secondary-site.module.css";
import TokenSurfaceGate from "@/components/public-editorial/TokenSurfaceGate";
import { getTokenSurfaceView } from "@/lib/compliance/token-surface-view";

import { buildWebsiteMetadata } from "@/lib/metadata";
import { PAYMENT_GRACE_HOURS } from "@/lib/subscription/plans";
import LegalDocument, { LegalList, type LegalSectionData } from "./legal-document";

// Self-referencing canonical: without this the page inherits the root
// layout's canonical (the homepage) and search engines treat it as a
// duplicate of /.
export const metadata = {
  title: "Terms of Service",
  description: "The terms that govern your use of Hivra.",
  ...buildWebsiteMetadata({
    path: "/terms",
    title: "Terms of Service",
    description: "The terms that govern your use of Hivra.",
  }),
};

// Sections 2 and 4 differ from the supplied draft, all listed in docs/legal-copy-changes.md: the service description (no "production-grade",
// not only the managed cloud), the billing opening (no promise that older free computers stay, billing periods not only monthly), the refund
// item (its reasoning and scope), the failed payment and cancellation item (stop after the PAYMENT_GRACE_HOURS window of retries or when a cancelled plan ends), a
// separate Hermes item for the older lane, and the plan changes item (true whether or not in-place downgrades are switched on).
// The failed payment item is true only once the lapse enforcement is merged and HIVRA_LAPSE_ENFORCE_LIVE is "true" where this page is served;
// see the pre-publish checklist in docs/legal-copy-changes.md.

// The date is the one the supplied draft carries. It is a fixed string on purpose: a legal date
// is set by whoever approves the text, never by the clock.
const LAST_UPDATED = { label: "May 2, 2026", iso: "2026-05-02" };

export default async function TermsPage() {
  // One resolved view for the whole page: the token-access wording in section 4 shows only while the
  // token surfaces are on and the viewer is not geo-blocked.
  const tokens = await getTokenSurfaceView();

  const sections: LegalSectionData[] = [
    {
      id: "acceptance",
      heading: "1. Acceptance of Terms",
      children: (
        <p>
          By accessing or using Hivra, you agree to be bound by these Terms of Service. If you disagree with any part of the terms, you do not have
          permission to access the Service.
        </p>
      ),
    },
    {
      id: "service",
      heading: "2. Description of Service",
      children: (
        <p>
          Hivra provides computers for AI agents, and for you to work with them. You can run them on Hivra Cloud, on a computer or server you
          connect yourself, or by self-hosting the open-source platform. On Hivra Cloud the service includes setting up the computer, keeping its
          files and settings, and giving you a way to open it and work with your agents.
        </p>
      ),
    },
    {
      id: "responsibilities",
      heading: "3. Your Responsibilities",
      children: (
        <LegalList variant="stacked">
          <li>
            <strong>API Usage:</strong> You are responsible for all usage and billing related to the third-party API keys (e.g., OpenRouter, OpenAI,
            Anthropic) you provide to your agents.
          </li>
          <li>
            <strong>Agent Behaviour:</strong> You assume full liability for the actions, automated operations, and internet browsing conducted by your
            agents. You agree not to use agents for illegal activities, mass spamming, denial of service attacks, or any malicious behaviour.
          </li>
          <li>
            <strong>Security:</strong> You are responsible for safeguarding your account access credentials and provided API keys.
          </li>
        </LegalList>
      ),
    },
    {
      id: "billing",
      heading: "4. Subscription and Billing",
      children: (
        <>
          <p>
            Hivra offers a free account that any user may use without selecting a paid plan, subject to fair-use limits and anti-abuse checks. A free
            account does not include a computer that Hivra Cloud runs for you; it works with a computer or server you connect yourself. Every computer
            that Hivra Cloud runs for you needs a paid plan
            <TokenSurfaceGate view={tokens}>{" or a qualifying token-based access path"}</TokenSurfaceGate>. Paid tiers (Pro, Power) are billed for the
            tier and billing period you choose when you subscribe. Card payments and card verification are processed securely via Stripe. Hivra
            credits, where offered, pay for AI model usage through Hivra. They are separate from your plan, which does not include AI usage.
          </p>
          {/* The policies that follow the opening paragraph are laid out like the labelled items in section 3. */}
          <LegalList variant="stacked">
            <li>
              <strong>Refund Policy:</strong> We set up a dedicated computer for you when you start, and that cost cannot be recovered. We still offer
              a 7-day money-back guarantee on card payments, counted from your first paid subscription charge.
            </li>
            <li>
              <strong>Failed Payments and Cancellation:</strong> Except for Hermes agents, which the next item covers, a computer that Hivra Cloud
              runs for you runs only while its plan is paid. If a card payment fails, we retry the card and keep your computer running for up to{" "}
              {PAYMENT_GRACE_HOURS} hours after the first failed payment. If the payment has still not gone through by then, or when a cancelled plan ends, we stop your
              computer. We keep its files for a limited time, so that you can start it again once payment resumes, and we email you before we delete
              anything. If you still have another paid plan with us, your computer keeps running under that plan.
            </li>
            <li>
              <strong>Hermes Agents:</strong> Hermes agents (the agents you launch as Hermes) follow an older process. If a payment fails or you
              cancel, we mark your Hermes agents as suspended straight away, unless you still have another paid plan with us. We may then switch them
              off, and we delete a suspended Hermes agent only after a warning period, with emails beforehand. The length of that period depends on
              your account.
            </li>
            <li>
              <strong>Plan Changes:</strong> Due to the nature of our dedicated infrastructure provisioning, you may upgrade your plan at any time,
              but moving to a smaller size is not always possible in place. If the billing page does not offer it, email info@hivra.cloud for help, or
              cancel your current subscription and subscribe again. What happens to your computer when you cancel is described above.
            </li>
          </LegalList>
        </>
      ),
    },
    {
      id: "liability",
      heading: "5. Limitation of Liability",
      children: (
        <p>
          In no event shall Hivra, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental,
          special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses,
          resulting from your access to or use of or inability to access or use the Service.
        </p>
      ),
    },
  ];

  return (
    <PublicSite className={styles.page} data-page="terms">
      <LegalDocument
        title="Terms of Service"
        lead={
          <>
            <p>
              These terms describe the conditions for using Hivra, including its hosted AI agent environments and related services. Please read them
              before creating an account, subscribing or deploying an agent.
            </p>
            <p>
              If you have questions about the terms, contact{" "}
              <strong>
                <a href="mailto:info@hivra.cloud">info@hivra.cloud</a>
              </strong>
              .
            </p>
          </>
        }
        lastUpdated={LAST_UPDATED}
        sections={sections}
      />
    </PublicSite>
  );
}
