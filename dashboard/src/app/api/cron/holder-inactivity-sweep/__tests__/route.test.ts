import { NextRequest } from "next/server";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { transitionClassicHolder } from "@/lib/recovery/classic-holder-idle";
import { GET } from "../route";

jest.mock("@/lib/cron-heartbeat", () => ({ recordCronHeartbeat: jest.fn() }));
jest.mock("@/lib/recovery/classic-holder-idle", () => ({ transitionClassicHolder: jest.fn() }));
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
  expect(transitionClassicHolder).not.toHaveBeenCalled();
});

it("processes due transitions until the queue is empty", async () => {
  jest.mocked(transitionClassicHolder).mockResolvedValueOnce("napping").mockResolvedValueOnce("unclaimed");
  const response = await GET(new NextRequest("http://localhost/api/cron/holder-inactivity-sweep", {
    headers: { authorization: "Bearer local-fixture" },
  }));
  expect(response.status).toBe(200);
  expect((await response.json()).data.outcomes).toEqual({ napping: 1 });
  expect(recordCronHeartbeat).toHaveBeenCalledWith("holder-inactivity-sweep");
});
