import Link from "next/link";
import styles from "./TokenFacts.module.css";
import PublicSite from "@/components/public-site/PublicSite";
import { tokenVerificationContent } from "@/lib/token-verification-content";

export default function TokenPageClient() {
  const contract = tokenVerificationContent.tokenDetails.contractAddress;
  return <PublicSite>
    <main className={styles.content} id="main-content" style={{ maxWidth: 1000, margin: "0 auto", padding: "clamp(3rem, 8vw, 7rem) var(--public-gutter)", lineHeight: 1.7 }}>
      <Link href="/ecosystem">Ecosystem</Link>
      <header style={{ margin: "2rem 0 3rem", maxWidth: 760 }}>
        <p className="mono" style={{ color: "var(--public-accent)", fontSize: 11 }}>OPTIONAL TOKEN</p>
        <h1 style={{ fontSize: "clamp(2.8rem, 7vw, 5rem)", lineHeight: 1.05, margin: "1rem 0" }}>$HermesOS and Hivra.</h1>
        <p style={{ fontSize: "1.2rem", color: "var(--public-muted)" }}>Use Hivra and pay by card without connecting a wallet. This page explains existing holder access and the proposed $HIVRA token.</p>
      </header>
      <section id="verify" aria-labelledby="verify-title" style={{ borderTop: "1px solid var(--public-line)", padding: "2rem 0" }}>
        <h2 id="verify-title">Verify the existing token</h2>
        <p>The existing token is $HermesOS on Base. Compare the full contract address before using it.</p>
        <code style={{ display: "block", overflowWrap: "anywhere", padding: "1rem", border: "1px solid var(--public-line)" }}>{contract}</code>
        <p><a href={`https://basescan.org/token/${contract}`} target="_blank" rel="noopener noreferrer">View the contract on BaseScan</a></p>
        <p style={{ color: "var(--public-muted)" }}>This is the existing $HermesOS contract, not a new $HIVRA contract. Hivra does not confirm token details through private messages.</p>
      </section>
      <section id="live-now" aria-labelledby="access-title" style={{ borderTop: "1px solid var(--public-line)", padding: "2rem 0" }}>
        <p className="mono" style={{ fontSize: 11 }}>CURRENT ACCESS</p>
        <h2 id="access-title">Existing holder access</h2>
        <p>Eligible $HermesOS holdings are one way to qualify for compute access. Your account shows the verified wallet, balance and access status where holder access is enabled. Existing token payment options are shown only where available.</p>
        <p>Open Billing &amp; Access to check your plan or manage an existing entitlement. Connecting a wallet is an optional action; ordinary card billing does not require one.</p>
        <Link href="/dashboard/billing">Open Billing &amp; Access</Link>
        <p style={{ color: "var(--public-muted)" }}>Self-hosting requires neither a token nor a Hivra account. A token balance never grants wider permissions on a computer or access to another person’s credentials.</p>
      </section>
      <section id="proposals" aria-labelledby="proposals-title" style={{ borderTop: "1px solid var(--public-line)", padding: "2rem 0" }}>
        <p className="mono" style={{ fontSize: 11 }}>PROPOSED. NOT AVAILABLE HERE.</p>
        <h2 id="proposals-title">The proposed $HIVRA migration</h2>
        <p>The litepaper proposes a Hivra token on Base through Bankr, with an optional active claim from $HermesOS. Keeping access and converting tokens are separate decisions.</p>
        <p>The proposed claim would sell the old tokens into their existing pool and use the ETH proceeds to buy from the new pool. Conversion terms, fees and price protections must be published with the contract before claims open. No migration action is offered on this page.</p>
        <h3>Utility and treasury proposals</h3>
        <p>The wider proposal includes payments for useful work, publisher payouts, certification, agent budgets and Nibbii products. Each depends on its own implementation and published terms. The ecosystem map shows which products are Next, Then or Research.</p>
        <p>Proposed treasury spending would support development, operations and contributors. Spending rules, wallets and signing authority must be published before it starts. These proposals create no holder payout, company ownership, revenue claim, staking or yield.</p>
        <p><a href="/docs/litepaper/">Read the full litepaper and economy proposal</a></p>
      </section>
    </main>
  </PublicSite>;
}
