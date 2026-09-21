import PublicSite from "@/components/public-site/PublicSite";
import styles from "../../components/public-editorial/secondary-site.module.css";

const LAST_UPDATED = "May 2, 2026";

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
          <p>Hivra offers a free tier that any user may use without selecting a paid plan, subject to fair-use limits and anti-abuse checks. Some free-tier provisioning attempts may require a card-on-file verification before infrastructure is created; qualifying crypto or token-based access paths do not require adding a card for that payment path. Paid tiers (Pro, Power) are billed on a monthly subscription basis according to the tier you select. Payments and card verification are processed securely via Stripe.</p>
          <p><strong>Refund & Grace Period Policy:</strong> Because we provision dedicated computing infrastructure for each Hermes agent, we incur immediate, non-recoverable server costs. Therefore, we offer a 7-day money-back guarantee following your initial paid subscription charge. Additionally, in the event of a payment failure or cancellation, server instances are retained for a 48-hour grace period before secure deletion.</p>
          <p><strong>Upgrade-Only Plans:</strong> Due to the nature of our dedicated infrastructure provisioning, Hivra subscription tiers cannot be downgraded. You may upgrade your tier at any time. To move to a lower tier, you must cancel your current subscription and initiate a new one, which will result in the deletion of your current server environment and data.</p>

          <h2 className="serif">5. Limitation of Liability</h2>
          <p>In no event shall Hivra, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from your access to or use of or inability to access or use the Service.</p>
        </div>
      </main>
  </PublicSite>);
}
