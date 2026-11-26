import { NextRequest } from "next/server";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { runClassicHolderSweep } from "@/lib/recovery/classic-holder-idle";
import { GET } from "../route";

jest.mock("@/lib/cron-heartbeat", () => ({ recordCronHeartbeat: jest.fn() }));
jest.mock("@/lib/recovery/classic-holder-idle", () => ({ runClassicHolderSweep: jest.fn() }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { error: jest.fn(), warn: jest.fn() } }));

const cronEnv = process.env.CRON_SECRET;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "local-fixture";
});
afterEach(() => {
  if (cronEnv === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = cronEnv;
});

it("requires cron authentication before running the sweep", async () => {
  const response = await GET(new NextRequest("http://localhost/api/cron/holder-inactivity-sweep"));

  expect(response.status).toBe(401);
  expect(runClassicHolderSweep).not.toHaveBeenCalled();
  expect(recordCronHeartbeat).not.toHaveBeenCalled();
});

it("forwards the sweep summary and records one heartbeat", async () => {
  const outcomes = { napping: 1 };
  jest.mocked(runClassicHolderSweep).mockResolvedValueOnce(outcomes);

  const response = await GET(new NextRequest("http://localhost/api/cron/holder-inactivity-sweep", {
    headers: { authorization: "Bearer local-fixture" },
  }));

  expect(response.status).toBe(200);
  expect((await response.json()).data.outcomes).toEqual(outcomes);
  expect(runClassicHolderSweep).toHaveBeenCalledTimes(1);
  expect(recordCronHeartbeat).toHaveBeenCalledTimes(1);
  expect(recordCronHeartbeat).toHaveBeenCalledWith("holder-inactivity-sweep");
});

it("returns 500 without recording a heartbeat when the sweep rejects", async () => {
  jest.mocked(runClassicHolderSweep).mockRejectedValueOnce(new Error("sweep failed"));

  const response = await GET(new NextRequest("http://localhost/api/cron/holder-inactivity-sweep", {
    headers: { authorization: "Bearer local-fixture" },
  }));

  expect(response.status).toBe(500);
  expect(runClassicHolderSweep).toHaveBeenCalledTimes(1);
  expect(recordCronHeartbeat).not.toHaveBeenCalled();
});
