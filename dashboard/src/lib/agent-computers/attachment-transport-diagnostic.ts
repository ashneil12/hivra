import { log } from "@/lib/logger";

// A host step that fails without a refusal Hivra can name is held as
// "transport_failed", which on its own says nothing about why (live on Canary:
// an activation and then every observation held with no cause to read). This
// logs what the host said, bounded and with anything token-shaped masked, so
// the cause is in the logs. It changes no decision.

const TAIL = 600;
/** Long runs of hex, base64 or base64url: digests, tokens and keys. */
const TOKEN_SHAPED = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

function tail(text: string | undefined): string {
  const value = (text ?? "").replace(TOKEN_SHAPED, "[masked]");
  return value.length > TAIL ? value.slice(-TAIL) : value;
}

export function logAttachmentTransportFailure(
  step: string,
  context: { sourceId: string; vmid: number | null },
  failure: { error?: string; stdout?: string; stderr?: string } | unknown,
): void {
  const detail = failure && typeof failure === "object" && "stdout" in failure
    ? failure as { error?: string; stdout?: string; stderr?: string }
    : { error: failure instanceof Error ? failure.message : String(failure) };
  log.warn("attach host step failed without a named refusal", {
    source: "agent-attachments",
    failureType: "attachment_transport_failed",
    step,
    computerId: context.sourceId,
    vmid: context.vmid,
    error: tail(detail.error),
    stderrTail: tail(detail.stderr),
    stdoutTail: tail(detail.stdout),
  });
}
