import {
  TOKEN_PHASE_COPY,
  getTokenPhaseCopy,
  type TokenPagePhaseCopy,
  type TokenPhaseCopy,
  type TokenomicsPhaseCopy,
} from "../token-phase-copy";

/**
 * The dormant copy is the site's copy from before the phase copy existed,
 * byte for byte. Nothing visible may change until the activation PR fills in
 * hivra-token-launch.ts, so this literal must only change together with a
 * reviewed copy change.
 */
const DORMANT: TokenPhaseCopy & { tokenPage: TokenPagePhaseCopy; tokenomics: TokenomicsPhaseCopy } = {
  tokenPage: {
    metadataTitle: "Hivra token: current access and proposals",
    metadataDescription:
      "Verify the existing $HermesOS contract, understand current holder access, and read the plan for $HIVRA and the $HermesOS migration. A wallet is optional.",
    heroTitle: "$HermesOS and Hivra.",
    heroLead:
      "Use Hivra and pay by card without connecting a wallet. This page explains existing holder access and the planned $HIVRA token. The launch is in preparation and nothing is trading yet.",
    migrationEyebrow: "PROPOSED. NOT AVAILABLE HERE.",
    migrationHeading: "The planned $HIVRA migration",
    migrationParagraphs: [
      "$HIVRA is planned for Base, launched through Doppler. Eligible $HermesOS holders will be able to claim $HIVRA 1:1 through Sablier, without burning anything. Keeping access and claiming are separate decisions.",
      "The eligibility snapshot is complete. Claims are not open yet, and the contract, claim link and times are published here once verified. No migration action is offered on this page.",
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
      "The plan is $HIVRA on Base, launched through Doppler. The eligibility snapshot is complete. Eligible $HermesOS holders will be able to claim $HIVRA 1:1 through Sablier, within a 90-day window that starts when claims open. You pay the claim and network fees, and you do not burn or surrender your $HermesOS.",
      "Existing holders keep their access. Claims are not open yet. The claim link, start and end times and the exact steps are published here once verified. Once $HIVRA launches, new users hold and pay with $HIVRA.",
    ],
    flowLabel: "Proposed claim flow",
    flowSteps: ["$HermesOS", "ETH proceeds", "$HIVRA"],
    proposalNote:
      "The migration, new uses and treasury plans are proposals. Their final terms get published before they take effect. Nothing here is an offer or an inducement to buy any asset.",
    supplyLine:
      "No presale or private round. The supply is fixed at 100 billion by the Bankr launch. Any founder allocation and its vesting get published before launch.",
  },
  evolution: {
    hivraStatus: "$HIVRA is a planned new token on Base, to be launched through Doppler. Launch is in preparation and it does not exist yet.",
    hivraDetails: [
      "Under the proposal, new users would use $HIVRA once it launches.",
      "Claiming $HIVRA from your $HermesOS snapshot is optional, and claims are not open yet.",
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

  it("has the same fields in every phase, except the /token and /tokenomics bodies, which only the dormant pages read", () => {
    const shape = (copy: TokenPhaseCopy) =>
      Object.fromEntries(
        Object.entries(copy)
          .filter(([surface]) => surface !== "tokenPage" && surface !== "tokenomics")
          .map(([surface, fields]) => [surface, Object.keys(fields).sort()]),
      );
    expect(shape(TOKEN_PHASE_COPY.scheduled)).toEqual(shape(TOKEN_PHASE_COPY.dormant));
    expect(shape(TOKEN_PHASE_COPY.active)).toEqual(shape(TOKEN_PHASE_COPY.dormant));
    // Launched /token and /tokenomics render Ash's website pack (TokenLaunchedView.tsx, TokenomicsLaunchedView.tsx);
    // the phase copy holds only their head.
    for (const phase of ["scheduled", "active"] as const) {
      expect(Object.keys(TOKEN_PHASE_COPY[phase].tokenPage).sort()).toEqual(["metadataDescription", "metadataTitle"]);
      expect(Object.keys(TOKEN_PHASE_COPY[phase].tokenomics).sort()).toEqual(["metadataDescription", "metadataTitle"]);
    }
  });

  it.each(["scheduled", "active"] as const)("uses Ash's /token title and search description verbatim (%s)", (phase) => {
    expect(getTokenPhaseCopy(phase).tokenPage).toEqual({
      metadataTitle: "Hivra tokens | Official contracts, migration and holder access",
      metadataDescription:
        "Verify the official $HIVRA and legacy $HermesOS contracts on Base. Understand the snapshot-based Sablier claim, existing access and proposed token uses.",
    });
  });

  it.each(["scheduled", "active"] as const)(
    "uses Ash's /tokenomics title and search description verbatim, the title without the suffix the root layout adds (%s)",
    (phase) => {
      expect(getTokenPhaseCopy(phase).tokenomics).toEqual({
        // The pack's browser title is "$HIVRA tokenomics: access, migration and future uses | Hivra"; "%s | Hivra" adds the end.
        metadataTitle: "$HIVRA tokenomics: access, migration and future uses",
        metadataDescription:
          "How Hivra's token access works, how eligible $HermesOS holders claim $HIVRA, and what token-based services Hivra is considering next.",
      });
    },
  );

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
      // "proposed token uses" (Ash's /token description) names proposed uses, not a proposed token.
      expect(text).not.toMatch(/proposed (new )?token(?! uses)|proposed \$HIVRA|does not exist|not launched|to be launched|once it launches|once \$HIVRA launches/i);
    }
    const { evolution, llmsTxt } = getTokenPhaseCopy(phase);
    // Ash's pack replaces the two lines under the status on /why-hivra/evolution, word for word.
    expect(evolution.hivraDetails).toEqual([
      "New $HIVRA-based access and payments become available only once the published activation conditions have been met.",
      "Holders of legacy $HermesOS keep their existing access. Eligible snapshot holders can claim $HIVRA through the official Sablier campaign. The claimant pays the applicable claim and network fees; no legacy-token burn is required.",
    ]);
    expect(llmsTxt.tokenStatus).toMatch(/^\$HIVRA is live on Base/);
  });

  it.each(["scheduled", "active"] as const)("describes the holder-paid Sablier claim, never an automatic airdrop, a Bankr claim or new accounts using $HIVRA (%s)", (phase) => {
    const text = strings(getTokenPhaseCopy(phase)).join("\n");
    expect(text).not.toMatch(/Bankr|active claim|ETH proceeds|claims open|conversion terms|Go to conversion/i);
    expect(text).not.toMatch(/airdrop|sent automatically|automatically|nothing to claim|never connect a wallet|new accounts use|new users hold|new hivra accounts use|starts using it|launch time/i);
    expect(text).toMatch(/Sablier/);
    expect(text).toMatch(/claimant pays the applicable claim and network fees/);
    expect(text).toMatch(/no legacy-token burn is required/);
    // New $HIVRA-based access and payments follow published conditions; the token being live does not switch them on.
    expect(text).toMatch(/only once the published activation conditions have been met/);
  });

  it("calls $HermesOS legacy once $HIVRA is active", () => {
    const active = getTokenPhaseCopy("active");
    expect(active.evolution.relationship).toBe("$HIVRA is the live token. $HermesOS is the legacy token, and its holders keep their existing access.");
    expect(active.llmsTxt.tokenStatus).toContain("$HermesOS is the legacy token");
  });

  it("reads the same launched copy whether $HIVRA is scheduled or active", () => {
    expect(TOKEN_PHASE_COPY.scheduled).toEqual(TOKEN_PHASE_COPY.active);
  });
});
