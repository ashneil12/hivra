// Client helper: open an agent's Hermes WebUI as its own top-level browser tab.
// Top-level navigation makes <vm>.agents.hermesos.cloud the document's own
// first-party origin, so the login cookie survives the redirect — sidestepping
// the third-party-cookie partitioning that the inline iframe handoff fights.

export type OpenWebuiResult =
  | { status: "opened" }
  | { status: "pending"; message: string }
  | { status: "error"; reason: string }
  | { status: "blocked" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function openWebuiWorkspaceInNewTab(instanceId: string): Promise<OpenWebuiResult> {
  // Open synchronously inside the click gesture so the popup blocker stays
  // happy, then sever the reverse opener link before navigating it. We can't
  // use "noopener" here: that makes window.open return null, and we need the
  // handle to redirect the blank tab once the login URL is minted.
  const opened = window.open("about:blank", "_blank");
  if (!opened) {
    return { status: "blocked" };
  }
  try {
    opened.opener = null;
  } catch {
    // Some browsers expose `opener` as read-only on the fresh window; the tab
    // still points at our own first-party WebUI, so this is non-fatal.
  }

  try {
    const res = await fetch(`/api/instances/${instanceId}/webui-login-url`, {
      cache: "no-store",
      credentials: "same-origin",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      opened.close();
      return { status: "error", reason: `HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}` };
    }

    const body: unknown = await res.json().catch(() => null);

    if (isRecord(body) && body.kind === "pending") {
      opened.close();
      return {
        status: "pending",
        message:
          typeof body.message === "string" && body.message.trim()
            ? body.message
            : "Your workspace is still starting up. Try again in a moment.",
      };
    }

    if (!isRecord(body) || typeof body.url !== "string") {
      opened.close();
      return { status: "error", reason: "Workspace login response was malformed." };
    }

    opened.location.href = body.url;
    return { status: "opened" };
  } catch (err) {
    opened.close();
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}
