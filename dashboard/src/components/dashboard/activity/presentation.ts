import type {
  ActivityEvent,
  ActivitySource,
} from "@/lib/activity-observability/types";

export const kindLabels: Record<string, string> = {
  lifecycle: "Computer changes",
  desktop_session: "Desktop access",
  trace_span: "Agent actions",
  tool_activity: "Agent tools",
};
export const sourceNames: Record<string, string> = {
  "hivra-lifecycle": "Computer changes",
  "hivra-desktop": "Desktop access",
  "otlp-traces": "Agent actions",
  "otlp-logs": "Agent tool use",
};
export const capabilityNames: Record<string, string> = {
  lifecycle: "Computer changes",
  desktop: "Desktop access",
  traces: "Agent actions",
  tool_activity: "Agent tool use",
};
export const monitoringStates: Record<string, string> = {
  active: "Records available",
  observed: "Records available",
  configured: "Ready to receive records",
  missing: "No records yet",
  stale: "No recent reports",
  degraded: "Unable to load",
};
export function presentEvent(event: ActivityEvent) {
  const desktop = event.kind === "desktop_session";
  const failed = event.outcome === "failure" || event.severity === "error";
  const title = desktop
    ? "Desktop access allowed"
    : ((
        {
          "Computer provisioned": "Computer created",
          "Launch requested": "Computer launch requested",
          "Instrumented operation": "Agent reported an action",
          "Agent activity": "Agent reported an action",
        } as Record<string, string>
      )[event.title] ?? event.title);
  const status = failed
    ? "Reported a problem"
    : event.needsAttention
      ? "Worth checking"
      : event.outcome === "success"
        ? "Reported successful"
        : "Recorded";
  let happened: string;
  if (desktop)
    happened =
      "Hivra allowed a request to access this computer’s desktop. This record does not confirm that anyone connected or used the desktop.";
  else if (event.kind === "lifecycle")
    happened = failed
      ? "Hivra recorded a problem while changing this computer. This record alone does not tell us its current state."
      : `${title}. Hivra saved this change in the computer’s history.`;
  else
    happened = failed
      ? "The agent reported a problem with an action. This does not tell us whether the rest of its work finished."
      : "The agent sent a record of an action. This does not confirm that its overall task is complete.";
  const guidance = failed
    ? "Open the agent or computer to check its current state. Review the technical details below for the reported error before deciding whether to retry."
    : event.needsAttention
      ? "This record was marked for review. Check the technical details and the agent or computer before taking action."
      : desktop
        ? "This is routine access history, not an alert. If you did not expect desktop access at this time, review access to your account."
        : "This is routine history, not an alert. No action is requested by this record.";
  return { title, status, happened, guidance };
}
export function sourceExplanation(source: ActivitySource) {
  if (source.state === "degraded")
    return "Hivra could not load these records. Refresh to try again; activity may be missing until the read succeeds.";
  if (source.state === "missing")
    return "No reports of this kind have arrived in the last 30 days. Reporting may not be set up, or there may have been nothing to report. Missing reports do not tell us whether the computer is working.";
  if (source.state === "stale")
    return "Reports arrived before, but none recently. A quiet agent does not necessarily mean monitoring has stopped.";
  return "Hivra can read this history. It records reported actions, not everything happening on the computer.";
}
