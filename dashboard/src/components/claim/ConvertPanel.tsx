import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { HERMESOS_CONTRACT_ADDRESS, type ConversionState } from "@/lib/claim/conversion-state";

import { SwitchAccessStep } from "./SwitchAccessStep";
import { TokenAddressChecker } from "./TokenAddressChecker";

// Dormant copy: exactly what the page said before $HIVRA launched. It must not
// change until the launch block is filled in (it reveals nothing new).
export const DORMANT_MESSAGE = "Conversion opens after $HIVRA launches; terms are published first.";
export const PROPOSED_LABEL = "Proposed. Terms are published before conversion opens.";
export const DORMANT_TITLE = "Convert $HermesOS to $HIVRA";

// Launched copy: factual only (no price, returns or invitation to buy). It is
// token-facing copy and needs UK financial-promotion / legal review before any Promote.
export const LAUNCHED_TITLE = "$HIVRA for $HermesOS holders";
export const AIRDROP_LABEL = "Sent automatically. There is nothing to claim.";
export const GEO_BLOCKED_LABEL = "Token details are limited for you.";
export const SNAPSHOT_PENDING_MESSAGE =
  "The snapshot is not published yet. This page shows the snapshot block and links to the full list of wallets once it is.";
export const NO_CLAIM_WARNING =
  "Hivra never asks you to connect a wallet, sign a message, approve a transaction or pay anything to receive $HIVRA. Any site, message or account that does is not Hivra.";

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

function ContractAddress({ label, address, kind = "token" }: { label: string; address: string; kind?: "token" | "address" }) {
  return (
    <>
      <p style={body}>{label}</p>
      <code style={addressBox}>{address}</code>
      <p style={body}>
        <a href={`https://basescan.org/${kind}/${address}`} target="_blank" rel="noopener noreferrer">
          View on BaseScan
        </a>
      </p>
    </>
  );
}

type LaunchedState = Extract<ConversionState, { status: "launched" }>;

function DormantPanel({ state, geoNotice }: { state: Extract<ConversionState, { status: "dormant" }>; geoNotice: string | null }) {
  return (
    <article style={{ maxWidth: 720 }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <p
          data-testid="convert-proposed-label"
          style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", margin: 0 }}
        >
          {PROPOSED_LABEL}
        </p>
        <h1 style={{ fontSize: "clamp(1.6rem, 4vw, 2.2rem)", margin: "0.5rem 0 0.75rem" }}>{DORMANT_TITLE}</h1>
        <p style={muted}>
          As proposed, converting is optional: nothing converts automatically, there is no deadline, and you choose whether to convert.
        </p>
      </header>

      <Section id="convert-status" title="Status">
        {geoNotice ? (
          <p data-testid="token-geo-notice" style={body}>
            {geoNotice}
          </p>
        ) : (
          <p data-testid="convert-closed" style={body}>
            {DORMANT_MESSAGE}
          </p>
        )}
      </Section>

      <Section id="convert-access" title="Your access">
        <p style={body}>
          Today, platform access counts the $HermesOS in your verified wallet. Converting it, or moving it out of that
          wallet, lowers that balance. The proposal is that existing holders keep their access and that keeping access
          and converting stay separate decisions. The final terms will say how this works before conversion opens.
        </p>
      </Section>

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
        <p style={body}>$HIVRA has not launched. There is no official $HIVRA contract yet.</p>
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

function AirdropStatus({ state }: { state: LaunchedState }) {
  return (
    <>
      <p style={body}>
        Every holder on the published snapshot list is sent one $HIVRA for each $HermesOS they held at the snapshot
        block, to the same wallet. Wallets Hivra manages for you are listed separately. There is nothing to claim or
        swap, and you don&apos;t need to do anything.
      </p>
      {state.snapshot ? (
        <>
          <p data-testid="convert-snapshot-block" style={body}>
            Snapshot block:{" "}
            <a href={`https://basescan.org/block/${state.snapshot.block}`} target="_blank" rel="noopener noreferrer">
              {state.snapshot.block}
            </a>
          </p>
          <p style={body}>
            <a href={state.snapshot.url} target="_blank" rel="noopener noreferrer">
              Open the published snapshot
            </a>{" "}
            to find your wallet and the $HIVRA it is sent.
          </p>
          {state.sentAt ? (
            <p data-testid="convert-airdrop-sent" style={body}>
              Every transfer in the snapshot was confirmed on Base by {formatUtc(state.sentAt)}. Your $HIVRA is in the
              wallet that held your $HermesOS.
            </p>
          ) : (
            <p data-testid="convert-airdrop-pending" style={body}>
              The $HIVRA has not been sent yet. This page says when every transfer is confirmed.
            </p>
          )}
        </>
      ) : (
        <p data-testid="convert-snapshot-pending" style={body}>
          {SNAPSHOT_PENDING_MESSAGE}
        </p>
      )}
      {state.senderAddress ? (
        <ContractAddress label="The transfers come from Hivra's airdrop wallet:" address={state.senderAddress} kind="address" />
      ) : null}
    </>
  );
}

function AccessSection({ state, geoNotice }: { state: LaunchedState; geoNotice: string | null }) {
  const { access } = state;
  if (access.kind === "unknown") {
    return (
      <Section id="convert-access" title="Your access">
        <p style={body}>
          Receiving $HIVRA does not change your access. Billing shows which token your tier counts.
        </p>
      </Section>
    );
  }
  if (access.kind === "hivra") {
    return (
      <Section id="convert-access" title="Your access">
        {access.graceEndsAt ? (
          <p style={body}>
            You switched your access to $HIVRA. Until {formatUtc(access.graceEndsAt)}, holding either token keeps your
            tier. After that, only $HIVRA counts.
          </p>
        ) : null}
        <p style={body}>Your tier counts the $HIVRA in your verified wallet. Billing shows your tier.</p>
      </Section>
    );
  }
  if (access.kind === "switch-available" && !geoNotice) {
    return (
      <Section id="convert-access" title="Your access">
        <SwitchAccessStep />
      </Section>
    );
  }
  return (
    <Section id="convert-access" title="Your access">
      <p style={body}>
        Your tier counts the legacy $HermesOS in your verified wallet, and that continues. Moving $HermesOS out of that
        wallet lowers that balance. Billing shows your tier.
      </p>
      {access.kind === "hermesos" && !geoNotice ? (
        <p style={muted}>Once the airdrop is sent, you can choose to switch your access to $HIVRA on this page.</p>
      ) : null}
    </Section>
  );
}

function LaunchedPanel({ state, geoNotice }: { state: LaunchedState; geoNotice: string | null }) {
  return (
    <article style={{ maxWidth: 720 }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <p
          data-testid="convert-proposed-label"
          style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", margin: 0 }}
        >
          {geoNotice ? GEO_BLOCKED_LABEL : AIRDROP_LABEL}
        </p>
        <h1 style={{ fontSize: "clamp(1.6rem, 4vw, 2.2rem)", margin: "0.5rem 0 0.75rem" }}>{LAUNCHED_TITLE}</h1>
        <p style={muted}>There is nothing to claim and nothing to swap.</p>
      </header>

      <Section id="convert-status" title={geoNotice ? "Status" : "The airdrop"}>
        {geoNotice ? (
          <p data-testid="token-geo-notice" style={body}>
            {geoNotice}
          </p>
        ) : (
          <AirdropStatus state={state} />
        )}
      </Section>

      <Section id="convert-no-claim" title="Never connect a wallet to claim">
        <p data-testid="convert-no-claim" style={body}>
          {NO_CLAIM_WARNING}
        </p>
        <p style={muted}>
          Fake airdrops send lookalike tokens and link to claim sites. Check a token&apos;s contract address against the
          official contract below before you trust it.
        </p>
      </Section>

      <AccessSection state={state} geoNotice={geoNotice} />

      <Section id="convert-platform-wallet" title="Tokens in a Hivra wallet">
        <p style={body}>
          If your $HermesOS sits in a wallet Hivra manages for you, the published snapshot shows whether that wallet is
          included. Wallet shows how to move your tokens to a wallet you control.
        </p>
        <p style={body}>
          <Link href="/dashboard/wallet">Open Wallet</Link>
        </p>
      </Section>

      <Section id="convert-contracts" title="Official contracts">
        <ContractAddress label="$HIVRA on Base" address={state.hivraPublishedAddress} />
        <ContractAddress label="$HermesOS on Base (legacy)" address={HERMESOS_CONTRACT_ADDRESS} />
        <p style={muted}>
          Several tokens using the Hivra name already exist on Base. None of them is from Hivra. Hivra never sends
          contract addresses or claim links in private messages.
        </p>
      </Section>

      <Section id="convert-check" title="Check a token address">
        <p style={muted}>Paste a contract address to see whether it is one of Hivra&apos;s tokens.</p>
        <TokenAddressChecker state={state} />
      </Section>
    </article>
  );
}

/**
 * The $HermesOS holder page at /dashboard/convert. Before $HIVRA launches it
 * shows the old proposal copy unchanged. Once the registry names $HIVRA it
 * explains the push airdrop: no claim, no swap, nothing to connect. It never
 * builds or sends a transaction and links to no swap. $HIVRA comes from the
 * token registry; the airdrop facts from lib/claim/hivra-airdrop-config.ts.
 */
export function ConvertPanel({
  state,
  geoNotice = null,
}: {
  state: ConversionState;
  /**
   * Set when the token geo-policy blocks this viewer: no airdrop explanation or
   * switch step, but the official contracts, the no-claim warning and their
   * current access (and any post-switch deadline) still show.
   */
  geoNotice?: string | null;
}) {
  if (state.status === "dormant") return <DormantPanel state={state} geoNotice={geoNotice} />;
  return <LaunchedPanel state={state} geoNotice={geoNotice} />;
}
