// Where catalog tools can be installed. A catalog install writes the box's MCP
// config over the owner-bound Proxmox host path (tool-mcp-seed.ts, resolved by
// resolveHivraAgentExecutionContext), and only proxmox-kvm boxes have one.
// Computers in the owner's own cloud account and DigitalOcean sessions have no
// such path yet, so every tool surface says so plainly instead of offering an
// install that can only fail.
//
// Pure and client-safe: the per-agent tool routes, the Tools page targets and
// the Manage Tools card share this one decision.

/** Plain reason catalog tools can't be installed on this substrate, or null. */
export function catalogToolsUnavailableReason(substrate: unknown): string | null {
  // Rows from before the substrate column omit it. They are Proxmox boxes, and
  // the execution context still verifies their binding before any host call.
  if (substrate == null || substrate === "proxmox-kvm") return null;
  if (substrate === "do-managed-session") {
    return "Catalog tools aren't available on DigitalOcean agents yet.";
  }
  return "Catalog tools aren't available on computers in your own cloud yet. Use Advanced MCP.";
}
