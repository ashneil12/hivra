/** @jest-environment jsdom */
/**
 * "Check a token address" is a client component, so everything ConvertPanel
 * passes it reaches the browser for every viewer: a viewer the token geo-policy
 * blocks, and a viewer before the claim opens. It must get only the two
 * addresses it compares with, never the whole ConversionState (which carries the
 * Sablier campaign link, the claim window, the snapshot link and any config
 * problems).
 */
import "@testing-library/jest-dom";
import { render } from "@testing-library/react";

import { validateHivraLaunchConfig } from "@/lib/billing/token-registry";
import { addressCheckStateOf, resolveConversionState, type ConversionInputs } from "@/lib/claim/conversion-state";
import type { HivraAirdropConfig } from "@/lib/claim/hivra-airdrop-config";

import { ConvertPanel } from "../ConvertPanel";

const mockChecker = jest.fn();
jest.mock("../TokenAddressChecker", () => ({
  TokenAddressChecker: (props: unknown) => {
    mockChecker(props);
    return null;
  },
}));
jest.mock("../SwitchAccessStep", () => ({ SwitchAccessStep: () => null }));

const TEST_HIVRA = "0x1111111111111111111111111111111111111111";
const TEST_SENDER = "0x3333333333333333333333333333333333333333";
const CAMPAIGN_URL = "https://app.sablier.com/airdrops/campaign/0xabc123/";
const SNAPSHOT_URL = "https://hivra.cloud/token/airdrop-snapshot";
const NOW = new Date("2026-10-03T12:00:00Z");
const AIRDROP: HivraAirdropConfig = {
  senderAddress: TEST_SENDER,
  snapshotBlock: 36_000_000,
  snapshotTakenAt: "2026-10-01T00:00:00Z",
  snapshotUrl: SNAPSHOT_URL,
  claim: { campaignUrl: CAMPAIGN_URL, opensAt: "2026-10-10T00:00:00Z", closesAt: "2026-10-31T18:00:00Z" },
};
const launch = validateHivraLaunchConfig({
  contractAddress: TEST_HIVRA,
  decimals: 18,
  poolId: `0x${"ab".repeat(32)}`,
  activatesAt: "2026-10-01T16:00:00Z",
});
const hivra = launch.status === "configured" ? launch.token : null;
const BASE: ConversionInputs = { hivra: null, phase: "dormant", airdrop: AIRDROP, access: null, now: NOW };

beforeEach(() => mockChecker.mockClear());

describe("what ConvertPanel hands the address checker", () => {
  it("is only the two addresses once $HIVRA is launched, before the claim opens", () => {
    const state = resolveConversionState({ ...BASE, hivra, phase: "active" });
    // Sanity: the full state does carry the claim link and window, which is why it must not be passed.
    expect(JSON.stringify(state)).toContain(CAMPAIGN_URL);
    render(<ConvertPanel state={state} />);

    expect(mockChecker).toHaveBeenCalledTimes(1);
    const props = mockChecker.mock.calls[0][0] as { state: unknown };
    expect(props.state).toEqual({ status: "launched", hivraAddress: TEST_HIVRA, senderAddress: TEST_SENDER });
    const sent = JSON.stringify(props);
    for (const secret of [CAMPAIGN_URL, SNAPSHOT_URL, "sablier", "opensAt", "closesAt", "problems", "36000000"]) expect(sent).not.toContain(secret);
  });

  it("is the same two addresses for a viewer the token geo-policy blocks", () => {
    const state = resolveConversionState({ ...BASE, hivra, phase: "active" });
    render(<ConvertPanel state={state} geoNotice="Token features aren't available to you." />);

    const props = mockChecker.mock.calls[0][0] as { state: unknown };
    expect(props.state).toEqual({ status: "launched", hivraAddress: TEST_HIVRA, senderAddress: TEST_SENDER });
    expect(JSON.stringify(props)).not.toContain("sablier");
  });

  it("is just the dormant status while $HIVRA has not launched", () => {
    render(<ConvertPanel state={resolveConversionState(BASE)} />);
    const props = mockChecker.mock.calls[0][0] as { state: { status: string } };
    expect(props.state.status).toBe("dormant");
    expect(JSON.stringify(props)).not.toMatch(/sablier|0x3333|36000000/);
  });
});

describe("addressCheckStateOf", () => {
  it("keeps only the status and the two addresses of a launched state", () => {
    const state = resolveConversionState({ ...BASE, hivra, phase: "active" });
    expect(Object.keys(addressCheckStateOf(state)).sort()).toEqual(["hivraAddress", "senderAddress", "status"]);
  });

  it("keeps the Airdrop wallet null when none is published", () => {
    const state = resolveConversionState({ ...BASE, hivra, phase: "active", airdrop: { ...AIRDROP, senderAddress: null } });
    expect(addressCheckStateOf(state)).toEqual({ status: "launched", hivraAddress: TEST_HIVRA, senderAddress: null });
  });
});
