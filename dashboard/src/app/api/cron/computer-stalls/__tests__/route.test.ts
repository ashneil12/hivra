import { NextRequest } from "next/server";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { runComputerStallScan } from "@/lib/recovery/computer-stalls";
import { GET } from "../route";

jest.mock("@/lib/cron-heartbeat", () => ({ recordCronHeartbeat: jest.fn() }));
jest.mock("@/lib/recovery/computer-stalls", () => ({
  COMPUTER_STALL_CRON: "computer-stalls",
  COMPUTER_STALL_ROUTE: "/api/cron/computer-stalls",
  runComputerStallScan: jest.fn(),
}));
jest.mock("@/lib/logger", () => ({ log: { error: jest.fn(), warn: jest.fn() } }));

const scan = jest.mocked(runComputerStallScan);
const request = (authorization: string) =>
  new NextRequest("https://test.invalid/api/cron/computer-stalls", { headers: { authorization } });

beforeEach(() => { jest.replaceProperty(process, "env", { ...process.env, CRON_SECRET: "fixture" }); });
afterEach(() => { jest.restoreAllMocks(); });

it("rejects an unauthorized tick without scanning or heartbeating", async () => {
  expect((await GET(request("Bearer wrong"))).status).toBe(401);
  expect(scan).not.toHaveBeenCalled();
  expect(recordCronHeartbeat).not.toHaveBeenCalled();
});

it("writes the registered heartbeat on success", async () => {
  scan.mockResolvedValue({ reported: 1, archived: 2, failed: 0 });
  expect((await GET(request("Bearer fixture"))).status).toBe(200);
  expect(recordCronHeartbeat).toHaveBeenCalledWith("computer-stalls", undefined);
});

it("writes a failed heartbeat on a partial or thrown scan", async () => {
  scan.mockResolvedValueOnce({ reported: 1, archived: 0, failed: 1 });
  scan.mockRejectedValueOnce(new Error("fixture database unavailable"));
  expect((await GET(request("Bearer fixture"))).status).toBe(500);
  expect((await GET(request("Bearer fixture"))).status).toBe(500);
  expect(recordCronHeartbeat).toHaveBeenNthCalledWith(1, "computer-stalls", { ok: false, detail: "failed=1" });
  expect(recordCronHeartbeat).toHaveBeenNthCalledWith(2, "computer-stalls", { ok: false, detail: "scan threw" });
});
