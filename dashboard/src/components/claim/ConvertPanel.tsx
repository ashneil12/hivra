import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { HERMESOS_CONTRACT_ADDRESS, addressCheckStateOf, type ConversionState } from "@/lib/claim/conversion-state";
import { formatUtcInstant as formatUtc } from "@/lib/claim/hivra-claim";

import { SwitchAccessStep } from "./SwitchAccessStep";
import { TokenAddressChecker } from "./TokenAddressChecker";

// Dormant copy: exactly what the page said before $HIVRA launched. It must not
// change until the launch block is filled in (it reveals nothing new).
export const DORMANT_MESSAGE = "Conversion opens after $HIVRA launches; terms are published first.";
export const PROPOSED_LABEL = "Proposed. Terms are published before conversion opens.";
export const DORMANT_TITLE = "Convert $HermesOS to $HIVRA";

// Launched copy: factual only (no price, returns or invitation to buy). It is
// token-facing copy and needs UK financial-promotion / legal review before any Promote.
// Sentences come from Ash's pack (01-token.md, 02-token-migration.md and
// 03-token-airdrop.md) wherever they exist; only the two lines marked "new
// copy" are not from it.
export const LAUNCHED_TITLE = "$HIVRA for $HermesOS holders";
export const CLAIM_LABEL = "Claims are not automatic.";
export const CLAIM_LEAD = "Eligible holders can claim $HIVRA through Sablier based on the snapshot already taken.";
export const GEO_BLOCKED_LABEL = "Token details are limited for you.";
export const SNAPSHOT_PENDING_MESSAGE =
  "The snapshot is not published yet. This page shows the snapshot block and links to the full list of wallets once it is.";
export const CLAIM_SAFETY_TITLE = "Claim safely";
export const CLAIM_SAFETY_WALLET =
  "A legitimate Sablier claim involves connecting a wallet and authorising the necessary claim transaction.";
export const CLAIM_SAFETY_DM =
  "Never follow a claim link from a DM. Start from Hivra's official site and check the contract and transaction details before signing.";
export const CLAIM_SAFETY_LOOKALIKE =
  "Tokens can share a name or symbol without being connected to Hivra. Always compare the full address before interacting with one.";
// New copy (not in the pack): why the optional switch is not offered yet.
export const SWITCH_AFTER_CLAIM_MESSAGE =
  "After the claim window closes, you can choose to switch your access to $HIVRA on this page.";

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
        <TokenAddressChecker state={addressCheckStateOf(state)} />
      </Section>
    </article>
  );
}

/**
 * The claim, in the pack's own sentences. The Sablier link itself is not here:
 * it lives on /token/airdrop (linked below when that page is served) so the
 * official link has one home.
 */
function ClaimStatus({ state, lookupHref }: { state: LaunchedState; lookupHref: string | null }) {
  const { claim } = state;
  return (
    <>
      <p style={body}>
        The allocation is one $HIVRA for each $HermesOS held in an eligible wallet at the snapshot block. You don&apos;t
        need to burn or surrender your original $HermesOS tokens.
      </p>
      <p style={body}>
        This is a claim, not an automatic transfer. Claiming requires a wallet transaction, and you pay the applicable
        claim and network fees. You&apos;ll be shown the relevant costs before confirming.
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
              View the published snapshot
            </a>
          </p>
          {claim.opensAt && claim.closesAt ? (
            <p data-testid="convert-claim-window" style={body}>
              Claim window: {formatUtc(claim.opensAt)} to {formatUtc(claim.closesAt)}
            </p>
          ) : null}
          {lookupHref ? (
            <p data-testid="convert-airdrop-lookup" style={body}>
              <Link href={lookupHref}>Check eligibility and claim through the official Sablier flow</Link>
            </p>
          ) : null}
        </>
      ) : (
        <p data-testid="convert-snapshot-pending" style={body}>
          {SNAPSHOT_PENDING_MESSAGE}
        </p>
      )}
      {state.senderAddress ? <ContractAddress label="Airdrop wallet:" address={state.senderAddress} kind="address" /> : null}
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
      {/* Only with a known closing time and a published snapshot: the switch opens only after both (resolveConversionState), so without them the line would promise a switch that never opens. */}
      {access.kind === "hermesos" && !geoNotice && state.snapshot && state.claim.closesAt && state.claim.phase !== "closed" ? (
        <p data-testid="convert-switch-later" style={muted}>{SWITCH_AFTER_CLAIM_MESSAGE}</p>
      ) : null}
    </Section>
  );
}

function LaunchedPanel({
  state,
  geoNotice,
  airdropLookupHref,
  migrationHref,
}: {
  state: LaunchedState;
  geoNotice: string | null;
  airdropLookupHref: string | null;
  migrationHref: string | null;
}) {
  return (
    <article style={{ maxWidth: 720 }}>
      <header style={{ marginBottom: "1.5rem" }}>
        <p
          data-testid="convert-proposed-label"
          style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", margin: 0 }}
        >
          {geoNotice ? GEO_BLOCKED_LABEL : CLAIM_LABEL}
        </p>
        <h1 style={{ fontSize: "clamp(1.6rem, 4vw, 2.2rem)", margin: "0.5rem 0 0.75rem" }}>{LAUNCHED_TITLE}</h1>
        {geoNotice ? null : <p style={muted}>{CLAIM_LEAD}</p>}
      </header>

      <Section id="convert-status" title={geoNotice ? "Status" : "Claim your allocation"}>
        {geoNotice ? (
          <p data-testid="token-geo-notice" style={body}>
            {geoNotice}
          </p>
        ) : (
          <>
            <ClaimStatus state={state} lookupHref={airdropLookupHref} />
            {migrationHref ? (
              <p data-testid="convert-migration-link" style={body}>
                <Link href={migrationHref}>Read the migration details</Link>
              </p>
            ) : null}
          </>
        )}
      </Section>

      <Section id="convert-claim-safety" title={CLAIM_SAFETY_TITLE}>
        <div data-testid="convert-claim-safety">
          {geoNotice ? null : <p style={body}>{CLAIM_SAFETY_WALLET}</p>}
          <p style={body}>{CLAIM_SAFETY_DM}</p>
          <p style={muted}>{CLAIM_SAFETY_LOOKALIKE}</p>
        </div>
      </Section>

      <AccessSection state={state} geoNotice={geoNotice} />

      <Section id="convert-platform-wallet" title="Tokens in a Hivra wallet">
        <p style={body}>
          If your $HermesOS sits in a wallet Hivra manages for you, Wallet shows how to move your tokens to a wallet you
          control.
          {airdropLookupHref ? (
            <>
              {" "}
              Hivra-managed wallets are handled separately as explained on the{" "}
              <Link href={airdropLookupHref}>airdrop page</Link>.
            </>
          ) : null}
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
        <TokenAddressChecker state={addressCheckStateOf(state)} />
      </Section>
    </article>
  );
}

/**
 * The $HermesOS holder page at /dashboard/convert. Before $HIVRA launches it
 * shows the old proposal copy unchanged. Once the registry names $HIVRA it
 * explains the claim: eligible holders claim $HIVRA through Sablier, one for
 * one, and pay the claim fee; nothing is pushed to a wallet and no burn or
 * surrender of $HermesOS is needed. It never builds or sends a transaction and
 * carries no Sablier link of its own (it points at /token/airdrop, where the
 * official link lives). $HIVRA comes from the token registry; the claim facts
 * from lib/claim/hivra-airdrop-config.ts. The optional "switch your access"
 * step stays hidden until the claim window has closed.
 */
export function ConvertPanel({
  state,
  geoNotice = null,
  airdropLookupHref = null,
  migrationHref = null,
}: {
  state: ConversionState;
  /**
   * Set when the token geo-policy blocks this viewer: no claim explanation or
   * switch step, but the official contracts, the claim-safety lines and their
   * current access (and any post-switch deadline) still show.
   */
  geoNotice?: string | null;
  /** /token/airdrop, set by the server only when that lookup is served and the viewer is not blocked. */
  airdropLookupHref?: string | null;
  /** /token/migration, set by the server only when that page is served and the viewer is not blocked. */
  migrationHref?: string | null;
}) {
  if (state.status === "dormant") return <DormantPanel state={state} geoNotice={geoNotice} />;
  return (
    <LaunchedPanel
      state={state}
      geoNotice={geoNotice}
      airdropLookupHref={geoNotice ? null : airdropLookupHref}
      migrationHref={geoNotice ? null : migrationHref}
    />
  );
}
