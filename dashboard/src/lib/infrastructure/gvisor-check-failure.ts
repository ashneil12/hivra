import { InfrastructureApiError } from "./client";
import { tryAgainInMinutes } from "@/lib/retry-after-copy";

/** What a failed strict Linux Sandbox check tells the owner, and what to do next. */
export type GvisorCheckFailure = {
  message: string;
  next: "inspect" | "repair" | "retry" | "wait";
  /** For "wait": how long before Check readiness works again. */
  waitSeconds?: number;
};

/** The limiter's default window when a refusal doesn't say how long. */
export const DEFAULT_CHECK_WAIT_SECONDS = 60;

/** One plain sentence for a failed read-only Linux Sandbox check. */
export function gvisorCheckFailure(error: unknown, hostName: string | undefined): GvisorCheckFailure {
  const name = hostName?.trim() || "This server";
  const named = hostName?.trim() || "this server";
  if (error instanceof InfrastructureApiError) {
    if (error.status === 429) {
      return {
        message: `Hivra checked ${named} a moment ago. ${error.retryAfterSeconds !== null ? tryAgainInMinutes(error.retryAfterSeconds) : "Wait a minute, then try again."}`,
        next: "wait",
        waitSeconds: error.retryAfterSeconds ?? DEFAULT_CHECK_WAIT_SECONDS,
      };
    }
    if (error.code === "discovery_required") {
      return { message: `Hivra's last look at ${named} has expired. Inspect it again, then check readiness.`, next: "inspect" };
    }
    if (error.code === "unsupported") {
      return { message: `${name} no longer meets Linux Sandbox's requirements. Inspect it again to see what changed.`, next: "inspect" };
    }
    if (error.code === "remote_failed") {
      return { message: `Linux Sandbox setup on ${named} didn't pass its check. Reinstall the setup to repair it.`, next: "repair" };
    }
    return { message: error.message, next: "retry" };
  }
  return { message: error instanceof Error ? error.message : "The readiness check could not finish.", next: "retry" };
}
