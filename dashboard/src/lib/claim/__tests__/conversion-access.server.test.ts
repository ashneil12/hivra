import { isBillingV2ServerEnabled } from "@/lib/billing/billing-v2-availability";
import { isCryptoBillingEnabled } from "@/lib/billing/crypto-availability";
import { resolveUserTokenAccess } from "@/lib/billing/token-access";
import { getHivraTokenPhase } from "@/lib/billing/token-registry";
import { log } from "@/lib/logger";

import { readConversionAccessGate } from "../conversion-access.server";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/billing/billing-v2-availability", () => ({ isBillingV2ServerEnabled: jest.fn() }));
jest.mock("@/lib/billing/crypto-availability", () => ({ isCryptoBillingEnabled: jest.fn() }));
jest.mock("@/lib/billing/token-access", () => ({ resolveUserTokenAccess: jest.fn() }));
jest.mock("@/lib/billing/token-registry", () => ({ getHivraTokenPhase: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { error: jest.fn() } }));

const NOW = new Date("2026-10-02T00:00:00Z");

describe("readConversionAccessGate", () => {
  beforeEach(() => {
    jest.mocked(getHivraTokenPhase).mockReturnValue("active");
    jest.mocked(isBillingV2ServerEnabled).mockReturnValue(true);
    jest.mocked(isCryptoBillingEnabled).mockReturnValue(true);
  });

  it("reads grandfathering and the switch time for a signed-in user once $HIVRA is active", async () => {
    jest.mocked(resolveUserTokenAccess).mockResolvedValue({
      grandfathered: true,
      convertedAt: new Date("2026-10-01T12:00:00Z"),
      conversionGraceEndsAt: new Date("2026-10-04T12:00:00Z"),
    } as Awaited<ReturnType<typeof resolveUserTokenAccess>>);

    await expect(readConversionAccessGate("user_1", NOW)).resolves.toEqual({
      grandfathered: true,
      convertedAt: "2026-10-01T12:00:00.000Z",
      conversionGraceEndsAt: "2026-10-04T12:00:00.000Z",
    });
    expect(resolveUserTokenAccess).toHaveBeenCalledWith("user_1", { now: NOW });
  });

  it.each<[string, () => void]>([
    ["$HIVRA is not active", () => jest.mocked(getHivraTokenPhase).mockReturnValue("scheduled")],
    ["billing v2 is off, so the switch route would 404", () => jest.mocked(isBillingV2ServerEnabled).mockReturnValue(false)],
    ["crypto billing is off, so the switch route would 404", () => jest.mocked(isCryptoBillingEnabled).mockReturnValue(false)],
  ])("returns null without reading access when %s", async (_label, arrange) => {
    arrange();
    await expect(readConversionAccessGate("user_1", NOW)).resolves.toBeNull();
    expect(resolveUserTokenAccess).not.toHaveBeenCalled();
  });

  it("returns null for a signed-out request", async () => {
    await expect(readConversionAccessGate(null, NOW)).resolves.toBeNull();
    expect(resolveUserTokenAccess).not.toHaveBeenCalled();
  });

  it("fails closed and logs when the access engine throws", async () => {
    const failure = new Error("db down");
    jest.mocked(resolveUserTokenAccess).mockRejectedValue(failure);

    await expect(readConversionAccessGate("user_1", NOW)).resolves.toBeNull();
    expect(log.error).toHaveBeenCalledWith("Failed to read token access for the convert page", failure, {
      source: "dashboard/convert",
      userId: "user_1",
      failureType: "convert_access_gate_failed",
    });
  });
});
