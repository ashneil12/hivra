import { auth } from "@clerk/nextjs/server";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/billing/token-access", () => ({
  ...jest.requireActual("@/lib/billing/token-access"),
  resolveUserTokenAccess: jest.fn(),
}));
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0x2222222222222222222222222222222222222222",
    decimals: 18,
    poolId: `0x${"cd".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
}));
// The live price gate behind readiness (hivra-readiness.ts).
const mockGatedPrice = jest.fn();
jest.mock("@/lib/billing/live-thresholds", () => ({
  ...jest.requireActual("@/lib/billing/live-thresholds"),
  getGatedPlatformTokenPrice: (...args: unknown[]) => mockGatedPrice(...args),
}));

import { GET } from "../route";
import { computeUserTokenAccess, resolveUserTokenAccess } from "@/lib/billing/token-access";
import { _resetHivraReadinessForTests } from "@/lib/billing/hivra-readiness";

const NOW = new Date();
const newUser = computeUserTokenAccess({ phase: "active", cohort: null, now: NOW });
const grandfathered = computeUserTokenAccess({
  phase: "active",
  cohort: { user_id: "u", converted_at: null, conversion_grace_ends_at: null, metadata: {} },
  now: NOW,
});
const dormant = computeUserTokenAccess({ phase: "dormant", cohort: null, now: NOW });

beforeEach(() => {
  jest.clearAllMocks();
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "u" });
  _resetHivraReadinessForTests();
  mockGatedPrice.mockResolvedValue({ price: { priceUsd: "0.05" }, fetchedAt: new Date() });
});

it("needs a signed-in user", async () => {
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
  expect((await GET()).status).toBe(401);
});

it("offers $HermesOS payments before $HIVRA is active, without checking readiness", async () => {
  (resolveUserTokenAccess as jest.Mock).mockResolvedValue(dormant);
  const body = await (await GET()).json();
  expect(body.data).toEqual({ available: true, paymentToken: "hermesos", displayUnit: "$HermesOS" });
  expect(mockGatedPrice).not.toHaveBeenCalled();
});

it("hides token payments from a new account while $HIVRA is not usable", async () => {
  (resolveUserTokenAccess as jest.Mock).mockResolvedValue(newUser);
  mockGatedPrice.mockRejectedValue(new Error("pool below the ETH-side floor"));
  const body = await (await GET()).json();
  expect(body.data).toMatchObject({ available: false, paymentToken: "hivra" });
});

it("offers them once $HIVRA is usable", async () => {
  (resolveUserTokenAccess as jest.Mock).mockResolvedValue(newUser);
  const body = await (await GET()).json();
  expect(body.data).toEqual({ available: true, paymentToken: "hivra", displayUnit: "$HIVRA" });
});

it("leaves a grandfathered account unchanged", async () => {
  (resolveUserTokenAccess as jest.Mock).mockResolvedValue(grandfathered);
  mockGatedPrice.mockRejectedValue(new Error("pool below the ETH-side floor"));
  const body = await (await GET()).json();
  expect(body.data).toEqual({ available: true, paymentToken: "hermesos", displayUnit: "$HermesOS" });
  expect(mockGatedPrice).not.toHaveBeenCalled();
});
