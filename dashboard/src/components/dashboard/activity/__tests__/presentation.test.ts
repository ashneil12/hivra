import type {
  ActivityCapability,
  ActivityCapabilityState,
  ActivityEvent,
  ActivityResource,
} from "@/lib/activity-observability/types";
import {
  capabilityExplanation,
  capabilityNames,
  capabilityStateLabel,
  formatDuration,
  installFailureText,
  monitoringStates,
  presentEvent,
  reportingAlerts,
  sourceExplanation,
  sourceNames,
} from "../presentation";

const event = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: "one",
  kind: "tool_activity",
  title: "Agent activity",
  agentId: "agent-1",
  agentName: "Builder",
  occurredAt: "2026-09-21T12:00:00Z",
  outcome: "unknown",
  severity: "info",
  summary: "Report",
  source: { kind: "otlp_log", label: "Agent" },
  evidence: [],
  needsAttention: false,
  ...overrides,
});
const tracing = (
  state: ActivityCapabilityState,
  extra: Partial<ActivityCapability> = {},
): ActivityCapability => ({
  key: "native_tracing",
  label: "Agent run reporting",
  state,
  ...extra,
});

it("formats reported durations in plain units", () => {
  expect(formatDuration(850)).toBe("850 ms");
  expect(formatDuration(5000)).toBe("5.0 s");
  expect(formatDuration(59_949)).toBe("59.9 s");
  expect(formatDuration(59_990)).toBe("1 min 0 s");
  expect(formatDuration(65_000)).toBe("1 min 5 s");
  expect(formatDuration(2 * 3_600_000 + 4 * 60_000)).toBe("2 h 4 min");
  expect(formatDuration(-1)).toBeUndefined();
});

it("presents each native run role in plain language without overclaiming", () => {
  const codex = { producer: "codex" as const };
  expect(presentEvent(event({ ...codex, role: "run.started" }))).toMatchObject({
    title: "Codex started a task",
    status: "Recorded",
    warning: false,
  });
  expect(
    presentEvent(event({ ...codex, role: "run.started" })).happened,
  ).toMatch(
    /never records prompts, replies, commands, file contents, or tool inputs and outputs/,
  );
  const done = presentEvent(
    event({
      ...codex,
      role: "run.completed",
      outcome: "success",
      durationMs: 5000,
    }),
  );
  expect(done).toMatchObject({
    title: "Codex finished a task",
    status: "Finished (reported by the agent)",
  });
  expect(done.happened).toMatch(
    /after 5.0 s\. This does not check whether the work is correct/,
  );
  const failed = presentEvent(
    event({
      producer: "claude-code",
      role: "run.failed",
      outcome: "failure",
      severity: "error",
      errorType: "server_error",
    }),
  );
  expect(failed).toMatchObject({
    title: "Claude Code task ended with a failure",
    warning: true,
  });
  expect(failed.happened).toMatch(/\(type: server_error\)/);
  expect(presentEvent(event({ ...codex, role: "run.stopped" }))).toMatchObject({
    status: "Stopped before finishing",
    warning: false,
  });
  expect(
    presentEvent(event({ role: "tool.started", toolName: "Read" })).title,
  ).toBe("Tool Read started");
  expect(
    presentEvent(
      event({ role: "tool.completed", toolName: "Read", outcome: "success" }),
    ).status,
  ).toBe("Reported successful");
  expect(
    presentEvent(event({ role: "tool.completed", toolName: "exec" })).status,
  ).toBe("Finished; result not reported");
});

it("treats a tool error as a warning agents often recover from", () => {
  const presented = presentEvent(
    event({
      role: "tool.failed",
      toolName: "Bash",
      outcome: "failure",
      severity: "warning",
    }),
  );
  expect(presented).toMatchObject({
    title: "Tool Bash reported an error",
    status: "Tool reported an error",
    warning: true,
  });
  expect(presented.guidance).toMatch(/Agents often recover from tool errors/);
  expect(presented.guidance).toMatch(/Check whether the task finished/);
});

it("drops unsafe tool names and unknown producers or roles from plain-language copy", () => {
  expect(
    presentEvent(event({ role: "tool.started", toolName: "Bash; rm -rf /" }))
      .title,
  ).toBe("A tool started");
  expect(
    presentEvent(event({ role: "run.started", producer: "evil" as never }))
      .title,
  ).toBe("The agent started a task");
  expect(presentEvent(event({ role: "run.exploded" as never })).title).toBe(
    "Agent tool used",
  );
});

it("names agent run reporting and every coverage state", () => {
  expect(capabilityNames.native_tracing).toBe("Agent run reporting");
  expect(sourceNames["agent-tracing"]).toBe("Agent run reporting");
  expect(monitoringStates).toMatchObject({
    expired: "Reporting credential expired",
    unsupported: "Not available for this agent",
    not_running: "Agent not running",
    configured: "Waiting for first report",
    degraded: "Unable to load",
  });
  expect(capabilityStateLabel(tracing("observed"))).toBe("Reporting");
  expect(capabilityStateLabel(tracing("stale"))).toBe("Stopped checking in");
  expect(capabilityStateLabel(tracing("expired"))).toBe(
    "Reporting credential expired",
  );
  // Other capabilities keep the history wording.
  expect(
    capabilityStateLabel({
      key: "tool_activity",
      label: "Tools",
      state: "observed",
    }),
  ).toBe("Records available");
});

it.each<[ActivityCapabilityState, RegExp]>([
  [
    "stale",
    /^Hasn’t checked in for 15\+ min while running; runs in this gap may be missing\.$/,
  ],
  [
    "missing",
    /^Reporting has not been set up on this computer\. Computers launched before automatic reporting get it when they are restarted after their host is updated\.$/,
  ],
  ["expired", /credential ran out.*Restarting the computer issues a new one/],
  ["configured", /first check-in should arrive within 10 minutes/],
  ["unsupported", /Claude Code and Codex computers only/],
  ["not_running", /not running right now, so no reports are expected/],
  ["observed", /not an audit/],
  ["degraded", /Refresh to try again/],
])(
  "explains the %s reporting state honestly in one line",
  (state, expected) => {
    const text = capabilityExplanation(tracing(state));
    expect(text).toMatch(expected);
    expect(text?.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
  },
);

it("says a checking-in computer with a wrong clock is having its run reports refused", () => {
  const text = capabilityExplanation({ ...tracing("stale"), reason: "clock_skew" });
  expect(text).toMatch(/clock is wrong/);
  expect(text).toMatch(/refusing its run reports/);
  expect(text).not.toMatch(/Hasn’t checked in/);
});

it("only explains capabilities with a per-computer check-in", () => {
  expect(
    capabilityExplanation({
      key: "lifecycle",
      label: "Lifecycle",
      state: "missing",
    }),
  ).toBeUndefined();
});

it("explains the agent run reporting source without treating silence as idleness", () => {
  const source = {
    id: "agent-tracing" as const,
    label: "Agent run reporting",
    detail: "",
  };
  expect(sourceExplanation({ ...source, state: "missing" })).toMatch(
    /Silence does not mean the agents were idle/,
  );
  expect(sourceExplanation({ ...source, state: "stale" })).toMatch(
    /some of its runs may be missing/,
  );
  expect(sourceExplanation({ ...source, state: "active" })).toMatch(
    /not an audit of the computer/,
  );
});

it("says why no computer reports runs: none on a supported host, none at all, or none running", () => {
  const source = {
    id: "agent-tracing" as const,
    label: "Agent run reporting",
    state: "missing" as const,
    detail: "",
  };
  const computer = (
    id: string,
    agentType: string,
    capability: ActivityCapability,
  ): ActivityResource => ({ id, name: id, agentType, capabilities: [capability] });
  // Claude Code on a provider VM: the host type is the limit, not the agent.
  const provider = sourceExplanation(source, [
    computer("p", "claude-code", tracing("unsupported", { reason: "substrate" })),
    computer("d", "linux-desktop", tracing("unsupported", { reason: "agent_type" })),
  ]);
  expect(provider).toMatch(/Your Claude Code or Codex computers run on a host type that isn’t supported yet/);
  expect(provider).not.toMatch(/Silence|There are none/);
  // An older response without a reason still infers the host type from the agent type.
  expect(
    sourceExplanation(source, [computer("c", "codex", tracing("unsupported"))]),
  ).toMatch(/host type that isn’t supported yet/);
  expect(
    sourceExplanation(source, [computer("d", "linux-desktop", tracing("unsupported"))]),
  ).toMatch(/There are none in this account/);
  expect(
    sourceExplanation(source, [computer("s", "codex", tracing("not_running"))]),
  ).toBe("No Claude Code or Codex computer is running, so no reports are expected.");
  expect(
    sourceExplanation(source, [computer("m", "codex", tracing("missing", { reason: "not_set_up" }))]),
  ).toMatch(/Silence does not mean the agents were idle/);
});

it("raises reporting alerts only for running computers that are stale or expired", () => {
  const resource = (
    id: string,
    state: ActivityCapabilityState,
    status?: string,
  ): ActivityResource => ({
    id,
    name: id,
    ...(status ? { status } : {}),
    capabilities: [tracing(state)],
  });
  const alerts = reportingAlerts([
    resource("stale-running", "stale", "running"),
    resource("expired-running", "expired", "running"),
    resource("expired-no-status", "expired"),
    resource("stale-stopped", "stale", "stopped"),
    resource("missing", "missing", "running"),
    resource("observed", "observed", "running"),
    {
      id: "legacy",
      name: "legacy",
      capabilities: [{ key: "tool_activity", label: "Tools", state: "stale" }],
    },
  ]);
  expect(alerts.map((alert) => alert.resource.id)).toEqual([
    "stale-running",
    "expired-running",
    "expired-no-status",
  ]);
});

it("names the host type, not the agent type, when Claude Code or Codex runs on an unsupported host", () => {
  const substrate = tracing("unsupported", { reason: "substrate" });
  expect(capabilityStateLabel(substrate)).toBe("Not available on this host type");
  expect(capabilityExplanation(substrate)).toBe(
    "Automatic run reporting works for Claude Code and Codex on Hivra-hosted computers; this computer’s host type isn’t supported yet.",
  );
  expect(capabilityExplanation(substrate)).not.toMatch(/computers only/);
  // Without a reason from the feed, a Claude Code or Codex type still means the host is the limit.
  expect(
    capabilityExplanation(tracing("unsupported"), { agentType: "claude-code" }),
  ).toMatch(/host type isn’t supported yet/);
  const other = tracing("unsupported", { reason: "agent_type" });
  expect(capabilityStateLabel(other)).toBe("Not available for this agent");
  expect(capabilityExplanation(other)).toBe(
    "Automatic run reporting covers Claude Code and Codex computers only.",
  );
  expect(
    capabilityExplanation(tracing("unsupported"), { agentType: "aeon" }),
  ).toMatch(/computers only/);
});

it("tells never set up, set up but silent, and could not be installed apart", () => {
  const notSetUp = tracing("missing", { reason: "not_set_up" });
  expect(capabilityStateLabel(notSetUp)).toBe("Not set up");
  expect(capabilityExplanation(notSetUp)).toMatch(/has not been set up/);
  const silent = tracing("missing", {
    reason: "never_checked_in",
    issuedAt: "2026-09-21T10:00:00Z",
  });
  expect(capabilityStateLabel(silent)).toBe("No reports received");
  expect(capabilityExplanation(silent)).toBe(
    "Reporting was set up, but the reporter has never checked in, so runs on this computer are not being recorded. Restarting the computer reinstalls it.",
  );
  expect(capabilityExplanation(silent)).not.toMatch(/launched before/);
  // Without a reason, an issued credential still rules out "launched before reporting".
  expect(
    capabilityExplanation(
      tracing("missing", { expiresAt: "2026-09-28T10:00:00Z" }),
    ),
  ).toMatch(/never checked in/);
  const failed = tracing("missing", {
    reason: "install_failed",
    installFailedAt: "2026-09-21T10:01:00Z",
    installFailureReason: "transfer_failed",
  });
  expect(capabilityStateLabel(failed)).toBe("Reporter could not be installed");
  expect(capabilityExplanation(failed)).toBe(
    "The reporter could not be installed, so runs on this computer are not being recorded. Restarting the computer tries again.",
  );
  expect(installFailureText("transfer_failed")).toBe(
    "it could not be copied to the computer",
  );
  expect(installFailureText("source_missing")).toBe(
    "its files were not available on the host",
  );
  expect(installFailureText("not_attempted")).toBe(
    "the start did not reach the install step",
  );
  expect(installFailureText("disk_full")).toBe("failure code disk_full");
  // An older response without a reason: a recorded failed install still reads as one.
  expect(
    capabilityStateLabel(
      tracing("missing", { installFailedAt: "2026-09-21T10:01:00Z", issuedAt: "2026-09-21T10:00:00Z" }),
    ),
  ).toBe("Reporter could not be installed");
  expect(installFailureText(undefined)).toBeUndefined();
});

it("explains an expired credential the computer still presents after a re-issue", () => {
  const presented = tracing("expired", {
    reason: "expired_credential_presented",
    expiresAt: "2026-09-28T12:00:00Z",
    issuedAt: "2026-09-21T11:40:00Z",
  });
  expect(capabilityExplanation(presented)).toBe(
    "The computer presented an expired reporting credential after its latest one was issued, so new runs are not being recorded. Restarting the computer issues a fresh one; if this keeps happening, contact support.",
  );
  // It never claims the expiry ran out: the recorded credential is still valid.
  expect(capabilityExplanation(presented)).not.toMatch(/ran out/);
  // An older response without a reason: a future expiry on an expired state
  // means the same; without an issuance it claims no re-issue.
  const inferred = capabilityExplanation(
    tracing("expired", { expiresAt: "2026-09-28T12:00:00Z" }),
    { now: "2026-09-21T12:00:00Z" },
  );
  expect(inferred).toMatch(/^The computer presented an expired reporting credential, so new runs/);
  expect(inferred).not.toMatch(/issued/);
  expect(
    capabilityExplanation(
      tracing("expired", { expiresAt: "2026-09-20T12:00:00Z" }),
      { now: "2026-09-21T12:00:00Z" },
    ),
  ).toMatch(/credential ran out/);
});

it.each<[string | undefined, RegExp]>([
  ["stopped", /^Stopped; no reports expected until it starts again\.$/],
  ["provisioning", /^Still being set up; reports are expected once it is running\.$/],
  ["pending", /^Still being set up/],
  ["starting", /^Starting; reports are expected once it is running\.$/],
  ["error", /recorded a problem with this computer/],
  ["resizing", /^This computer is not running right now, so no reports are expected\.$/],
  [undefined, /^This computer is not running right now/],
])("words not_running from the computer's actual status (%s)", (status, expected) => {
  const text = capabilityExplanation(tracing("not_running"), { status });
  expect(text).toMatch(expected);
  if (status !== "stopped") expect(text).not.toMatch(/^Stopped/);
});
