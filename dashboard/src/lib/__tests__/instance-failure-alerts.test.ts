import {
  getLatestInstanceFailureAlerts,
  suppressFailureAlertsResolvedByLifecycle,
} from "../instance-failure-alerts";
import type { InstanceFailureAlert } from "@/lib/failure-ownership";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

function mockOpsEventsQuery(options: {
  data?: unknown[] | null;
  error?: unknown;
  reject?: Error;
}) {
  const limitMock = options.reject
    ? jest.fn().mockRejectedValue(options.reject)
    : jest.fn().mockResolvedValue({
        data: options.data ?? null,
        error: options.error ?? null,
      });
  // Order chain now ends in .limit() so the dedupe-by-instance pull is
  // bounded. The mock matches the production shape: order(...).limit(...).
  const orderMock = jest.fn().mockReturnValue({
    limit: limitMock,
  });
  const inMock = jest.fn().mockReturnValue({
    order: orderMock,
  });
  const isMock = jest.fn().mockReturnValue({
    in: inMock,
  });
  const selectMock = jest.fn().mockReturnValue({
    is: isMock,
  });

  (supabaseAdmin!.from as jest.Mock).mockReturnValue({
    select: selectMock,
  });

  return {
    selectMock,
    isMock,
    inMock,
    orderMock,
    limitMock,
  };
}

function buildAlert(overrides: Partial<InstanceFailureAlert> = {}): InstanceFailureAlert {
  return {
    title: "Gateway restart failed",
    message: "API 500 Gateway restart failed.",
    lastSeenAt: "2026-05-05T08:00:00.000Z",
    owner: "runtime",
    ownerLabel: "Runtime issue",
    phase: "runtime",
    phaseLabel: "Runtime",
    severity: "error",
    recoveryAction: "open_console",
    recoveryLabel: "Open console",
    source: "instance-actions",
    ...overrides,
  };
}

describe("getLatestInstanceFailureAlerts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the latest explicit failure contract for each instance", async () => {
    mockOpsEventsQuery({
      data: [
        {
          instance_id: "inst-123",
          source: "provider-runtime",
          severity: "error",
          title: "Provider authentication failed",
          message: "OpenRouter rejected the saved key.",
          last_seen_at: "2026-05-05T08:00:00.000Z",
          metadata: {
            failureOwner: "user",
            failurePhase: "auth",
            failureType: "provider_key_rejected",
            recoveryAction: "update_provider_key",
          },
        },
      ],
    });

    await expect(getLatestInstanceFailureAlerts(["inst-123"])).resolves.toEqual({
      "inst-123": expect.objectContaining({
        title: "Provider authentication failed",
        owner: "user",
        ownerLabel: "Your action needed",
        phase: "auth",
        phaseLabel: "Authentication",
        recoveryAction: "update_provider_key",
        recoveryLabel: "Update provider key",
      }),
    });
  });

  it("suppresses stale update failures after a newer update success", async () => {
    mockOpsEventsQuery({
      data: [
        {
          instance_id: "inst-123",
          source: "instance-update-status",
          severity: "info",
          title: "Manual update succeeded",
          message: "Manual update completed successfully.",
          last_seen_at: "2026-05-05T09:00:00.000Z",
          metadata: {
            status: "succeeded",
            runType: "manual",
          },
        },
        {
          instance_id: "inst-123",
          source: "instance-update-status",
          severity: "error",
          title: "Auto-update failed",
          message: "Auto-update reported a host-side failure.",
          last_seen_at: "2026-05-05T08:00:00.000Z",
          metadata: {
            status: "failed",
            runType: "scheduled",
          },
        },
      ],
    });

    await expect(getLatestInstanceFailureAlerts(["inst-123"])).resolves.toEqual({});
  });

  it("keeps all synthetic observability events out of user-facing failure alerts", async () => {
    mockOpsEventsQuery({
      data: [
        {
          instance_id: "inst-123",
          source: "synthetic.egress-endpoint",
          severity: "warn",
          title: "Egress probe endpoint unauth on https://agent.example.com",
          message: "GET /api/health/egress failed: HTTP 401. Cannot verify outbound network from this agent.",
          last_seen_at: "2026-05-05T09:00:00.000Z",
          metadata: {
            failureOwner: "runtime",
            failurePhase: "egress",
            failureType: "egress_endpoint_unreachable",
            recoveryAction: "repair_runtime",
          },
        },
        {
          instance_id: "inst-456",
          source: "synthetic.egress-target",
          severity: "error",
          title: "Agent can't reach api.openai.com from https://agent.example.com",
          message: "Agent VM probe to api.openai.com failed.",
          last_seen_at: "2026-05-05T09:00:00.000Z",
          metadata: {
            failureOwner: "runtime",
            failurePhase: "egress",
            failureType: "egress_target_unreachable",
            recoveryAction: "repair_runtime",
          },
        },
        {
          instance_id: "inst-789",
          source: "synthetic.instance-health",
          severity: "error",
          title: "Synthetic instance health probe failed",
          message: "The operator health probe could not reach the instance gateway.",
          last_seen_at: "2026-05-05T09:00:00.000Z",
          metadata: {
            failureOwner: "runtime",
            failurePhase: "runtime",
            failureType: "instance_health_probe_failed",
            recoveryAction: "repair_runtime",
          },
        },
        {
          instance_id: "inst-999",
          source: "synthetic.tls-wedged",
          severity: "fatal",
          title: "Synthetic TLS wedge probe failed",
          message: "The operator TLS probe detected a wedged gateway path.",
          last_seen_at: "2026-05-05T09:00:00.000Z",
          metadata: {
            failureOwner: "runtime",
            failurePhase: "network",
            failureType: "tls_wedged",
            recoveryAction: "repair_runtime",
          },
        },
        {
          instance_id: "inst-future",
          source: "synthetic.future-probe",
          severity: "error",
          title: "Future synthetic probe failed",
          message: "Future operator-only probes should inherit the same suppression policy.",
          last_seen_at: "2026-05-05T09:00:00.000Z",
          metadata: {
            failureOwner: "runtime",
            failurePhase: "runtime",
            failureType: "future_probe_failed",
            recoveryAction: "repair_runtime",
          },
        },
      ],
    });

    await expect(
      getLatestInstanceFailureAlerts(["inst-123", "inst-456", "inst-789", "inst-999", "inst-future"])
    ).resolves.toEqual({});
  });

  it("skips synthetic observability rows and still returns older actionable failures", async () => {
    mockOpsEventsQuery({
      data: [
        {
          instance_id: "inst-123",
          source: "synthetic.instance-health",
          severity: "error",
          title: "Synthetic instance health probe failed",
          message: "Synthetic probe failed.",
          last_seen_at: "2026-05-05T09:00:00.000Z",
          metadata: {
            failureOwner: "runtime",
            failurePhase: "runtime",
            recoveryAction: "repair_runtime",
          },
        },
        {
          instance_id: "inst-123",
          source: "provider-runtime",
          severity: "error",
          title: "Provider authentication failed",
          message: "OpenRouter rejected the saved key.",
          last_seen_at: "2026-05-05T08:00:00.000Z",
          metadata: {
            failureOwner: "user",
            failurePhase: "auth",
            recoveryAction: "update_provider_key",
          },
        },
      ],
    });

    await expect(getLatestInstanceFailureAlerts(["inst-123"])).resolves.toEqual({
      "inst-123": expect.objectContaining({
        title: "Provider authentication failed",
        owner: "user",
        phase: "auth",
        recoveryAction: "update_provider_key",
      }),
    });
  });

  it("normalizes requested ids and ignores malformed rows", async () => {
    const { inMock } = mockOpsEventsQuery({
      data: [
        {
          instance_id: "inst-456",
          source: "health-sweep",
          severity: "fatal",
          title: "Gateway health check failed",
          message: "The runtime endpoint is unreachable.",
          last_seen_at: "2026-05-05T08:00:00.000Z",
          metadata: {
            failureOwner: "runtime",
            failurePhase: "runtime",
            recoveryAction: "repair_runtime",
          },
        },
        {
          instance_id: "inst-789",
          source: "health-sweep",
          severity: "error",
          title: "Missing metadata",
          message: "This should not become a user banner.",
          last_seen_at: "2026-05-05T08:05:00.000Z",
          metadata: {},
        },
      ],
    });

    await expect(
      getLatestInstanceFailureAlerts([" inst-456 ", "", "inst-456", "inst-123"])
    ).resolves.toEqual({
      "inst-456": expect.objectContaining({
        owner: "runtime",
        phase: "runtime",
        recoveryAction: "repair_runtime",
      }),
    });

    expect(inMock).toHaveBeenCalledWith("instance_id", ["inst-456", "inst-123"]);
  });

  it("returns the alerts unchanged when no instances are provided", () => {
    const alerts = {
      "inst-123": buildAlert({ lastSeenAt: "2026-05-05T08:00:00.000Z" }),
    };
    expect(suppressFailureAlertsResolvedByLifecycle(alerts, [])).toEqual(alerts);
  });

  it("suppresses alerts older than the last healthy lifecycle transition", () => {
    const alerts = {
      "inst-123": buildAlert({ lastSeenAt: "2026-05-05T08:00:00.000Z" }),
    };
    expect(
      suppressFailureAlertsResolvedByLifecycle(alerts, [
        {
          id: "inst-123",
          status: "running",
          last_lifecycle_transition_at: "2026-05-05T09:00:00.000Z",
        },
      ])
    ).toEqual({});
  });

  it("keeps alerts newer than the last healthy lifecycle transition", () => {
    const alerts = {
      "inst-123": buildAlert({ lastSeenAt: "2026-05-05T10:00:00.000Z" }),
    };
    expect(
      suppressFailureAlertsResolvedByLifecycle(alerts, [
        {
          id: "inst-123",
          status: "running",
          last_lifecycle_transition_at: "2026-05-05T09:00:00.000Z",
        },
      ])
    ).toEqual(alerts);
  });

  it("keeps alerts when the instance is not in a healthy lifecycle state", () => {
    const alerts = {
      "inst-123": buildAlert({ lastSeenAt: "2026-05-05T08:00:00.000Z" }),
    };
    expect(
      suppressFailureAlertsResolvedByLifecycle(alerts, [
        {
          id: "inst-123",
          status: "error",
          last_lifecycle_transition_at: "2026-05-05T09:00:00.000Z",
        },
      ])
    ).toEqual(alerts);
  });

  it("keeps alerts when no transition timestamp is available", () => {
    const alerts = {
      "inst-123": buildAlert({ lastSeenAt: "2026-05-05T08:00:00.000Z" }),
    };
    expect(
      suppressFailureAlertsResolvedByLifecycle(alerts, [
        {
          id: "inst-123",
          status: "running",
          last_lifecycle_transition_at: null,
        },
      ])
    ).toEqual(alerts);
  });

  it("warns and returns no alerts when the ops-events query fails", async () => {
    mockOpsEventsQuery({
      error: { message: "relation does not exist" },
    });

    await expect(getLatestInstanceFailureAlerts(["inst-123"])).resolves.toEqual({});

    expect(log.warn).toHaveBeenCalledWith(
      "failed to read instance failure events; continuing without failure badges",
      expect.objectContaining({
        source: "instance-failure-alerts",
        failureType: "instance_failure_alert_read_failed",
        context: "query_error",
        errorDescription: "relation does not exist",
      }),
      expect.anything()
    );
  });
});
