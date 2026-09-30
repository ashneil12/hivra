// The activity rows for an agent added to a computer (design 5.7): "Codex
// added to MY_UBUNTU_DESKTOP · access: ~/Hivra read and write, internet",
// "Access changed", "Codex removed · files in ~/Hivra kept". Rebuilt from the
// event's label fields only (the worker writes ids and labels, never tokens,
// prompts or paths), each checked again on read. Client-safe.

export const ATTACH_ACTIVITY_EVENTS = Object.freeze(["agent_attached", "agent_attach_failed", "agent_access_changed", "agent_removed"]);

/** The two access labels the worker writes (attachment-worker.ts grantsLabel). */
const ACCESS_LABELS = new Set(["~/Hivra read and write, internet", "internet, no shared folder"]);
const AGENT_NAMES = new Set(["Codex"]);

export interface AttachActivityFields {
  agentName?: unknown;
  computerName?: unknown;
  access?: unknown;
}

/** A computer's own name, shown as the owner typed it: short, one line, no control characters. */
function plainName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  // Printable text only: no control characters or line separators.
  const printable = [...name].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f && code !== 0x2028 && code !== 0x2029;
  });
  return name && name.length <= 64 && printable ? name : null;
}

/** The row's words for an attach event, or null for every other event. */
export function attachActivityLine(event: string, fields: AttachActivityFields | null | undefined): string | null {
  if (!ATTACH_ACTIVITY_EVENTS.includes(event)) return null;
  const agent = typeof fields?.agentName === "string" && AGENT_NAMES.has(fields.agentName) ? fields.agentName : "Agent";
  const computer = plainName(fields?.computerName);
  const access = typeof fields?.access === "string" && ACCESS_LABELS.has(fields.access) ? fields.access : null;
  switch (event) {
    case "agent_attached":
      return `${agent} added${computer ? ` to ${computer}` : ""}${access ? ` · access: ${access}` : ""}`;
    case "agent_attach_failed":
      return `${agent} not added${computer ? ` to ${computer}` : ""}`;
    case "agent_access_changed":
      return "Access changed";
    default:
      return `${agent} removed · files in ~/Hivra kept`;
  }
}
