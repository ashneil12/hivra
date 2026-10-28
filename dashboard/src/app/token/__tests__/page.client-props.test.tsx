/** @jest-environment node */
/**
 * What the /token server page hands its client component. TokenPageClient is a
 * client component, so every prop reaches the browser for every viewer:
 *  - `tokenSurfaces`: HIVRA_NEW_TOKEN_SURFACES is server-only, so the page says
 *    what it read (a client render left to read it sees "off" and drops the
 *    header's litepaper link, a hydration mismatch);
 *  - `airdropFacts`: only the published snapshot and the Airdrop wallet, never
 *    the Sablier campaign link or the claim window, and none for a viewer the
 *    token geo-policy blocks or while $HIVRA is dormant.
 */
import type { ReactElement } from "react";

import type { HivraTokenLaunchConfig } from "@/lib/billing/hivra-token-launch";
import type { TokenGeoDecision } from "@/lib/compliance/token-geo-gate";

import TokenVerificationPage from "../page";

jest.mock("@/lib/logger", () => ({ log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const LIVE_LAUNCH: HivraTokenLaunchConfig = {
  contractAddress: "0x1111111111111111111111111111111111111111",
  decimals: 18,
  poolId: `0x${"ab".repeat(32)}`,
  activatesAt: "2026-01-01T00:00:00Z",
};
const DORMANT_LAUNCH = { contractAddress: null, decimals: null, poolId: null, activatesAt: null };
const mockLaunch: { current: HivraTokenLaunchConfig | typeof DORMANT_LAUNCH } = { current: LIVE_LAUNCH };
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch.current;
  },
}));

const CAMPAIGN = "https://app.sablier.com/airdrops/campaign/0xabc123/";
jest.mock("@/lib/claim/hivra-airdrop-config", () => ({
  ...jest.requireActual("@/lib/claim/hivra-airdrop-config"),
  HIVRA_AIRDROP: {
    senderAddress: "0x3333333333333333333333333333333333333333",
    snapshotBlock: 36000000,
    snapshotTakenAt: "2026-10-20T16:00:00Z",
    snapshotUrl: "https://hivra.cloud/token/airdrop-snapshot",
    claim: { campaignUrl: "https://app.sablier.com/airdrops/campaign/0xabc123/", opensAt: "2026-11-01T00:00:00Z", closesAt: "2999-01-01T00:00:00Z" },
  },
}));

let mockPolicyActive = false;
jest.mock("@/lib/compliance/token-geo-policy", () => ({
  ...jest.requireActual("@/lib/compliance/token-geo-policy"),
  isTokenGeoPolicyActive: () => mockPolicyActive,
}));
let mockGeo: TokenGeoDecision = { blocked: false };
jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: async () => mockGeo }));

const SWITCH = "HIVRA_NEW_TOKEN_SURFACES";
const savedSwitch = process.env[SWITCH];

async function clientProps(): Promise<Record<string, unknown>> {
  const element = (await TokenVerificationPage()) as ReactElement<Record<string, unknown>>;
  return element.props;
}

beforeEach(() => {
  mockLaunch.current = LIVE_LAUNCH;
  mockPolicyActive = false;
  mockGeo = { blocked: false };
  process.env[SWITCH] = "1";
});

afterAll(() => {
  if (savedSwitch === undefined) delete process.env[SWITCH];
  else process.env[SWITCH] = savedSwitch;
});

describe("tokenSurfaces", () => {
  it.each([
    ["on", "1", true],
    ["off", "", false],
  ])("is what the server read when the switch is %s, launched or dormant", async (_name, value, expected) => {
    process.env[SWITCH] = value;
    expect((await clientProps()).tokenSurfaces).toBe(expected);
    mockLaunch.current = DORMANT_LAUNCH;
    expect((await clientProps()).tokenSurfaces).toBe(expected);
  });

  it("is passed on the per-request path too, blocked or not", async () => {
    mockPolicyActive = true;
    expect((await clientProps()).tokenSurfaces).toBe(true);
    mockGeo = { blocked: true, message: "Token features aren't available here." } as TokenGeoDecision;
    expect((await clientProps()).tokenSurfaces).toBe(true);
  });
});

describe("airdropFacts", () => {
  it("is the snapshot and the Airdrop wallet once $HIVRA is launched, and nothing about the Sablier claim", async () => {
    const props = await clientProps();
    expect(props.airdropFacts).toEqual({
      snapshot: { block: 36000000, url: "https://hivra.cloud/token/airdrop-snapshot", takenAt: "2026-10-20T16:00:00.000Z" },
      senderAddress: "0x3333333333333333333333333333333333333333",
    });
    const everything = JSON.stringify(props);
    expect(everything).not.toContain(CAMPAIGN);
    expect(everything).not.toMatch(/sablier\.com|opensAt|closesAt|campaignUrl|2999/);
  });

  it("is not passed at all while $HIVRA is dormant", async () => {
    mockLaunch.current = DORMANT_LAUNCH;
    const props = await clientProps();
    expect("airdropFacts" in props).toBe(false);
    expect(JSON.stringify(props)).not.toMatch(/36000000|0x3333/);
  });

  it("is passed on the per-request path for a viewer who is not blocked", async () => {
    mockPolicyActive = true;
    expect(((await clientProps()).airdropFacts as { snapshot: { block: number } }).snapshot.block).toBe(36000000);
  });

  it("is not passed to a viewer the token geo-policy blocks, who gets the notice instead", async () => {
    mockPolicyActive = true;
    mockGeo = { blocked: true, message: "Token features aren't available here." } as TokenGeoDecision;
    const props = await clientProps();
    expect(props.geoNotice).toBe("Token features aren't available here.");
    expect("airdropFacts" in props).toBe(false);
    expect(props.airdropLookupHref).toBeNull();
    expect(props.migrationHref).toBeNull();
    expect(JSON.stringify(props)).not.toMatch(/36000000|0x3333/);
  });
});

describe("receiptsHref", () => {
  it("is /token/receipts once $HIVRA is launched, on both paths", async () => {
    expect((await clientProps()).receiptsHref).toBe("/token/receipts");
    mockPolicyActive = true;
    expect((await clientProps()).receiptsHref).toBe("/token/receipts");
  });

  it("is null while $HIVRA is dormant or the switch is off, and for a blocked viewer", async () => {
    mockLaunch.current = DORMANT_LAUNCH;
    expect((await clientProps()).receiptsHref).toBeNull();
    mockLaunch.current = LIVE_LAUNCH;
    process.env[SWITCH] = "";
    expect((await clientProps()).receiptsHref).toBeNull();
    process.env[SWITCH] = "1";
    mockPolicyActive = true;
    mockGeo = { blocked: true, message: "Token features aren't available here." } as TokenGeoDecision;
    expect((await clientProps()).receiptsHref).toBeNull();
  });
});
