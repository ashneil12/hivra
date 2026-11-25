import { NextRequest } from "next/server";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { runInactivitySweep } from "@/lib/recovery/inactivity-sweep";
import { GET } from "../route";

jest.mock("@/lib/cron-heartbeat", () => ({ recordCronHeartbeat: jest.fn() }));
jest.mock("@/lib/recovery/inactivity-sweep", () => ({ runInactivitySweep: jest.fn() }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { error: jest.fn(), warn: jest.fn() } }));

const cronEnv = process.env.CRON_SECRET;
beforeEach(() => { process.env.CRON_SECRET = "local-fixture"; });
afterEach(() => {
  if (cronEnv === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = cronEnv;
});

it("requires cron authentication before selecting any holder VMs", async () => {
  const response = await GET(new NextRequest("http://localhost/api/cron/holder-inactivity-sweep"));
  expect(response.status).toBe(401);
  expect(runInactivitySweep).not.toHaveBeenCalled();
});

it("reports the Classic limitation without powering down a grandfathered VM", async () => {
  const response = await GET(new NextRequest("http://localhost/api/cron/holder-inactivity-sweep", {
    headers: { authorization: "Bearer local-fixture" },
  }));
  expect(response.status).toBe(501);
  expect(runInactivitySweep).not.toHaveBeenCalled();
  expect(recordCronHeartbeat).not.toHaveBeenCalled();
});
