import {
  buildClearedArchivePointerPatch,
  buildInstanceLifecyclePatch,
  canTransitionInstanceLifecycle,
  getLifecycleStateForStatus,
  isInstanceProvisioningDisabled,
  isPausedLifecycleState,
} from "@/lib/instance-lifecycle";

describe("instance lifecycle helpers", () => {
  const originalDisabled = process.env.HERMES_PROVISIONING_DISABLED;
  const originalReason = process.env.HERMES_PROVISIONING_DISABLED_REASON;

  afterEach(() => {
    process.env.HERMES_PROVISIONING_DISABLED = originalDisabled;
    process.env.HERMES_PROVISIONING_DISABLED_REASON = originalReason;
  });

  it("maps current legacy statuses into v2 lifecycle states without changing public status strings", () => {
    expect(getLifecycleStateForStatus("provisioning")).toBe("provisioning");
    expect(getLifecycleStateForStatus("redeploying")).toBe("provisioning");
    expect(getLifecycleStateForStatus("running")).toBe("active");
    expect(getLifecycleStateForStatus("stopped")).toBe("paused");
    expect(getLifecycleStateForStatus("error")).toBe("failed");
    expect(getLifecycleStateForStatus("failed")).toBe("failed");
    expect(getLifecycleStateForStatus("deleted")).toBe("deleted");
    expect(getLifecycleStateForStatus("unknown")).toBe("failed");
  });

  it("builds compatible status updates with canonical lifecycle metadata", () => {
    // Transition to active also clears any pending auto-deletion schedule —
    // resuming a suspended agent is the explicit signal that the user wants
    // to keep it. See stale-suspended-sweep for the producer side.
    expect(
      buildInstanceLifecyclePatch("running", {
        now: "2026-04-24T12:00:00.000Z",
      })
    ).toEqual({
      status: "running",
      lifecycle_state: "active",
      scheduled_deletion_at: null,
      paused_reason: null,
      last_lifecycle_transition_at: "2026-04-24T12:00:00.000Z",
      updated_at: "2026-04-24T12:00:00.000Z",
    });

    expect(
      buildInstanceLifecyclePatch("deleted", {
        now: "2026-04-24T12:00:00.000Z",
      })
    ).toEqual({
      status: "deleted",
      lifecycle_state: "deleted",
      deleted_at: "2026-04-24T12:00:00.000Z",
      paused_reason: null,
      last_lifecycle_transition_at: "2026-04-24T12:00:00.000Z",
      updated_at: "2026-04-24T12:00:00.000Z",
    });
  });

  it("does not clear scheduled_deletion_at on non-active transitions", () => {
    // We only clear on transition to active (the unambiguous "user wants this"
    // signal). For other transitions we leave the column alone so the sweeper's
    // schedule, if any, stays in effect.
    expect(
      buildInstanceLifecyclePatch("stopped", {
        now: "2026-04-24T12:00:00.000Z",
      })
    ).toEqual({
      status: "stopped",
      lifecycle_state: "paused",
      paused_reason: null,
      last_lifecycle_transition_at: "2026-04-24T12:00:00.000Z",
      updated_at: "2026-04-24T12:00:00.000Z",
    });

    expect(
      buildInstanceLifecyclePatch("provisioning", {
        now: "2026-04-24T12:00:00.000Z",
      })
    ).toEqual({
      status: "provisioning",
      lifecycle_state: "provisioning",
      paused_reason: null,
      last_lifecycle_transition_at: "2026-04-24T12:00:00.000Z",
      updated_at: "2026-04-24T12:00:00.000Z",
    });
  });

  it("keeps deleted as a terminal lifecycle state", () => {
    expect(canTransitionInstanceLifecycle("provisioning", "active")).toBe(true);
    expect(canTransitionInstanceLifecycle("active", "paused")).toBe(true);
    expect(canTransitionInstanceLifecycle("active", "deleted")).toBe(true);
    expect(canTransitionInstanceLifecycle("deleted", "active")).toBe(false);
  });

  it("flags only lifecycle_state='paused' as intentionally paused, treating null/unknown as live", () => {
    // Every pause reason (inactivity / capacity_pressure / dormant_reclaimed /
    // ram_cap_hit) lands the row in lifecycle_state='paused', so the single
    // 'paused' check covers them all. NULL/unknown must be live so legacy rows
    // (and freshly-running boxes) are still probed/redeployed.
    expect(isPausedLifecycleState("paused")).toBe(true);
    expect(isPausedLifecycleState("active")).toBe(false);
    expect(isPausedLifecycleState("suspended")).toBe(false);
    expect(isPausedLifecycleState("provisioning")).toBe(false);
    expect(isPausedLifecycleState(null)).toBe(false);
    expect(isPausedLifecycleState(undefined)).toBe(false);
    expect(isPausedLifecycleState("")).toBe(false);
  });

  it("clears the cold-storage pointer on a confirmed-live restore", () => {
    // Regression: archive_uri is written only alongside lifecycle_state=
    // 'cold_archived', and every reader filters on cold_archived/
    // pending_deletion. A restored-then-re-paused row kept the stale pointer,
    // so the archive cron's `archive_uri IS NULL` filter could never select it
    // again and it held its thin-pool disk forever (25 rows by 2026-09-17).
    expect(buildClearedArchivePointerPatch()).toEqual({
      archive_uri: null,
      archive_sha256: null,
      archive_size_bytes: null,
      archived_at: null,
    });
  });

  it("keeps archive_count when clearing the pointer", () => {
    // archive_count is a lifetime counter that the archive write increments;
    // clearing it would misreport how many times the instance was archived.
    expect(buildClearedArchivePointerPatch()).not.toHaveProperty("archive_count");
  });

  it("supports a global admin provisioning kill switch", () => {
    process.env.HERMES_PROVISIONING_DISABLED = "true";
    process.env.HERMES_PROVISIONING_DISABLED_REASON = "maintenance window";

    expect(isInstanceProvisioningDisabled()).toEqual({
      disabled: true,
      reason: "maintenance window",
    });
  });
});
