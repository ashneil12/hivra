/**
 * DELETE /api/mobile/account tests. Locks in:
 *   - the explicit confirm-token guard (no token / wrong token → 400, nothing runs)
 *   - instances are torn down through the EXISTING DELETE /api/instances/[id]
 *     handler (typed-id confirmation supplied), never a reimplementation
 *   - a failed teardown ABORTS: Clerk deleteUser never runs, 502 lists the failure
 *   - ordering: instances → device tokens → Clerk user
 *   - the response reports what was deleted + the Apple-billing note
 */

import { NextRequest } from "next/server";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  clerkClient: jest.fn(),
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
// The existing per-instance deletion path — mocked as a unit boundary; its own
// behavior is covered by src/app/api/instances/[id] tests.
jest.mock("@/app/api/instances/[id]/route", () => ({
  DELETE: jest.fn(),
}));

import { DELETE } from "../route";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { DELETE as deleteInstanceRoute } from "@/app/api/instances/[id]/route";
import { supabaseAdmin } from "@/lib/supabase";

const mockedAuth = auth as unknown as jest.Mock;
const mockedClerkClient = clerkClient as unknown as jest.Mock;
const mockedDeleteInstance = deleteInstanceRoute as unknown as jest.Mock;
const mockedFrom = supabaseAdmin!.from as jest.Mock;

const deleteUserMock = jest.fn();

function accountRequest(body: unknown) {
  return new NextRequest("http://localhost/api/mobile/account", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildDb(instances: Array<{ id: string; name: string | null }>) {
  const tokensDeleteEq = jest.fn().mockResolvedValue({ error: null });
  mockedFrom.mockImplementation((table: string) => {
    if (table === "hermes_instances") {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            neq: jest.fn().mockReturnValue({
              neq: jest.fn().mockReturnValue({
                returns: jest.fn().mockResolvedValue({ data: instances, error: null }),
              }),
            }),
          }),
        }),
      };
    }
    if (table === "device_tokens") {
      return { delete: jest.fn().mockReturnValue({ eq: tokensDeleteEq }) };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { tokensDeleteEq };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({ userId: "user_123" });
  mockedClerkClient.mockResolvedValue({ users: { deleteUser: deleteUserMock } });
  deleteUserMock.mockResolvedValue(undefined);
  mockedDeleteInstance.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
});

describe("DELETE /api/mobile/account", () => {
  it("requires a Clerk session", async () => {
    mockedAuth.mockResolvedValue({ userId: null });
    const response = await DELETE(accountRequest({ confirm: "DELETE_MY_ACCOUNT" }));
    expect(response.status).toBe(401);
  });

  it("refuses without the explicit confirm token", async () => {
    buildDb([{ id: "inst-1", name: "Bea" }]);
    for (const body of [{}, { confirm: "yes please" }, null]) {
      const response = await DELETE(accountRequest(body));
      expect(response.status).toBe(400);
    }
    expect(mockedDeleteInstance).not.toHaveBeenCalled();
    expect(deleteUserMock).not.toHaveBeenCalled();
  });

  it("tears down every instance through the existing DELETE route, then Clerk, and reports it", async () => {
    const { tokensDeleteEq } = buildDb([
      { id: "inst-1", name: "Bea" },
      { id: "inst-2", name: "Pike" },
    ]);

    const response = await DELETE(accountRequest({ confirm: "DELETE_MY_ACCOUNT" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({
      accountDeleted: true,
      deletedInstances: ["inst-1", "inst-2"],
      deletedInstanceCount: 2,
    });
    expect(json.data.note).toContain("App Store");

    // Each teardown went through the existing route handler with the
    // typed-id confirmation it requires.
    expect(mockedDeleteInstance).toHaveBeenCalledTimes(2);
    const [req1, ctx1] = mockedDeleteInstance.mock.calls[0];
    expect(req1.method).toBe("DELETE");
    await expect(ctx1.params).resolves.toEqual({ id: "inst-1" });
    await expect(req1.json()).resolves.toEqual({ confirmation: "inst-1" });

    // Device tokens removed, then the Clerk user.
    expect(tokensDeleteEq).toHaveBeenCalledWith("user_id", "user_123");
    expect(deleteUserMock).toHaveBeenCalledWith("user_123");
    // Ordering: every instance teardown strictly before the Clerk delete.
    const lastTeardownOrder = Math.max(
      ...mockedDeleteInstance.mock.invocationCallOrder
    );
    expect(deleteUserMock.mock.invocationCallOrder[0]).toBeGreaterThan(lastTeardownOrder);
  });

  it("handles the zero-instance account (deletes tokens + Clerk user only)", async () => {
    buildDb([]);
    const response = await DELETE(accountRequest({ confirm: "DELETE_MY_ACCOUNT" }));
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.deletedInstanceCount).toBe(0);
    expect(mockedDeleteInstance).not.toHaveBeenCalled();
    expect(deleteUserMock).toHaveBeenCalledWith("user_123");
  });

  it("ABORTS before Clerk when any instance teardown fails, and says which", async () => {
    buildDb([
      { id: "inst-ok", name: "Bea" },
      { id: "inst-stuck", name: "Pike" },
    ]);
    mockedDeleteInstance
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: false }), { status: 502 })
      );

    const response = await DELETE(accountRequest({ confirm: "DELETE_MY_ACCOUNT" }));
    const json = await response.json();

    expect(response.status).toBe(502);
    expect(json.failureType).toBe("account_delete_instances_failed");
    expect(json.deletedInstances).toEqual(["inst-ok"]);
    expect(json.failedInstanceIds).toEqual(["inst-stuck"]);
    // The account survives so the user can retry — nothing orphaned.
    expect(deleteUserMock).not.toHaveBeenCalled();
  });

  it("counts a teardown that throws as failed and still aborts", async () => {
    buildDb([{ id: "inst-boom", name: "Bea" }]);
    mockedDeleteInstance.mockRejectedValue(new Error("proxmox exploded"));

    const response = await DELETE(accountRequest({ confirm: "DELETE_MY_ACCOUNT" }));

    expect(response.status).toBe(502);
    expect(deleteUserMock).not.toHaveBeenCalled();
  });
});
