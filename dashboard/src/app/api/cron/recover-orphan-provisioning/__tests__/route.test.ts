import { NextRequest } from "next/server";

import { GET } from "../route";
import { runRecoverOrphanProvisioningSweep } from "@/lib/recovery/recover-orphan-provisioning";

jest.mock("@/lib/recovery/recover-orphan-provisioning", () => ({
  runRecoverOrphanProvisioningSweep: jest.fn(),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("GET /api/cron/recover-orphan-provisioning", () => {
  const originalEnv = process.env;
  const mockedSweep = runRecoverOrphanProvisioningSweep as jest.MockedFunction<
    typeof runRecoverOrphanProvisioningSweep
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "expected-secret" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const makeRequest = (authorization?: string, id?: string) =>
    new Request(`http://localhost/api/cron/recover-orphan-provisioning${id ? `?id=${id}` : ""}`, {
      headers: authorization ? { authorization } : {},
    }) as unknown as NextRequest;

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(500);
    expect(mockedSweep).not.toHaveBeenCalled();
  });

  it("rejects requests with the wrong bearer", async () => {
    const res = await GET(makeRequest("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(mockedSweep).not.toHaveBeenCalled();
  });

  it("returns the sweep summary on success", async () => {
    mockedSweep.mockResolvedValue({ candidates: 2, recovered: 1, notFound: 1, errors: 0 });
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ candidates: 2, recovered: 1, notFound: 1, errors: 0 });
    expect(mockedSweep).toHaveBeenCalledWith({ instanceId: null });
  });

  it("passes a targeted instance id to the sweep", async () => {
    mockedSweep.mockResolvedValue({ candidates: 1, recovered: 1, notFound: 0, errors: 0 });
    const res = await GET(makeRequest("Bearer expected-secret", "inst_507"));
    expect(res.status).toBe(200);
    expect(mockedSweep).toHaveBeenCalledWith({ instanceId: "inst_507" });
  });

  it("returns 500 when the sweep throws", async () => {
    mockedSweep.mockRejectedValue(new Error("boom"));
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(500);
  });
});
