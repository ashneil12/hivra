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

it("runs only the holder pass on the minute tick", async () => {
  (runInactivitySweep as jest.Mock).mockResolvedValue({ scanned: 0, swept: 0, failed: 0 });
  const response = await GET(new NextRequest("http://localhost/api/cron/holder-inactivity-sweep", {
    headers: { authorization: "Bearer local-fixture" },
  }));
  expect(response.status).toBe(200);
  expect(runInactivitySweep).toHaveBeenCalledWith({ holderOnly: true, timeBudgetMs: 50_000 });
  expect(recordCronHeartbeat).toHaveBeenCalledWith("holder-inactivity-sweep");
});
