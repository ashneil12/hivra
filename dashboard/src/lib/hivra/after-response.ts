import "server-only";

// Work that must not hold up a response: it runs after the response is sent,
// inside the same function invocation (next/server `after`), so it is still
// bounded by the route's maxDuration. The response is already gone when it
// runs, so a failure is logged, never thrown.

import { after } from "next/server";
import { log } from "@/lib/logger";

export function runAfterResponse(
  task: () => Promise<unknown>,
  context: { source: string; failureType: string } & Record<string, unknown>,
): void {
  after(async () => {
    try {
      await task();
    } catch (error) {
      log.warn("background step failed", {
        ...context,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
