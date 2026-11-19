import { NextRequest } from "next/server";

import { GET, POST } from "../route";
import { decryptApiKey } from "@/lib/crypto";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn((value: string) => value),
}));

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn().mockResolvedValue({ id: "evt_123", fingerprint: "fp_123" }),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

interface InstanceFixture {
  id: string;
  user_id: string;
  api_server_key_encrypted: string | null;
  status: string | null;
  deleted_at: string | null;
}

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

describe("POST /api/instances/[id]/update-report", () => {
  let instanceUpdate: jest.Mock;
  let instanceUpdateEq: jest.Mock;
  let instanceUpdateNot: jest.Mock;
  let instanceUpdateIs: jest.Mock;

  // The lookup row returned by the select chain. Tests mutate this to exercise
  // soft-deleted / terminal-status cases. The route's query chains
  // `.eq(...).is("deleted_at", null).maybeSingle()`, and the route itself
  // filters out soft-deleted rows, so by default we hand back a live row.
  let instanceFixture: InstanceFixture | null;
  // When set, the lookup fails the way a database outage does.
  let lookupError: { message: string } | null;

  beforeEach(() => {
    jest.clearAllMocks();
    lookupError = null;
    instanceUpdateIs = jest.fn().mockResolvedValue({ error: null });
    instanceUpdateNot = jest.fn().mockReturnValue({ is: instanceUpdateIs });
    instanceUpdateEq = jest.fn().mockReturnValue({ not: instanceUpdateNot });
    instanceUpdate = jest.fn().mockReturnValue({ eq: instanceUpdateEq });

    instanceFixture = {
      id: "11111111-1111-4111-8111-111111111111",
      user_id: "user-123",
      api_server_key_encrypted: "gateway-secret",
      status: "redeploying",
      deleted_at: null,
    };

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table !== "hermes_instances") {
        throw new Error(`Unexpected table ${table}`);
      }

      // Mirror the route's chain: select(...).eq(...).is(...).maybeSingle().
      // `.is("deleted_at", null)` returns no row when the fixture is soft-deleted.
      const maybeSingle = jest.fn().mockImplementation(async () => {
        const row =
          instanceFixture && instanceFixture.deleted_at === null
            ? instanceFixture
            : null;
        return { data: lookupError ? null : row, error: lookupError };
      });

      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            is: jest.fn().mockReturnValue({
              maybeSingle,
            }),
          }),
        }),
        update: instanceUpdate,
      };
    });
  });

  it("records authenticated auto-update failures as error events", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "failed",
          runType: "scheduled",
          reason: "exit_status_1",
          detail: "container health check failed",
          occurredAt: "2026-04-23T06:00:00Z",
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: {
        recorded: true,
      },
    });
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instance-update-status",
        severity: "error",
        title: "Auto-update failed",
        message: "Auto-update reported a host-side failure.",
        userId: "user-123",
        instanceId: "11111111-1111-4111-8111-111111111111",
        metadata: expect.objectContaining({
          status: "failed",
          runType: "scheduled",
          reason: "exit_status_1",
          detail: "container health check failed",
          occurredAt: "2026-04-23T06:00:00Z",
          failureOwner: "hermes",
          failurePhase: "update",
          failureType: "instance_update_failed",
          recoveryAction: "open_console",
        }),
      })
    );
  });

  it("records authenticated manual update successes as info events", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "succeeded",
          runType: "manual",
          reason: "completed",
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "info",
        title: "Manual update succeeded",
        message: "Manual update completed successfully.",
        metadata: expect.objectContaining({
          status: "succeeded",
          runType: "manual",
          reason: "completed",
        }),
      })
    );
    expect(instanceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "running",
      })
    );
    expect(instanceUpdateEq).toHaveBeenCalledWith("id", "11111111-1111-4111-8111-111111111111");
    // The write itself refuses a row that became non-resurrectable after the
    // read, so a concurrent delete or deletion schedule cannot be undone.
    expect(instanceUpdateNot).toHaveBeenCalledWith(
      "status",
      "in",
      expect.stringContaining('"scheduled_for_deletion"')
    );
    expect(instanceUpdateIs).toHaveBeenCalledWith("deleted_at", null);
  });

  it("does not revive an instance scheduled for deletion on a succeeded callback", async () => {
    // Reviving it to "running" would take the row out of the purge-expired
    // cron's selection, so its VM would never be torn down.
    instanceFixture = {
      id: "11111111-1111-4111-8111-111111111111",
      user_id: "user-123",
      api_server_key_encrypted: "gateway-secret",
      status: "scheduled_for_deletion",
      deleted_at: null,
    };

    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "succeeded",
          runType: "manual",
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdate).not.toHaveBeenCalled();
  });

  it("does not resurrect a soft-deleted instance on a replayed succeeded callback", async () => {
    // A late/replayed "succeeded" callback for an instance that has since been
    // soft-deleted must not flip it back to "running". The `.is("deleted_at", null)`
    // filter means the row is not even found, so we refuse like any unknown id
    // and never write status.
    instanceFixture = {
      id: "11111111-1111-4111-8111-111111111111",
      user_id: "user-123",
      api_server_key_encrypted: "gateway-secret",
      status: "deleted",
      deleted_at: "2026-04-23T05:00:00Z",
    };

    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "succeeded",
          runType: "manual",
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toBe("Unauthorized");
    expect(instanceUpdate).not.toHaveBeenCalled();
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  // The 404/401 split used to tell a caller which instance ids are live: an
  // unknown or deleted id answered 404 and a live id with a wrong bearer answered
  // 401. Every refusal must now look the same from outside.
  describe("refusals do not reveal whether an instance id exists", () => {
    const bodyOf = async (response: Response) => ({ status: response.status, body: await response.json() });

    const post = (id: string, authorization: string) =>
      POST(
        new NextRequest(`http://localhost/api/instances/${id}/update-report`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ status: "failed", runType: "scheduled" }),
        }),
        { params: Promise.resolve({ id }) }
      );

    it("answers an unknown id, a deleted id, a keyless id and a wrong bearer identically", async () => {
      const liveWrongBearer = await bodyOf(await post(INSTANCE_ID, "Bearer wrong-secret"));

      instanceFixture = null;
      const unknown = await bodyOf(await post(INSTANCE_ID, "Bearer gateway-secret"));

      instanceFixture = { id: INSTANCE_ID, user_id: "user-123", api_server_key_encrypted: "gateway-secret", status: "deleted", deleted_at: "2026-04-23T05:00:00Z" };
      const deleted = await bodyOf(await post(INSTANCE_ID, "Bearer gateway-secret"));

      instanceFixture = { id: INSTANCE_ID, user_id: "user-123", api_server_key_encrypted: null, status: "running", deleted_at: null };
      const keyless = await bodyOf(await post(INSTANCE_ID, "Bearer gateway-secret"));

      expect(liveWrongBearer).toEqual({ status: 401, body: { success: false, error: "Unauthorized" } });
      expect(unknown).toEqual(liveWrongBearer);
      expect(deleted).toEqual(liveWrongBearer);
      expect(keyless).toEqual(liveWrongBearer);
      expect(reportOpsEvent).not.toHaveBeenCalled();
    });

    it("answers a malformed id with the same 401 and never queries the database", async () => {
      const malformed = await bodyOf(await post("not-a-uuid", "Bearer gateway-secret"));

      expect(malformed).toEqual({ status: 401, body: { success: false, error: "Unauthorized" } });
      expect(supabaseAdmin!.from).not.toHaveBeenCalled();
    });

    it("reports a lookup failure as a server error rather than as a missing instance", async () => {
      lookupError = { message: "connection reset" };

      const response = await post(INSTANCE_ID, "Bearer gateway-secret");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ success: false, error: "Database lookup failed" });
    });
  });

  it("rejects update reports with the wrong bearer token", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "failed",
          runType: "scheduled",
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json.error).toBe("Unauthorized");
    expect(reportOpsEvent).not.toHaveBeenCalled();
    expect(decryptApiKey).toHaveBeenCalledWith("gateway-secret");
  });

  it("accepts the GET alias query format used by host-side reporters", async () => {
    const response = await GET(
      new NextRequest(
        "http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report?s=failed&t=scheduled&r=exit_status_1&o=2026-04-23T06%3A00%3A00Z",
        {
          method: "GET",
          headers: {
            authorization: "Bearer gateway-secret",
          },
        }
      ),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          status: "failed",
          runType: "scheduled",
          reason: "exit_status_1",
          occurredAt: "2026-04-23T06:00:00Z",
        }),
      })
    );
  });

  it("rejects invalid GET query values before recording an event", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report?s=nope&t=scheduled", {
        method: "GET",
        headers: {
          authorization: "Bearer gateway-secret",
        },
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe("Invalid update status");
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });
});
