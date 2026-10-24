import Link from "next/link";
import { TOKEN_LAUNCH_STATUS, claimLinkAvailable, feeSumPercent } from "@/lib/token-launch-status";

const rule = { borderTop: "1px solid var(--public-line)", padding: "2rem 0" } as const;
const pct = (value: number) => `${value.toFixed(2)}%`;

/**
 * The prelaunch body of /token. Everything unverified reads "to be published"
 * because it comes from token-launch-status.ts as null.
 * NEEDS UK FINANCIAL-PROMOTION / LEGAL REVIEW BEFORE PUBLISHING.
 */
export default function PrelaunchSections() {
  const s = TOKEN_LAUNCH_STATUS;
  const m = s.migration;
  const launching = s.launch === "preparing";
  return (
    <>
      <section id="start-free" aria-labelledby="start-title" style={rule}>
        <p className="mono" style={{ fontSize: 11 }}>START HERE</p>
        <h2 id="start-title">Hivra is free to start</h2>
        <p>
          Sign up free, then connect your own cloud or server. Self-hosting is free, and Hivra Cloud computers are on a paid plan.
          The token is optional and nothing on this page is needed to use Hivra.
        </p>
        <p>
          <Link href={s.start.signUpUrl}>Sign up free</Link> · <Link href={s.start.pricingUrl}>See pricing</Link>
        </p>
      </section>

      <section id="status" aria-labelledby="status-title" style={rule}>
        <p className="mono" style={{ fontSize: 11 }}>STATUS</p>
        <h2 id="status-title">{launching ? "Token launch in preparation" : "Token launch status"}</h2>
        <ul>
          <li><strong>$HIVRA:</strong> {launching ? "Token launch in preparation. Not trading." : "See the contract section above."}</li>
          <li><strong>Migration claims:</strong> {s.claim === "not_open" ? "Migration claims not yet open." : "See the migration section below."}</li>
          <li><strong>Contract address:</strong> {s.verified.contractAddress ?? "Official contract details will be published here once verified."}</li>
        </ul>
        <p style={{ color: "var(--public-muted)" }}>
          Nothing on this page is a trading, claiming or purchase link. No dates are promised.
        </p>
      </section>

      <section id="what-is-hivra-token" aria-labelledby="what-title" style={rule}>
        <h2 id="what-title">What $HIVRA is</h2>
        <p>
          $HIVRA is planned as the successor to $HermesOS, on {s.venue.chain}, launched through {s.venue.protocol}. It is meant to
          support optional token payments and service access across Hivra. Hivra Cloud also takes ordinary payment methods, and
          self-hosting needs no token.
        </p>
        <p>
          <strong>No founder allocation of new $HIVRA is planned.</strong> The founder is paid through a disclosed share of trading
          fees, set out below.
        </p>
        <p style={{ color: "var(--public-muted)" }}>
          Holding $HIVRA is not equity, a dividend, a revenue claim or a return. It never grants control of anyone&apos;s computer
          or credentials.
        </p>
      </section>

      <section id="fees" aria-labelledby="fees-title" style={rule}>
        <p className="mono" style={{ fontSize: 11 }}>{s.feesVerifiedOnChain ? "FEE SPLIT" : "INTENDED FEE SPLIT. NOT YET VERIFIED ON-CHAIN."}</p>
        <h2 id="fees-title">Trading fees: about {pct(s.fees.totalPercent)} in total</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <caption className="sr-only">Intended share of each trade</caption>
          <thead>
            <tr><th scope="col" align="left">Use</th><th scope="col" align="right">Share of each trade</th></tr>
          </thead>
          <tbody>
            {s.fees.lines.map((line) => (
              <tr key={line.id}>
                <th scope="row" align="left" style={{ fontWeight: 600 }}>
                  {line.label}
                  <div style={{ fontWeight: 400, color: "var(--public-muted)" }}>{line.detail}</div>
                </th>
                <td align="right">{line.approximate ? "about " : ""}{pct(line.percent)}</td>
              </tr>
            ))}
            <tr>
              <th scope="row" align="left">Total</th>
              <td align="right"><strong>about {pct(feeSumPercent())}</strong></td>
            </tr>
          </tbody>
        </table>
        <p>These are percentages of trading volume, not of a smaller fee pool.</p>
        <p>
          <strong>The 0.30% is not automatically locked and does not compound by itself.</strong> It is collected separately and
          added to liquidity and locked by hand, periodically. Hivra intends to publish regular records of what was received, what
          was added, where it was locked and what is still waiting. Funds sitting in a wallet are not locked liquidity, and none of
          this guarantees price stability, liquidity at every price or any return. There is no planned fee-funded buyback, holder
          payout or price support.
        </p>
        <p style={{ color: "var(--public-muted)" }}>
          Fee recipients, the final total and any extra charges are confirmed against the deployed contracts before trading opens.
        </p>
      </section>

      <section id="migration" aria-labelledby="migration-title" style={rule}>
        <p className="mono" style={{ fontSize: 11 }}>{claimLinkAvailable() ? "CLAIMS OPEN" : "MIGRATION CLAIMS NOT YET OPEN"}</p>
        <h2 id="migration-title">Moving from {m.from} to {m.to}</h2>
        <ol>
          <li><strong>Eligibility is set.</strong> The snapshot of eligible {m.from} holdings has already been taken.</li>
          <li><strong>Eligible wallets get a {m.ratio} allocation.</strong> That is a quantity, not a promise of equal market value.</li>
          <li><strong>You claim it yourself</strong> through {m.claimTool}. It is not sent automatically, and you pay the claim and network fees.</li>
          <li><strong>The claim window is {m.claimWindowDays} days</strong>, counted from the verified claim opening, not from today.</li>
          <li><strong>Keep your {m.from}.</strong> You do not need to burn or surrender it to claim.</li>
        </ol>
        <p>
          {claimLinkAvailable() ? (
            <a href={s.verified.sablierClaimUrl ?? undefined} rel="noopener noreferrer">Open the official claim</a>
          ) : (
            "The claim link, start and end times will be published here once verified. Ignore any claim link sent to you by message or reply."
          )}
        </p>
        <h3>Founder-held {m.from}</h3>
        <p>
          After an initial {m.founder.waitWeeks}-week wait, the founder plans to sell {m.founder.weeklySaleAmount} a week for about {m.founder.approxMonths}{" "}
          months. Anything left after that schedule will be burned. Exact dates, wallets, transactions and the final burn will be
          published. This schedule and the {m.claimWindowDays}-day claim window are separate and may not end on the same day.
          Burning the founder&apos;s tokens does not burn anyone else&apos;s.
        </p>
      </section>

      <section id="follow" aria-labelledby="follow-title" style={rule}>
        <h2 id="follow-title">Hear it first, from the official account</h2>
        <p>
          Follow <a href={s.links.xUrl} target="_blank" rel="noopener noreferrer">{s.links.xHandle}</a> on X and turn on notifications.
          The launch and migration announcements will be posted there. Hivra has no Telegram and never sends claim links in DMs.
        </p>
        <p>
          <Link href={s.links.litepaperUrl}>Read the litepaper</Link> · <a href={s.links.litepaperMarkdownUrl}>Litepaper (Markdown)</a> ·{" "}
          <a href={s.links.whitepaperMarkdownUrl}>White Paper (Markdown)</a>
        </p>
      </section>
    </>
  );
}
