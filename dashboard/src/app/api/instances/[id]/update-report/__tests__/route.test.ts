import { NextRequest } from "next/server";

import { GET, POST } from "../route";
import { decryptApiKey } from "@/lib/crypto";
import { reportOpsEvent } from "@/lib/ops-events";
import { resolveUpdateImagePolicy } from "@/lib/hermes-releases/live-update";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/crypto", () => ({
  decryptApiKey: jest.fn((value: string) => value),
}));

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn().mockResolvedValue({ id: "evt_123", fingerprint: "fp_123" }),
}));

// The failed-report attempt correlation resolves the release a NEW update
// would pin. Mocked here: the real module's transitive graph (the instance
// builders) is out of scope for this suite, and the tests drive every
// correlation outcome directly.
jest.mock("@/lib/hermes-releases/live-update", () => ({
  resolveUpdateImagePolicy: jest.fn(),
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
  let instanceUpdateLte: jest.Mock;

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
    // The failed-report stamp chains .eq().eq().is() and then a conditional
    // .lte() when the report carries occurredAt — the .is() step returns a
    // result that is both the terminal {error} and the .lte() chain link.
    instanceUpdateLte = jest.fn().mockResolvedValue({ error: null });
    instanceUpdateIs = jest.fn().mockReturnValue({ error: null, lte: instanceUpdateLte });
    instanceUpdateNot = jest.fn().mockReturnValue({ is: instanceUpdateIs });
    // The success write chains .eq().not().is(); the failed-report stamp
    // chains .eq().eq().is() — one result object serves both.
    const eqResult: Record<string, unknown> = {
      not: instanceUpdateNot,
      is: instanceUpdateIs,
    };
    instanceUpdateEq = jest.fn().mockReturnValue(eqResult);
    eqResult.eq = instanceUpdateEq;
    instanceUpdate = jest.fn().mockReturnValue({ eq: instanceUpdateEq });
    // Without a seeded resolution the correlation stays ungoverned — the
    // report's write-time bounds alone apply.
    (resolveUpdateImagePolicy as jest.Mock).mockResolvedValue({
      policy: undefined,
      state: null,
    });

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

  it("stamps a failed+reached state on a failed report so the row stays sweep-retryable", async () => {
    // Regression: a failed report used to write no status at all, so a row
    // the launch left at 'redeploying' kept status='redeploying' +
    // lifecycle_state='provisioning' — a pair the fleet-sync sweep admits
    // in neither arm (live status/lifecycle, or failed+reached substate).
    // Recover-stuck probes and restarts the VM but never re-applies the
    // release, so the update was never retried. The report is itself proof
    // the update ran on the box, so it is stamped like a launch failure
    // that reached the guest — but only while the row still shows the
    // update in flight.
    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "failed",
          runType: "manual",
          reason: "exit_status_1",
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        lifecycle_state: "failed",
        lifecycle_substate: "live_update_failed_vm_reached",
      })
    );
    // The write is predicated on the row still being mid-update: a late or
    // duplicated report cannot claw back a row that already moved on
    // (recovered to running, deleted, rescheduled).
    expect(instanceUpdateEq).toHaveBeenCalledWith("id", "11111111-1111-4111-8111-111111111111");
    expect(instanceUpdateEq).toHaveBeenCalledWith("status", "redeploying");
    expect(instanceUpdateIs).toHaveBeenCalledWith("deleted_at", null);
  });

  it("bounds the failed stamp to failures that happened after the current redeploy began", async () => {
    // occurredAt is the box-side failure time. A delayed failure report from
    // an EARLIER attempt carries an occurredAt older than the transition
    // stamp the in-flight attempt left — the .lte predicate makes that write
    // a no-match instead of clawing the newer attempt's row back to failed.
    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "failed",
          runType: "manual",
          reason: "exit_status_1",
          occurredAt: "2026-04-23T06:00:00Z",
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdateLte).toHaveBeenCalledWith(
      "last_lifecycle_transition_at",
      "2026-04-23T06:00:00Z"
    );
  });

  it("predicates the failed stamp on the attempt stamp the report echoes back", async () => {
    // The launcher bakes its attempt id into the wrapper's `ru` URL (`a=`)
    // and stamps the same value into last_lifecycle_transition_at when it
    // marks the row 'redeploying'. A report carrying it is correlated by the
    // write predicate itself: the registry is never read, so a pin that
    // moved mid-attempt cannot make this attempt's valid report look stale,
    // and a delayed report naming a superseded stamp fails the match
    // instead of stamping a newer attempt's row.
    const attempt = "2026-04-23T06:00:00.000Z";
    const supersededTarget = `sha256:${"1".repeat(64)}`;

    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "failed",
          runType: "manual",
          reason: "pull_failed",
          targetDigest: supersededTarget,
          attempt,
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    // Attempt-stamped reports never consult the registry: the write-time eq
    // on the transition stamp IS the correlation, so a targetDigest that no
    // longer matches the current pin cannot mark this report stale.
    expect(resolveUpdateImagePolicy).not.toHaveBeenCalled();
    expect(instanceUpdateEq).toHaveBeenCalledWith(
      "last_lifecycle_transition_at",
      attempt
    );
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ attemptStamp: attempt }),
      })
    );
  });

  it("reads the attempt stamp from the GET callback's `a` parameter", async () => {
    // The box wrapper's `ru` callback is a GET with the attempt stamp baked
    // in as `&a=` — the same predicate path the POST `attempt` field takes.
    const attempt = "2026-04-23T06:00:00.000Z";
    const response = await GET(
      new NextRequest(
        `http://localhost/api/u/11111111-1111-4111-8111-111111111111?s=failed&t=manual&r=pull_failed&a=${attempt}`,
        { headers: { authorization: "Bearer gateway-secret" } }
      ),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdateEq).toHaveBeenCalledWith(
      "last_lifecycle_transition_at",
      attempt
    );
  });

  it("predicates the running-state write on the attempt stamp too", async () => {
    // A delayed SUCCESS callback from a superseded attempt is the same
    // hole through the other door: writing 'running' over a newer
    // attempt's 'redeploying' row would also block that attempt's own
    // failed-report stamp. The same `a` predicate bounds it.
    const attempt = "2026-04-23T06:00:00.000Z";
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
          attempt,
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdateEq).toHaveBeenCalledWith(
      "last_lifecycle_transition_at",
      attempt
    );
    expect(instanceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" })
    );
  });

  it("ignores a malformed attempt stamp and falls back to the legacy correlation", async () => {
    // A value that cannot be a transition stamp must not reach the
    // PostgREST filter — it is dropped at normalization, so the report
    // correlates exactly like one that carried no attempt stamp at all.
    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "failed",
          runType: "manual",
          reason: "exit_status_1",
          attempt: "x,not(a)stamp*",
          targetDigest: `sha256:${"1".repeat(64)}`,
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdateEq).not.toHaveBeenCalledWith(
      "last_lifecycle_transition_at",
      expect.anything()
    );
    // Legacy path: the named target still drives the registry correlation.
    expect(resolveUpdateImagePolicy).toHaveBeenCalledWith(
      supabaseAdmin,
      "11111111-1111-4111-8111-111111111111",
      "release"
    );
  });

  it("stamps the failed state when the report's target is the release a new update would pin", async () => {
    // Attempt correlation: the registry still points this box's release
    // update at the digest the failed attempt moved toward, so the failure
    // belongs to the in-flight attempt and the stamp lands.
    const target = `sha256:${"2".repeat(64)}`;
    (resolveUpdateImagePolicy as jest.Mock).mockResolvedValue({
      policy: { kind: "pinned", ref: `ghcr.io/example/agent@${target}`, digest: target },
      state: { governed: true },
    });

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
          reason: "pull_failed",
          targetDigest: target,
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(resolveUpdateImagePolicy).toHaveBeenCalledWith(
      supabaseAdmin,
      "11111111-1111-4111-8111-111111111111",
      "release"
    );
    expect(instanceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        lifecycle_substate: "live_update_failed_vm_reached",
      })
    );
  });

  it("skips the failed stamp when a delayed report targets a superseded release — but still records", async () => {
    // The failed attempt moved toward D1, but a release update would pin D2
    // NOW: the in-flight attempt is a different operation and the stale
    // failure must not stamp its row. The report itself still counts — a
    // 200 keeps the box from retrying pointlessly and the release-health
    // signal below still lands.
    const superseded = `sha256:${"1".repeat(64)}`;
    const inFlight = `sha256:${"2".repeat(64)}`;
    (resolveUpdateImagePolicy as jest.Mock).mockResolvedValue({
      policy: { kind: "pinned", ref: `ghcr.io/example/agent@${inFlight}`, digest: inFlight },
      state: { governed: true },
    });

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
          reason: "pull_failed",
          targetDigest: superseded,
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle_substate: expect.anything() })
    );
    expect(instanceUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle_state: "failed" })
    );
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Auto-update failed" })
    );
  });

  it("skips the failed stamp when a governed box has no release pinned — a keep-intent update cannot report one", async () => {
    // The registry governs the box but decides no release move right now:
    // a report naming ANY target belongs to an earlier attempt — the
    // in-flight update is release-keep (config/redeploy), which cannot
    // produce a target-bearing failure of its own.
    (resolveUpdateImagePolicy as jest.Mock).mockResolvedValue({
      policy: { kind: "keep" },
      state: { governed: true },
    });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "failed",
          runType: "manual",
          targetDigest: `sha256:${"1".repeat(64)}`,
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle_substate: expect.anything() })
    );
  });

  it("records the report and degrades the response when the attempt correlation read fails", async () => {
    // A target-bearing report cannot be judged stale or fresh without the
    // registry answer — but the report itself is already durably on file
    // (release outcome + ops event) before correlation runs. The box-side
    // reporter is fire-and-forget: a non-2xx would teach it that a recorded
    // report was dropped while no retry ever comes, so the missing stamp is
    // degraded detail on a 200 — and a 'redeploying' row is still recovered
    // by the normal sweeps, not stranded.
    (resolveUpdateImagePolicy as jest.Mock).mockRejectedValueOnce(
      new Error("release registry read failed")
    );

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
          reason: "pull_failed",
          targetDigest: `sha256:${"1".repeat(64)}`,
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: { recorded: true, degraded: "update_report_correlation_failed" },
    });
    // The report's own ops event persisted BEFORE the failed correlation —
    // the outage is on file even though the stamp could not be attempted.
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instance-update-status",
        title: "Auto-update failed",
      })
    );
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instance-update-status",
        title: "update report received but the attempt correlation failed",
        severity: "error",
        metadata: expect.objectContaining({
          failureType: "update_report_correlation_failed",
        }),
      })
    );
    expect(instanceUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle_substate: expect.anything() })
    );
  });

  it("records the report and degrades the response when the failed-state write fails", async () => {
    // The stamp can still be retried — recover-stuck probes a 'redeploying'
    // row and the next launch re-stamps a fresh attempt marker — while the
    // box's single fire-and-forget curl never retries. So the recorded
    // report answers 200 with the missed stamp named as degraded detail
    // instead of a 500 that only looks like the report was dropped.
    instanceUpdateIs.mockResolvedValueOnce({ error: { message: "row locked" } });

    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          status: "failed",
          runType: "manual",
          reason: "exit_status_1",
        }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({
      success: true,
      data: { recorded: true, degraded: "update_report_state_write_failed" },
    });
    // The failure report's own ops event persisted first; the second call
    // is the error-log mirror of the missed stamp.
    expect(reportOpsEvent).toHaveBeenCalledTimes(2);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instance-update-status",
        title: "Manual update failed",
      })
    );
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "instance-update-status",
        title: "update report received but the failed-state write failed",
        severity: "error",
        metadata: expect.objectContaining({
          failureType: "update_report_state_write_failed",
        }),
      })
    );
  });

  it("does not stamp the failed state on a succeeded report", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/instances/11111111-1111-4111-8111-111111111111/update-report", {
        method: "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "succeeded", runType: "manual" }),
      }),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) }
    );

    expect(response.status).toBe(200);
    expect(instanceUpdate).toHaveBeenCalledTimes(1);
    expect(instanceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" })
    );
    expect(instanceUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle_substate: expect.anything() })
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
