import type { ReactNode } from "react";
import Link from "next/link";
import PublicSite from "@/components/public-site/PublicSite";
import styles from "../../components/public-editorial/secondary-site.module.css";

// DRAFT: needs Ash + legal review. Not in effect. Items marked TODO are
// decisions for Ash or counsel; do not publish this page while any remain.
const LAST_UPDATED = "Draft, not yet in effect";

function ReviewNote({ children }: { children: ReactNode }) {
  return <p><strong>TODO (review):</strong> {children}</p>;
}

export default function TermsPage() {
  return (<PublicSite className={styles.page} data-page="terms">
      <main className={styles.legal} id="main-content">
        <h1 className="serif">Terms of Service</h1>

        <div>
          <p>Last Updated: {LAST_UPDATED}</p>
          <p><strong>Draft for review.</strong> These terms are not in effect. Until they are published, the terms dated May 2, 2026 apply.</p>

          <h2 className="serif">1. Acceptance of Terms</h2>
          <p>By accessing or using Hivra, you agree to be bound by these Terms of Service. If you disagree with any part of the terms, you do not have permission to access the Service.</p>

          <h2 className="serif">2. What Hivra Provides</h2>
          <p>Hivra gives you computers for your work. You can launch an agent on a computer of its own, or launch a computer and use it yourself without an agent. A computer includes its operating system, storage, network access, the interfaces Hivra provides for it, and its lifecycle (start, stop, restart and deletion).</p>
          <p>Computers on Hivra Cloud are isolated virtual machines that run on shared physical hosts. They are not dedicated physical hardware.</p>
          <p>Some features are marked as available now, private preview, preview, coming soon or proposed. Anything not marked available now may change, be limited to some accounts, or be withdrawn, and is provided as is.</p>

          <h2 className="serif">3. Where Your Computer Runs</h2>
          <ul>
            <li><strong>Hivra Cloud:</strong> We run the machines, updates, monitoring and recovery for managed plans, within the limits of your plan.</li>
            <li><strong>Your own cloud account or server:</strong> When you connect a cloud provider account or a server you control, that provider bills you directly for anything created there. Hivra asks for your approval before any step that creates, buys or changes resources in your account, and shows what that step will do. You are responsible for your provider&apos;s charges, its terms, and resources you keep running.</li>
            <li><strong>Operating system images you supply:</strong> You are responsible for holding a valid licence for any image you provide, including Windows.</li>
          </ul>
          <ReviewNote>Confirm with counsel how liability splits when Hivra acts in your cloud account on your approval.</ReviewNote>

          <h2 className="serif">4. Self-Hosting</h2>
          <p>You can run the Hivra platform yourself under the Apache-2.0 license, with no Hivra account and no token. Self-hosted software is provided &quot;as is&quot;, without warranties or conditions of any kind, as set out in that license. These Terms cover the hosted service. Hivra provides no support, uptime or recovery commitment for a deployment you run yourself, and you are responsible for its security, data and upkeep.</p>

          <h2 className="serif">5. Your Responsibilities</h2>
          <ul>
            <li><strong>API Usage:</strong> You are responsible for all usage and billing related to the third-party API keys and accounts (e.g., OpenRouter, OpenAI, Anthropic) you connect to your agents.</li>
            <li><strong>Agent Behavior:</strong> You assume full liability for the actions, automated operations, and internet browsing conducted by your agents, including anything they do with the access you give them. You agree not to use agents for illegal activities, mass spamming, denial of service attacks, or any malicious behavior.</li>
            <li><strong>Security:</strong> You are responsible for safeguarding your account access credentials, the API keys you provide, and any wallet you use.</li>
          </ul>

          <h2 className="serif">6. Plans and Card Payments</h2>
          <p>Paid plans are billed through Stripe for the period you choose. Your plan sets your limits, including how many agents you can run. The billing page shows your current plan and its limits.</p>
          <p><strong>Refunds for card payments:</strong> TODO (Ash): set the refund period. The May 2 terms promise a 7-day money-back guarantee. The app says 48 hours for card payments. They must match before this page is published.</p>
          <ReviewNote>Confirm whether plans are still upgrade-only or can now be changed to a lower plan, and restate that rule here.</ReviewNote>
          <ReviewNote>Confirm how long a computer is kept after a failed payment or a cancellation before it is deleted. The May 2 terms say 48 hours.</ReviewNote>

          <h2 className="serif">7. Token Access Tiers</h2>
          <p>Holding the existing $HermesOS token in a qualifying amount can give you access to a compute tier instead of paying by card. The billing page shows the current requirements.</p>
          <p>If your qualifying balance drops below the requirement, your access continues for a grace period, currently 24 hours, and is then suspended. Limits apply to how often you can qualify again, currently a 7-day wait and twice in any 12 months.</p>
          <p><strong>Existing holders are grandfathered.</strong> If you already qualify with $HermesOS, you keep that access and can keep using $HermesOS.</p>
          <ReviewNote>Ash to set the carry-over rule: how long grandfathered $HermesOS access lasts, and what a holder who converts must hold to keep their tier.</ReviewNote>
          <p>Holding the token gives you access to the service described here and nothing else. It is not a share in Hivra and gives no right to profits, revenue, payouts or a vote.</p>

          <h2 className="serif">8. Paying in the Token</h2>
          <p>You can pay for some plans and credits in $HermesOS. Prices paid in the token can be lower than the card price. The price shown when you pay is the price that applies.</p>
          <p><strong>Payments in $HermesOS are final and can&apos;t be refunded.</strong></p>
          <ReviewNote>Counsel to review the token-payment discount and any bonus credits under the UK financial-promotion rules before this section is published.</ReviewNote>

          <h2 className="serif">9. Deposit Wallets</h2>
          <p>When you pay or top up in the token, Hivra shows a deposit address and the exact amount to send. Send only the token named on that screen, only on the Base network, and only to that address. Check the contract address on the <Link href="/token">token page</Link>, which is the only place Hivra publishes it. Hivra never confirms addresses by direct message.</p>
          <p>Tokens sent to the wrong address, on the wrong network, in a different amount, after a quote expires, or in a different token (including any token that uses the Hivra name but is not listed on the token page) may not be credited and may not be recoverable.</p>
          <ReviewNote>Counsel to confirm whether any Hivra-controlled wallet that holds tokens for a user (deposit or holding wallets) makes Hivra a custodian, and what these Terms must then say.</ReviewNote>

          <h2 className="serif">10. The Proposed $HIVRA Token and Future Claim</h2>
          <p>$HIVRA is a proposed new token. It does not exist yet, and nothing in these Terms is an offer to sell, buy or exchange any token. If it launches, converting $HermesOS would be optional and would be governed by separate claim terms, published before claims open. Those terms would set out the conversion rate, fees and how access carries over.</p>

          <h2 className="serif">11. Limitation of Liability</h2>
          <p>In no event shall Hivra, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from your access to or use of or inability to access or use the Service.</p>

          <h2 className="serif">12. Changes to These Terms</h2>
          <p>We will publish any change to these Terms on this page with a new date before it takes effect.</p>

          <h2 className="serif">13. Contact</h2>
          <p>Questions about these Terms can be sent to info@hivra.cloud.</p>
        </div>
      </main>
  </PublicSite>);
}
