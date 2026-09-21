import type {
  InfrastructureConnectionDto,
  InfrastructureConnectionStatus,
  ProxmoxPreflightResult,
} from "./contracts";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function formatInfrastructureBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  if (bytes === 0) return "0 B";
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$|(?<=\.[0-9])0+$/, "")} ${BYTE_UNITS[unitIndex]}`;
}

export function formatInfrastructureDate(value: string | null): string {
  if (!value) return "Not checked yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export type ConnectionPresentation = {
  label: string;
  tone: "neutral" | "checking" | "connected" | "error";
  detail: string;
};

const STATUS_PRESENTATION: Record<InfrastructureConnectionStatus, ConnectionPresentation> = {
  pending: {
    label: "Needs inspection",
    tone: "neutral",
    detail: "Save and run a read-only host inspection.",
  },
  checking: {
    label: "Inspecting",
    tone: "checking",
    detail: "Hivra is inspecting this computer without changing it.",
  },
  ready: {
    label: "Inspected",
    tone: "connected",
    detail: "Host connection verified. Agent readiness depends on the latest inspection.",
  },
  error: {
    label: "Needs attention",
    tone: "error",
    detail: "The latest host inspection found a problem.",
  },
  disabled: {
    label: "Disabled",
    tone: "neutral",
    detail: "This connection is not available for new work.",
  },
};

export function connectionPresentation(
  connection: Pick<InfrastructureConnectionDto, "status">,
): ConnectionPresentation {
  return STATUS_PRESENTATION[connection.status];
}

export function preflightHeadline(result: ProxmoxPreflightResult): {
  title: string;
  detail: string;
  tone: "ready" | "incomplete" | "error";
} {
  if (!result.ok) {
    return {
      title: "Host inspection needs attention",
      detail: result.error.message,
      tone: "error",
    };
  }
  if (!result.target.launchReady) {
    return {
      title: "Host inspected - setup needed",
      detail: "Hivra reached this host, but it still needs setup or attention before an agent can launch.",
      tone: "incomplete",
    };
  }
  return {
    title: "Host ready for agents",
    detail: "This host passed the current capacity, isolation, and runtime checks.",
    tone: "ready",
  };
}
