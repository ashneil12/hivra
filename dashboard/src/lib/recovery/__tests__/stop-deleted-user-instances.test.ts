import { stopDeletedUserInstances } from "../stop-deleted-user-instances";
import { listLiveInstances, listLiveComputers, classifyByClerkOwnership } from "../orphaned-instances";
import { buildShutdownInstance } from "../orphan-instance-shutdown";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@clerk/nextjs/server", () => ({ clerkClient: jest.fn().mockResolvedValue({ users: {} }) }));
jest.mock("../orphaned-instances", () => ({ listLiveInstances: jest.fn(), listLiveComputers: jest.fn(), classifyByClerkOwnership: jest.fn() }));
jest.mock("../stop-deleted-user-computers", () => ({ stopDeletedUserComputer: jest.fn() }));
jest.mock("../orphan-instance-shutdown", () => ({ buildShutdownInstance: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn() } }));

const row = { id: "instance-old", user_id: "user_old", status: "running" };
const shutdown = jest.fn();
const eq = jest.fn();
const update = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (listLiveInstances as jest.Mock).mockResolvedValue([row]);
  (listLiveComputers as jest.Mock).mockResolvedValue([]);
  (classifyByClerkOwnership as jest.Mock).mockImplementation(async (rows: unknown[]) => rows.length ? [{ row, status: "orphan" }] : []);
  (buildShutdownInstance as jest.Mock).mockReturnValue(shutdown);
  shutdown.mockResolvedValue({ ok: true });
  eq.mockReturnValue({ eq: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue({ data: [{ id: row.id }], error: null }) }) }) });
  update.mockReturnValue({ eq });
  (supabaseAdmin!.from as jest.Mock).mockReturnValue({ update });
});

it("scopes the lookup and database write to the deleted identity", async () => {
  await expect(stopDeletedUserInstances("user_old")).resolves.toEqual({ stopped: 1 });
  expect(listLiveInstances).toHaveBeenCalledWith(supabaseAdmin, { userId: "user_old" });
  expect(shutdown).toHaveBeenCalledWith(row);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "stopped", lifecycle_state: "suspended" }));
  expect(eq).toHaveBeenCalledWith("id", row.id);
  expect(eq.mock.results[0].value.eq).toHaveBeenCalledWith("user_id", "user_old");
});

it.each(["alive", "lookup-failed"])("does not stop an owner classified as %s", async (status) => {
  (classifyByClerkOwnership as jest.Mock).mockResolvedValue([{ row, status }]);
  await expect(stopDeletedUserInstances("user_old")).rejects.toThrow("absence could not be confirmed");
  expect(shutdown).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

it("keeps failure retryable and does not report a running VM as stopped", async () => {
  shutdown.mockResolvedValue({ ok: false });
  await expect(stopDeletedUserInstances("user_old")).rejects.toThrow("incomplete");
  expect(update).not.toHaveBeenCalled();
  shutdown.mockResolvedValue({ ok: true });
  await expect(stopDeletedUserInstances("user_old")).resolves.toEqual({ stopped: 1 });
});

it("does not acknowledge a database failure after stopping the runtime", async () => {
  eq.mockReturnValue({ eq: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue({ data: null, error: { message: "unavailable" } }) }) }) });
  await expect(stopDeletedUserInstances("user_old")).rejects.toThrow("incomplete");
});

it("preserves a scheduled deletion deadline on duplicate delivery", async () => {
  (classifyByClerkOwnership as jest.Mock).mockResolvedValue([{ row: { ...row, status: "scheduled_for_deletion" }, status: "orphan" }]);
  await stopDeletedUserInstances("user_old");
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "scheduled_for_deletion" }));
  expect(update.mock.calls[0][0]).not.toHaveProperty("scheduled_deletion_at");
});

it("refuses a cross-tenant response before provider mutation", async () => {
  (classifyByClerkOwnership as jest.Mock).mockResolvedValue([{ row: { ...row, user_id: "user_other" }, status: "orphan" }]);
  await expect(stopDeletedUserInstances("user_old")).rejects.toThrow("owner mismatch");
  expect(shutdown).not.toHaveBeenCalled();
});

it("does not overwrite an instance whose state changed during shutdown", async () => {
  eq.mockReturnValue({ eq: jest.fn().mockReturnValue({ eq: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue({ data: [], error: null }) }) }) });
  await expect(stopDeletedUserInstances("user_old")).rejects.toThrow("incomplete");
  expect(eq.mock.results[0].value.eq.mock.results[0].value.eq).toHaveBeenCalledWith("status", "running");
});
