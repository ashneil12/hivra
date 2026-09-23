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

          <h2 className="serif">1. Who We Are</h2>
          <p>Hivra (&quot;we&quot;, &quot;us&quot;) provides the service described in these Terms. You can contact us at info@hivra.cloud.</p>
          <ReviewNote>UK law requires the trader&apos;s legal name, geographic address and, where they exist, company registration number and VAT number to be given here (Electronic Commerce (EC Directive) Regulations 2002, regulation 6; Consumer Contracts Regulations 2013, Schedule 2). These Terms cannot be published without them.</ReviewNote>

          <h2 className="serif">2. Accepting These Terms</h2>
          <p>By creating an account or using Hivra, you agree to these Terms. If you do not agree, do not use the service. You must be at least 18. If you use Hivra for a business, you confirm you can accept these Terms for it. A &quot;consumer&quot; means an individual using Hivra outside their trade, business or profession. Anyone else is a &quot;business customer&quot;. Some sections apply differently to each, and say so.</p>
          <p>Our <Link href="/privacy">Privacy Policy</Link> explains how we handle personal data.</p>

          <h2 className="serif">3. What Hivra Provides</h2>
          <p>Hivra gives you computers for your work. You can launch an agent on a computer of its own, or launch a computer and use it yourself without an agent. A computer includes its operating system, storage, network access, the interfaces Hivra provides for it, and its lifecycle (start, stop, restart and deletion).</p>
          <p>Computers on Hivra Cloud are isolated virtual machines that run on shared physical hosts. They are not dedicated physical hardware.</p>
          <p>Features are labelled as available now, private preview, preview, coming soon or proposed. Preview features can change or be withdrawn at short notice and may be less reliable. Features marked coming soon or proposed are plans, not commitments.</p>

          <h2 className="serif">4. Where Your Computer Runs</h2>
          <ul>
            <li><strong>Hivra Cloud:</strong> We run the machines, updates, monitoring and recovery for managed plans, within the limits of your plan.</li>
            <li><strong>Your own cloud account or server:</strong> When you connect a cloud provider account or a server you control, Hivra asks for your approval before any step that creates, buys or changes resources there, and shows what that step will do. We carry out the steps you approve with reasonable care and skill. Your provider bills you directly. You are responsible for that account, its charges, its terms and the resources you keep running.</li>
            <li><strong>Operating system images you supply:</strong> You are responsible for holding a valid licence for any image you provide, including Windows.</li>
          </ul>

          <h2 className="serif">5. Self-Hosting</h2>
          <p>You can run the Hivra platform yourself under the Apache-2.0 license, with no Hivra account and no token. Self-hosted software is provided &quot;as is&quot;, without warranties or conditions of any kind, as set out in that license. These Terms cover the hosted service. We give no support, uptime or recovery commitment for a deployment you run yourself, and you are responsible for its security, data and upkeep.</p>

          <h2 className="serif">6. Your Responsibilities</h2>
          <ul>
            <li><strong>Your account:</strong> Keep your sign-in, API keys and any wallet you use secure. Tell us promptly at info@hivra.cloud if you think your account has been misused.</li>
            <li><strong>Model providers:</strong> You are responsible for the usage and billing of the third-party API keys and accounts (for example OpenRouter, OpenAI, Anthropic) you connect to your agents.</li>
            <li><strong>Your agents:</strong> You are responsible for what your agents do with the access you give them, including automated actions and browsing.</li>
            <li><strong>Acceptable use:</strong> Do not use Hivra for anything illegal; to send spam; to attack, probe or disrupt systems you are not authorised to test; to distribute malware; to infringe other people&apos;s rights; or to get around isolation, plan limits or security controls. Security research on Hivra itself is welcome only within a published test scope.</li>
          </ul>

          <h2 className="serif">7. Your Content</h2>
          <p>You keep ownership of the files, code and data you and your agents create or store on Hivra. You give us permission to host, copy and process that content only as needed to run the service for you. We do not use it to train models.</p>
          <p>Backup coverage depends on the runtime, provider and services you use. Keep your own copies of anything important.</p>

          <h2 className="serif">8. Plans, Card Payments and Plan Changes</h2>
          <p>Paid plans are billed through Stripe for the period you choose and renew automatically until you cancel. You can cancel at any time from the billing page, which stops future charges. Your plan sets your limits, including how many agents you can run, and the billing page shows them.</p>
          <p>You can move to a higher plan at any time. Where the billing page offers a lower plan, the change applies with a credit for the unused part of your current period. Otherwise, cancel and choose the new plan.</p>
          <ReviewNote>State whether prices include VAT or sales tax (Electronic Commerce Regulations 2002, regulation 6(2)). Nothing in the billing code adds tax today.</ReviewNote>

          <h2 className="serif">9. Refunds and Your Right to Cancel</h2>
          <p><strong>7-day money-back guarantee:</strong> If you ask within 7 days of your first card payment for a paid plan, we refund that payment in full.</p>
          <p><strong>Your legal right to cancel:</strong> If you are a consumer in the UK or the EU, you also have a legal right to cancel within 14 days of buying a plan. If you cancel within those 14 days, we refund what you paid. If you expressly asked us to start the service during those 14 days and acknowledged that you would lose the right to cancel once it was fully provided, we may keep an amount for the service provided up to the point you told us you were cancelling. This right is in addition to the 7-day guarantee.</p>
          <p>To cancel or ask for a refund, use the billing page or send us any clear statement, for example an email to info@hivra.cloud. We refund within 14 days of your request, using the same payment method you paid with unless you agree otherwise.</p>
          <ReviewNote>Checkout does not currently ask customers to request an immediate start or to acknowledge the cancellation right. Until it does, a consumer who cancels within 14 days is entitled to a full refund (Consumer Contracts Regulations 2013, regulations 36 and 37).</ReviewNote>

          <h2 className="serif">10. Token Access Tiers</h2>
          <p>Holding the existing $HermesOS token in a qualifying amount can give you access to a compute tier instead of paying by card. The billing page shows the current requirements.</p>
          <p>If your qualifying balance drops below the requirement, your access continues for a grace period, currently 24 hours, and is then suspended. Limits apply to how often you can qualify again, currently a 7-day wait and twice in any 12 months.</p>
          <p><strong>Existing holders are grandfathered.</strong> If you already qualify with $HermesOS, you keep that access and can keep using $HermesOS.</p>
          <ReviewNote>Ash to set the carry-over rule: how long grandfathered $HermesOS access lasts, and what a holder who converts must hold to keep their tier. Until then, this promise has no end date.</ReviewNote>
          <p>Holding the token gives you access to the service described here and nothing else. It is not a share in Hivra and gives no right to profits, revenue, payouts or a vote.</p>

          <h2 className="serif">11. Paying in the Token</h2>
          <p>You can pay for some plans and credits in $HermesOS. Prices paid in the token can be lower than the card price. The price shown when you pay is the price that applies.</p>
          <p>Payments in $HermesOS are final, except where section 9 gives you a legal right to cancel or where we fail to provide what you paid for. When a refund of a token payment is due, we return the same amount of $HermesOS to the address it came from, unless you agree otherwise.</p>
          <ReviewNote>Counsel to review the token-payment discount and any bonus credits under the UK financial-promotion rules (FCA COBS 4.12A.7R bans incentives to invest in promotions of qualifying cryptoassets).</ReviewNote>

          <h2 className="serif">12. Deposit Wallets</h2>
          <p>When you pay or top up in the token, Hivra shows a deposit address and the exact amount to send. Send only the token named on that screen, only on the Base network, and only to that address. Check the contract address on the <Link href="/token">token page</Link>, which is the only place Hivra publishes it. Hivra never confirms addresses by direct message.</p>
          <p>Tokens sent to the wrong address, on the wrong network, in a different amount, after a quote expires, or in a different token (including any token that uses the Hivra name but is not listed on the token page) may not be credited and may not be recoverable.</p>
          <ReviewNote>Counsel to confirm whether any Hivra-controlled wallet that holds tokens for a user (deposit or holding wallets) makes Hivra a custodian, and what these Terms must then say.</ReviewNote>

          <h2 className="serif">13. The Proposed $HIVRA Token and Future Claim</h2>
          <p>$HIVRA is a proposed new token. It does not exist yet, and nothing in these Terms is an offer to sell, buy or exchange any token. If it launches, converting $HermesOS would be optional and would be governed by separate claim terms, published before claims open. Those terms would set out the conversion rate, fees and how access carries over.</p>

          <h2 className="serif">14. Cryptoasset Risks</h2>
          <p>You do not need a token to use Hivra. You can pay by card, and self-hosting needs no token. Hivra does not sell tokens and does not give investment advice. Token prices can fall, and transactions on the Base network cannot be reversed.</p>

          <h2 className="serif">15. Suspension and Ending the Service</h2>
          <p>We may suspend your access straight away if your use puts the service, other users or third parties at risk, or breaks the law or section 6. For other breaches, and for unpaid charges, we will tell you first and give you a reasonable time to fix the problem.</p>
          <p>If a computer is suspended because a plan ended or payment stopped, we email you before deleting it: at least 14 days&apos; notice for a former paid plan and at least 5 days&apos; notice on the free plan. Computers on an active paid plan are never deleted automatically.</p>
          <p>We may end the service, or a plan, for reasons not covered above by giving you at least 30 days&apos; notice, and we refund any unused part of a period you have paid for.</p>

          <h2 className="serif">16. Changes to the Service and These Terms</h2>
          <p>We only change these Terms, or a paid feature you use, for a valid reason: a change in the law, a security need, a change in what our providers offer or charge, or a change to the product. We will tell you by email or in the app at least 30 days before a change that makes things worse for you, unless it is needed sooner for legal or security reasons. If you do not accept the change, you can cancel before it takes effect and we will refund any unused part of a period you have paid for.</p>

          <h2 className="serif">17. Our Responsibility to You</h2>
          <p>We provide the service with reasonable care and skill. If we fail to do so, we are responsible for loss you suffer that is a foreseeable result of that failure. We are not responsible for loss that was not foreseeable.</p>
          <p><strong>If you are a consumer,</strong> nothing in these Terms affects your legal rights. If we do not provide the service with reasonable care and skill, you can ask us to put it right or, where that is not possible, to reduce the price or refund you.</p>
          <p><strong>If you are a business customer,</strong> we are not liable for indirect or consequential loss, or for loss of profits, revenue or goodwill, and our total liability in any 12 months is limited to the amount you paid us in that period.</p>
          <p>Nothing in these Terms limits liability for death or personal injury caused by negligence, for fraud, or for anything else that cannot be limited by law.</p>

          <h2 className="serif">18. Other Services</h2>
          <p>Hivra works with services run by others, including model providers, cloud providers, Stripe, Bankr and the Base network. Their own terms apply to your use of them. We are not responsible for their services, except where a problem is caused by our failure to meet these Terms.</p>

          <h2 className="serif">19. Law and Disputes</h2>
          <p>These Terms are governed by the law of England and Wales. If you are a consumer, you can bring a claim in the courts of the part of the UK where you live, and you keep any mandatory protections of the law of the country where you live.</p>
          <ReviewNote>Counsel to confirm the governing law once the operating entity and its location are set.</ReviewNote>

          <h2 className="serif">20. Complaints and Contact</h2>
          <p>If something goes wrong, email info@hivra.cloud and tell us what happened. We aim to reply within 5 working days and will try to put it right. Questions about these Terms can be sent to the same address.</p>
        </div>
      </main>
  </PublicSite>);
}
