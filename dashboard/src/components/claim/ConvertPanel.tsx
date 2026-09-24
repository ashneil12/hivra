import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { HERMESOS_CONTRACT_ADDRESS, type ConversionState } from "@/lib/claim/conversion-state";

import { SwitchAccessStep } from "./SwitchAccessStep";
import { TokenAddressChecker } from "./TokenAddressChecker";

export const DORMANT_MESSAGE = "Conversion opens after $HIVRA launches; terms are published first.";
export const ANNOUNCED_MESSAGE = "Conversion is not open yet. Terms are published before it opens.";
export const PROPOSED_LABEL = "Proposed. Terms are published before conversion opens.";
export const LIVE_LABEL = "Optional. Read the published terms before you convert.";

function formatUtc(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

const section: CSSProperties = {
  borderTop: "1px solid var(--etched-border)",
  padding: "1.5rem 0",
};
const body: CSSProperties = { fontSize: 15, lineHeight: 1.6, margin: "0 0 0.75rem" };
const muted: CSSProperties = { ...body, color: "var(--text-secondary)" };
const addressBox: CSSProperties = {
  display: "block",
  overflowWrap: "anywhere",
  padding: "0.75rem 1rem",
  border: "1px solid var(--etched-border)",
  borderRadius: 8,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
  margin: "0 0 0.75rem",
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} style={section}>
      <h2 id={id} style={{ fontSize: 18, margin: "0 0 0.75rem" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ContractAddress({ label, address }: { label: string; address: string }) {
  return (
    <>
      <p style={body}>{label}</p>
      <code style={addressBox}>{address}</code>
      <p style={body}>
        <a href={`https://basescan.org/token/${address}`} target="_blank" rel="noopener noreferrer">
          View on BaseScan
        </a>
      </p>
    </>
  );
}

/**
 * The optional $HermesOS → $HIVRA conversion page. It never builds or sends a
 * transaction: when conversion is open it links out to the conversion service
 * in lib/claim/conversion-links-config.ts. $HIVRA comes from the token registry.
 */
export function ConvertPanel({
  state,
  geoNotice = null,
}: {
  state: ConversionState;
  /** Set when the token geo-policy blocks this viewer; conversion is then never offered. */
  geoNotice?: string | null;
}) {
  const live = !geoNotice && (state.status === "open" || state.status === "switch-access");
  return (
    <article style={{ maxWidth: 720 }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <p
          data-testid="convert-proposed-label"
          style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", margin: 0 }}
        >
          {live ? LIVE_LABEL : PROPOSED_LABEL}
        </p>
        <h1 style={{ fontSize: "clamp(1.6rem, 4vw, 2.2rem)", margin: "0.5rem 0 0.75rem" }}>Convert $HermesOS to $HIVRA</h1>
        <p style={muted}>
          {live
            ? "Converting is optional and nothing converts automatically. You choose whether to convert."
            : "As proposed, converting is optional: nothing converts automatically, there is no deadline, and you choose whether to convert."}
        </p>
      </header>

      <Section id="convert-status" title="Status">
        {geoNotice ? (
          <p data-testid="token-geo-notice" style={body}>
            {geoNotice}
          </p>
        ) : state.status === "open" ? (
          <>
            <p style={body}>
              Conversion happens on the service linked below, not inside Hivra.
            </p>
            <p style={body}>
              Read the published terms before you convert. They set out the conversion rate, the fees and any
              price-movement protection.
            </p>
            <p style={{ ...body, display: "flex", flexWrap: "wrap", gap: 16 }}>
              <a href={state.termsUrl} target="_blank" rel="noopener noreferrer">
                Read the conversion terms
              </a>
              <a href={state.conversionUrl} target="_blank" rel="noopener noreferrer">
                Go to conversion
              </a>
            </p>
          </>
        ) : state.status === "switch-access" ? (
          <>
            <SwitchAccessStep />
            <p style={{ ...body, marginTop: "0.75rem" }}>
              <a href={state.termsUrl} target="_blank" rel="noopener noreferrer">
                Read the conversion terms
              </a>
            </p>
          </>
        ) : (
          <p data-testid="convert-closed" style={body}>
            {state.status === "announced" ? ANNOUNCED_MESSAGE : DORMANT_MESSAGE}
          </p>
        )}
      </Section>

      {state.status === "dormant" ? (
        <Section id="convert-access" title="Your access">
          <p style={body}>
            Today, platform access counts the $HermesOS in your verified wallet. Converting it, or moving it out of that
            wallet, lowers that balance. The proposal is that existing holders keep their access and that keeping access
            and converting stay separate decisions. The final terms will say how this works before conversion opens.
          </p>
        </Section>
      ) : state.status === "announced" ? (
        <Section id="convert-access" title="Your access">
          <p style={body}>
            Keeping access and converting tokens are separate decisions. Billing shows which token your tier counts.
          </p>
        </Section>
      ) : state.status === "open" && !geoNotice ? (
        <Section id="convert-access" title="Your access">
          {state.graceEndsAt ? (
            <p style={body}>
              You switched your access to $HIVRA. Until {formatUtc(state.graceEndsAt)}, holding either token keeps your
              tier. After that, only $HIVRA counts.
            </p>
          ) : null}
          <p style={body}>
            Your tier counts $HIVRA. The $HIVRA you receive has to meet your tier&apos;s amount, so check what you will
            receive before you convert. Billing shows your tier.
          </p>
        </Section>
      ) : null}

      <Section id="convert-platform-wallet" title="Tokens in a Hivra wallet">
        <p style={body}>
          If your $HermesOS sits in a wallet Hivra manages for you, the published terms will say whether it can be
          converted from there. Wallet shows how to move it to a wallet you control.
        </p>
        <p style={body}>
          <Link href="/dashboard/wallet">Open Wallet</Link>
        </p>
      </Section>

      <Section id="convert-contracts" title="Official contracts">
        <ContractAddress label="$HermesOS on Base" address={HERMESOS_CONTRACT_ADDRESS} />
        {state.status === "dormant" ? (
          <p style={body}>$HIVRA has not launched. There is no official $HIVRA contract yet.</p>
        ) : (
          <ContractAddress label="$HIVRA on Base" address={state.hivraPublishedAddress} />
        )}
        <p style={muted}>
          Several tokens using the Hivra name already exist on Base. None of them is from Hivra. Hivra never sends
          contract addresses or conversion links in private messages.
        </p>
      </Section>

      <Section id="convert-check" title="Check a token address">
        <p style={muted}>Paste a contract address to see whether it is one of Hivra&apos;s tokens.</p>
        <TokenAddressChecker state={state} />
      </Section>
    </article>
  );
}
