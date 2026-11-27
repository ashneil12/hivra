import { supabaseAdmin } from "@/lib/supabase";
import { paidKvmSleepAvailable } from "../paid-kvm-sleep-availability";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn() } }));

const from = jest.mocked(supabaseAdmin!.from);
const select = jest.fn();
const eq = jest.fn();
const is = jest.fn();
const limit = jest.fn();
const abortSignal = jest.fn();

beforeEach(() => {
  jest.replaceProperty(process, "env", { ...process.env, HIVRA_SLEEP_MODE: "on", NEXT_PUBLIC_HIVRA_AGENT_SLEEP: "1" });
  const query = { select, eq, is, limit, abortSignal };
  from.mockReturnValue(query as never);
  select.mockReturnValue(query);
  eq.mockReturnValue(query);
  is.mockReturnValue(query);
  limit.mockReturnValue(query);
  abortSignal.mockResolvedValue({ data: [], error: null });
});

afterEach(() => jest.restoreAllMocks());

it("does not promise paid sleep from global flags alone", async () => {
  await expect(paidKvmSleepAvailable()).resolves.toBe(false);
});

it("requires an active, non-decommissioned host enabled for production sleep", async () => {
  abortSignal.mockResolvedValueOnce({ data: [{ id: "active-host" }], error: null });

  await expect(paidKvmSleepAvailable()).resolves.toBe(true);
  expect(from).toHaveBeenCalledWith("proxmox_hosts");
  expect(eq.mock.calls).toEqual([["status", "active"], ["sleep_mode", "on"]]);
  expect(is).toHaveBeenCalledWith("decommissioned_at", null);
  expect(limit).toHaveBeenCalledWith(1);
});

it.each(["HIVRA_SLEEP_MODE", "NEXT_PUBLIC_HIVRA_AGENT_SLEEP"])("does not query host availability when %s is off", async (flag) => {
  process.env[flag] = "off";
  await expect(paidKvmSleepAvailable()).resolves.toBe(false);
  expect(from).not.toHaveBeenCalled();
});

it("fails closed on a database error or timeout", async () => {
  abortSignal.mockResolvedValueOnce({ data: null, error: { code: "503" } });
  abortSignal.mockRejectedValueOnce(new Error("timeout"));

  await expect(paidKvmSleepAvailable()).resolves.toBe(false);
  await expect(paidKvmSleepAvailable()).resolves.toBe(false);
});
