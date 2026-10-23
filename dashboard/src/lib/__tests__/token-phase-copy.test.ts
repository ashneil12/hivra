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
  },
  tokenomics: {
    metadataTitle: "Proposed $HIVRA tokenomics",
    metadataDescription:
      "Existing token access and the proposed migration, uses and treasury. Final terms are published before proposals take effect.",
    headerLead:
      "$HermesOS is the existing token. $HIVRA is the proposed new token as HermesOS evolves into Hivra. This page explains existing compute access, the optional migration and the uses being planned.",
    migrationParagraphs: [
      "The plan is $HIVRA on Base, launched through Doppler. The eligibility snapshot is complete. Eligible $HermesOS holders will be able to claim $HIVRA 1:1 through Sablier, within a 90-day window that starts when claims open. You pay the claim and network fees, and you do not burn or surrender your $HermesOS.",
      "Existing holders keep their access. Claims are not open yet. The claim link, start and end times and the exact steps are published here once verified. Once $HIVRA launches, new users hold and pay with $HIVRA.",
    ],
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
      "Holders of $HermesOS keep their existing access. Conversion terms are published before conversion opens."
    );
    expect(llmsTxt.tokenStatus).toMatch(/^\$HIVRA is live on Base/);
  });

  it("tells a scheduled reader when Hivra switches, and an active reader that it has", () => {
    expect(getTokenPhaseCopy("scheduled").tokenomics.headerLead).toContain("Hivra starts using it at the launch time on the token page");
    expect(getTokenPhaseCopy("scheduled").tokenPage.heroTitle).toBe("$HermesOS and $HIVRA.");
    expect(getTokenPhaseCopy("active").tokenPage.heroTitle).toBe("$HIVRA and $HermesOS.");
    expect(getTokenPhaseCopy("active").evolution.hivraDetails[0]).toBe("New accounts use $HIVRA for token access and token payment.");
  });
});
