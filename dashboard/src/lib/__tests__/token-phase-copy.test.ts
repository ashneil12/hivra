import { TOKEN_PHASE_COPY, getTokenPhaseCopy, type TokenPhaseCopy } from "../token-phase-copy";

/**
 * The dormant copy is the site's copy from before the phase copy existed,
 * byte for byte. Nothing visible may change until the activation PR fills in
 * hivra-token-launch.ts, so this literal must only change together with a
 * reviewed copy change.
 */
const DORMANT: TokenPhaseCopy = {
  tokenPage: {
    metadataTitle: "Hivra token: current access and proposals",
    metadataDescription:
      "Verify the existing $HermesOS contract, understand current holder access, and read the proposed $HIVRA migration. A wallet is optional.",
    heroTitle: "$HermesOS and Hivra.",
    heroLead:
      "Use Hivra and pay by card without connecting a wallet. This page explains existing holder access and the proposed $HIVRA token.",
    migrationEyebrow: "PROPOSED. NOT AVAILABLE HERE.",
    migrationHeading: "The proposed $HIVRA migration",
    migrationParagraphs: [
      "The litepaper proposes a Hivra token on Base through Bankr, with an optional active claim from $HermesOS. Keeping access and converting tokens are separate decisions.",
      "The proposed claim would sell the old tokens into their existing pool and use the ETH proceeds to buy from the new pool. Conversion terms, fees and price protections must be published with the contract before claims open. No migration action is offered on this page.",
    ],
    accessParagraph:
      "Eligible $HermesOS holdings are one way to qualify for compute access. Your account shows the verified wallet, balance and access status where holder access is enabled. Existing token payment options are shown only where available.",
  },
  tokenomics: {
    metadataTitle: "Proposed $HIVRA tokenomics",
    metadataDescription:
      "Existing token access and the proposed migration, uses and treasury. Final terms are published before proposals take effect.",
    headerLead:
      "$HermesOS is the existing token. $HIVRA is the proposed new token as HermesOS evolves into Hivra. This page explains existing compute access, the optional migration and the uses being planned.",
    migrationEyebrow: "Proposed migration",
    migrationHeading: "Keeping access and converting tokens are separate decisions.",
    migrationParagraphs: [
      "The proposal is $HIVRA on Base, launched through Bankr. An active claim would sell your old tokens into their existing pool and use the ETH proceeds to buy $HIVRA in the new pool. Bankr would run the conversion.",
      "Existing holders keep their access, without forced conversion or a claim deadline. The conversion rate, the fees and how price changes during a conversion are handled get published before claims open, along with the exact steps. Once $HIVRA launches, new users hold and pay with $HIVRA.",
    ],
    flowLabel: "Proposed claim flow",
    flowSteps: ["$HermesOS", "ETH proceeds", "$HIVRA"],
    proposalNote:
      "The migration, new uses and treasury plans are proposals. Their final terms get published before they take effect. Nothing here is an offer or an inducement to buy any asset.",
    supplyLine:
      "No presale or private round. The supply is fixed at 100 billion by the Bankr launch. Any founder allocation and its vesting get published before launch.",
  },
  evolution: {
    hivraStatus: "$HIVRA is a proposed new token on Base, to be launched through Bankr. It does not exist yet.",
    hivraDetails: [
      "Under the proposal, new users would use $HIVRA once it launches.",
      "Under the proposal, converting your $HermesOS would be optional, and the terms would be published before claims open.",
      "Under the proposal, paying in the token keeps its discount.",
    ],
    addressNote: "Everything about $HIVRA here is a proposal, not final terms. Check contract addresses only on the",
    relationship: "$HermesOS is the live token today. $HIVRA is the proposed next one.",
  },
  llmsTxt: {
    tokenomicsNote: "The live $HermesOS access tier, and the proposed $HIVRA migration and treasury (proposals, not final terms)",
    tokenStatus: "$HermesOS is the live token. $HIVRA is a proposed new token and does not exist yet.",
  },
};

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

// UK financial-promotion rule for new token-facing copy: facts only. No price,
// discount, returns, urgency or invitation to buy.
const PROMOTIONAL = /\b(buy|buying|bought|purchase|price|prices|priced|discount|discounts|cheap|cheaper|costs? less|bonus|return|returns|profit|profits|yield|invest|investment|gain|gains|early|hurry|now|today only|limited|grab|moon|pump|opportunity|don't miss)\b/i;

describe("token phase copy", () => {
  it("keeps the dormant copy byte-identical to the copy from before", () => {
    expect(getTokenPhaseCopy("dormant")).toEqual(DORMANT);
  });

  it("has the same fields in every phase", () => {
    const shape = (copy: TokenPhaseCopy) =>
      Object.fromEntries(Object.entries(copy).map(([surface, fields]) => [surface, Object.keys(fields).sort()]));
    expect(shape(TOKEN_PHASE_COPY.scheduled)).toEqual(shape(TOKEN_PHASE_COPY.dormant));
    expect(shape(TOKEN_PHASE_COPY.active)).toEqual(shape(TOKEN_PHASE_COPY.dormant));
  });

  it.each(["scheduled", "active"] as const)("writes factual %s copy: no promotion, no dashes", (phase) => {
    const copy = strings(getTokenPhaseCopy(phase));
    expect(copy.length).toBeGreaterThan(10);
    for (const text of copy) {
      expect(text).not.toMatch(PROMOTIONAL);
      expect(text).not.toMatch(/[–—]/);
    }
  });

  it.each(["scheduled", "active"] as const)("never calls a launched $HIVRA proposed or missing (%s)", (phase) => {
    for (const text of strings(getTokenPhaseCopy(phase))) {
      expect(text).not.toMatch(/proposed (new )?token|proposed \$HIVRA|does not exist|not launched|to be launched|once it launches|once \$HIVRA launches/i);
    }
    const { tokenPage, evolution, llmsTxt } = getTokenPhaseCopy(phase);
    expect(tokenPage.heroLead).toContain("$HIVRA is live on Base.");
    expect(evolution.hivraDetails).toContain(
      "Holders of legacy $HermesOS keep their existing access. Wallets that held $HermesOS at the snapshot block are sent $HIVRA automatically, with nothing to claim."
    );
    expect(llmsTxt.tokenStatus).toMatch(/^\$HIVRA is live on Base/);
  });

  it.each(["scheduled", "active"] as const)("describes the push airdrop, not a Bankr claim or swap (%s)", (phase) => {
    const text = strings(getTokenPhaseCopy(phase)).join("\n");
    expect(text).not.toMatch(/Bankr|active claim|ETH proceeds|claims open|conversion terms|Go to conversion/i);
    expect(text).toMatch(/snapshot block/);
    expect(getTokenPhaseCopy(phase).tokenPage.migrationParagraphs[1]).toMatch(/never asks anyone to connect a wallet/);
    expect(getTokenPhaseCopy(phase).tokenomics.flowSteps).toEqual(["$HermesOS", "Snapshot block", "$HIVRA"]);
  });

  it("calls $HermesOS legacy once $HIVRA is active, and keeps the token access line until then", () => {
    const active = getTokenPhaseCopy("active");
    expect(active.evolution.relationship).toBe("$HIVRA is the live token. $HermesOS is the legacy token, and its holders keep their existing access.");
    expect(active.llmsTxt.tokenStatus).toContain("$HermesOS is the legacy token");
    expect(active.tokenPage.accessParagraph).toMatch(/^Eligible \$HIVRA holdings/);
    expect(getTokenPhaseCopy("scheduled").tokenPage.accessParagraph).toBe(DORMANT.tokenPage.accessParagraph);
  });

  it("tells a scheduled reader when Hivra switches, and an active reader that it has", () => {
    expect(getTokenPhaseCopy("scheduled").tokenomics.headerLead).toContain("Hivra starts using it at the launch time on the token page");
    expect(getTokenPhaseCopy("scheduled").tokenPage.heroTitle).toBe("$HermesOS and $HIVRA.");
    expect(getTokenPhaseCopy("active").tokenPage.heroTitle).toBe("$HIVRA and $HermesOS.");
    expect(getTokenPhaseCopy("active").evolution.hivraDetails[0]).toBe("New accounts use $HIVRA for token access and token payment.");
  });
});
