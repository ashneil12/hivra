import "server-only";

import { reportResponseBody } from "./server-enrollment-receiver";
import { renderRefusalLine } from "./server-enrollment-script";

export const SERVER_ENROLLMENT_REPORT_PATH = "/api/infrastructure/server-enrollments/report";
export const SERVER_ENROLLMENT_SCRIPT_PATH = "/enroll";

/**
 * Before showing a command, check that this deployment answers both machine
 * paths the way a server will meet them, with no cookie, code or bypass key:
 * - GET /enroll without a code must be the script itself (HTTP 200, text,
 *   ending in the missing-code refusal line), not a login or protection
 *   redirect, so `curl -f … | sudo bash` gets something bash can run;
 * - POST to the report endpoint without a code must be its constant refusal.
 * A preview behind deployment protection shows "Setup commands aren't
 * available on this deployment" instead of a command that can't work.
 */
export async function isServerEnrollmentReportReachable(origin: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const script = await request(origin + SERVER_ENROLLMENT_SCRIPT_PATH, {
      method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (script.status !== 200 || !script.headers.get("content-type")?.toLowerCase().startsWith("text/plain")) {
      void script.body?.cancel().catch(() => undefined);
      return false;
    }
    if (!(await script.text()).endsWith(renderRefusalLine("missing_code") + "\n")) return false;
    const report = await request(origin + SERVER_ENROLLMENT_REPORT_PATH, {
      method: "POST", redirect: "manual", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (report.status !== 401 || !report.headers.get("content-type")?.toLowerCase().startsWith("text/plain")) {
      void report.body?.cancel().catch(() => undefined);
      return false;
    }
    return (await report.text()) === reportResponseBody("not_usable");
  } catch {
    return false;
  }
}
