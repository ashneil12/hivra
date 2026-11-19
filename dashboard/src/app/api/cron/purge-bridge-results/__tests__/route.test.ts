/** @jest-environment node */
import { NextRequest } from "next/server";

jest.mock("@/lib/local-bridge/flag", () => ({ isLocalBridgeEnabled: jest.fn() }));
jest.mock("@/lib/local-bridge/store", () => ({ expireStalePending: jest.fn(async () => undefined), closeStuckRequests: jest.fn(async () => undefined), purgeAllOldResults: jest.fn(async () => undefined) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
  apiError: (error: string, status: number) => Response.json({ success: false, error }, { status }),
}));

import { isLocalBridgeEnabled } from "@/lib/local-bridge/flag";
import { closeStuckRequests, expireStalePending, purgeAllOldResults } from "@/lib/local-bridge/store";
import { GET } from "../route";

const call = (secret: string | null) => new NextRequest("https://canary.hermesos.cloud/api/cron/purge-bridge-results", {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "cron-secret";
  jest.mocked(isLocalBridgeEnabled).mockReturnValue(true);
});

describe("purge-bridge-results cron", () => {
  it("needs the cron secret", async () => {
    expect((await GET(call(null))).status).toBe(401);
    expect((await GET(call("wrong"))).status).toBe(401);
    expect(purgeAllOldResults).not.toHaveBeenCalled();
  });

  it("does nothing while the bridge is off", async () => {
    jest.mocked(isLocalBridgeEnabled).mockReturnValue(false);
    expect((await GET(call("cron-secret"))).status).toBe(200);
    expect(purgeAllOldResults).not.toHaveBeenCalled();
  });

  it("clears old output and expires unanswered requests", async () => {
    expect((await GET(call("cron-secret"))).status).toBe(200);
    expect(expireStalePending).toHaveBeenCalledTimes(1);
    expect(closeStuckRequests).toHaveBeenCalledTimes(1);
    expect(purgeAllOldResults).toHaveBeenCalledTimes(1);
  });
});
