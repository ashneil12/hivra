import PublicSite from "@/components/public-site/PublicSite";
import styles from "../../components/public-editorial/secondary-site.module.css";

import { buildWebsiteMetadata } from "@/lib/metadata";

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

const LAST_UPDATED = "November 25, 2026";

export default function TermsPage() {
  return (<PublicSite className={styles.page} data-page="terms">
      <main className={styles.legal} id="main-content">
        <h1 className="serif">Terms of Service</h1>
        
        <div>
          <p>Last Updated: {LAST_UPDATED}</p>
          
          <h2 className="serif">1. Acceptance of Terms</h2>
          <p>By accessing or using Hivra, you agree to be bound by these Terms of Service. If you disagree with any part of the terms, you do not have permission to access the Service.</p>

          <h2 className="serif">2. Description of Service</h2>
          <p>Hivra provides a fully managed, production-grade cloud environment for autonomous AI agents. The service includes provisioning infrastructure, persisting memory, and providing a communication interface to interact with your deployed agents.</p>

          <h2 className="serif">3. Your Responsibilities</h2>
          <ul>
            <li><strong>API Usage:</strong> You are responsible for all usage and billing related to the third-party API keys (e.g., OpenRouter, OpenAI, Anthropic) you provide to your agents.</li>
            <li><strong>Agent Behavior:</strong> You assume full liability for the actions, automated operations, and internet browsing conducted by your agents. You agree not to use agents for illegal activities, mass spamming, denial of service attacks, or any malicious behavior.</li>
            <li><strong>Security:</strong> You are responsible for safeguarding your account access credentials and provided API keys.</li>
          </ul>

          <h2 className="serif">4. Subscription and Billing</h2>
          <p>Hivra offers a free account that any user may use without selecting a paid plan, subject to fair-use limits and anti-abuse checks. A free account does not include a computer run by Hivra; it works with computers you connect yourself. A computer run by Hivra requires a paid plan or a qualifying token-based access path. Free-tier computers created before this change remain available under the limits they were created with. Paid tiers (Pro, Power) are billed on a monthly subscription basis according to the tier you select. Payments and card verification are processed securely via Stripe. Separately, where token-holder access is enabled for an account, a new holder qualification is valued at $299 for Pro (2 vCPU and 4 GB) or $599 for Power (4 vCPU and 8 GB), converted to a token amount using the live market price when quoted. A qualification already recorded keeps the token amount, token and tier code recorded for it; those historical locks are not repriced. Token-holder access remains subject to the applicable holding, grace, suspension and requalification rules shown in Billing. Hosted holder compute is placement-backed. Holder use is admitted only up to 20% of CPU capacity and 20% of RAM capacity across the eligible placement fleet; these are admission ceilings, and grandfathering can preserve usage above them. When capacity is unavailable, holders join a waitlist and hosted compute starts only after admission. For holder computers with automatic idle sleep enabled, sleep timing is conditional on host support and activity checks: after 4 minutes idle they nap, and after 12 further minutes in nap (16 minutes total idle) their memory is saved to disk and the computer stops.</p>
          <p><strong>Refund & Grace Period Policy:</strong> Because we provision dedicated computing infrastructure for each Hermes agent, we incur immediate, non-recoverable server costs. Therefore, we offer a 7-day money-back guarantee following your initial paid subscription charge. Additionally, in the event of a payment failure or cancellation, server instances are retained for a 48-hour grace period before secure deletion.</p>
          <p><strong>Upgrade-Only Plans:</strong> Due to the nature of our dedicated infrastructure provisioning, Hivra subscription tiers cannot be downgraded. You may upgrade your tier at any time. To move to a lower tier, you must cancel your current subscription and initiate a new one, which will result in the deletion of your current server environment and data.</p>

          <h2 className="serif">5. Limitation of Liability</h2>
          <p>In no event shall Hivra, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from your access to or use of or inability to access or use the Service.</p>
        </div>
      </main>
  </PublicSite>);
}
