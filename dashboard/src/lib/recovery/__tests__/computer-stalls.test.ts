import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { runComputerStallScan } from "../computer-stalls";

jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn(), rpc: jest.fn() } }));

const report = jest.mocked(reportOpsEvent);
const from = jest.mocked(supabaseAdmin!.from);
const rpc = jest.mocked(supabaseAdmin!.rpc);
const when = "2026-11-27T12:00:00.000Z";
const source = "synthetic.computer-stall.health";

function setup({
  open = [], signals = [], signalError = null,
}: {
  open?: object[]; signals?: object[]; signalError?: object | null;
} = {}) {
  const table = {
    select: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    lt: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({ data: open, error: null }),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
  };
  table.select.mockReturnValueOnce(table).mockResolvedValue({ data: [{ id: "cleared" }], error: null });
  from.mockReturnValue(table as never);
  rpc.mockReturnValue({
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue({ data: signals, error: signalError }),
  } as never);
  report.mockResolvedValue({ id: "deduped", fingerprint: "stable" });
  return table;
}

const incident = (id: string) => ({ id, instance_id: id, source, last_seen_at: when });
const signal = (id: string, verdict: string, host = "fixture-host") => ({
  signal_key: `classic:health:${id}`, instance_id: id, kind: "classic",
  reason: "health", since: when, verdict, host,
});

it("reports through the shared deduper with stable identity and allowlisted metadata only", async () => {
  setup({ signals: [{ ...signal("instance", "open"), email: "never-copy" }] });
  expect(await runComputerStallScan()).toEqual({ reported: 1, archived: 0, failed: 0 });
  setup({ signals: [signal("instance", "open", "new-host")] });
  await runComputerStallScan();
  const [first, second] = report.mock.calls.map(([event]) => event);
  expect(first).not.toHaveProperty("userId");
  expect(first).toMatchObject({ source, instanceId: "instance", page: true, resetFirstSeenOnReopen: true });
  expect(first.metadata).toEqual({
    instance_id: "instance", host: "fixture-host", computer_kind: "classic", since: when,
  });
  expect([second.source, second.title, second.message, second.instanceId])
    .toEqual([first.source, first.title, first.message, first.instanceId]);
  expect(second.metadata?.host).toBe("new-host");
});

it("archives a recovered or stopped instance but preserves unknown and pending health", async () => {
  const table = setup({
    open: ["cleared", "stopped", "unknown", "pending"].map(incident),
    signals: [signal("cleared", "cleared"), signal("unknown", "unknown"), signal("pending", "pending")],
  });
  expect(await runComputerStallScan()).toEqual({ reported: 0, archived: 2, failed: 0 });
  expect(table.update).toHaveBeenCalledTimes(2);
  expect(table.eq.mock.calls).toEqual([
    ["id", "cleared"], ["last_seen_at", when], ["id", "stopped"], ["last_seen_at", when],
  ]);
  expect(from.mock.calls.every(([tableName]) => tableName === "ops_events")).toBe(true);
});

it("never treats a failed read as recovery and marks failed event writes", async () => {
  const table = setup({ open: [incident("stalled")], signalError: {} });
  await expect(runComputerStallScan()).rejects.toThrow("Could not read computer stall signals");
  expect(table.update).not.toHaveBeenCalled();
  setup({ signals: [signal("stalled", "open")] });
  report.mockResolvedValueOnce(null);
  expect(await runComputerStallScan()).toEqual({ reported: 0, archived: 0, failed: 1 });
});
