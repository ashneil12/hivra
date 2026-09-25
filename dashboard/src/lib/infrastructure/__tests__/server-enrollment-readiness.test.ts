/** @jest-environment node */

jest.mock("server-only", () => ({}));

import { isServerEnrollmentReportReachable } from "../server-enrollment-readiness";

const SCRIPT = "hse_x() {\n  :\n}\n{ hivra_refuse 'missing_code'; }\n";
const REFUSAL = "HIVRA_ENROLLMENT v1\nstatus=not_usable\n";

function reply(status: number, body: string, contentType = "text/plain; charset=utf-8") {
  return new Response(body, { status, headers: { "Content-Type": contentType } });
}

function fetcher(script: Response, report: Response) {
  return jest.fn(async (url: string) => (String(url).endsWith("/enroll") ? script : report)) as unknown as typeof fetch;
}

// Review finding 9: the probe also confirms /enroll serves the script
// (HTTP 200, text) and is not redirected, since curl -f pipes only a 200.
describe("isServerEnrollmentReportReachable (10.6)", () => {
  it("is ready only when /enroll serves the script and the report endpoint refuses with its constant body", async () => {
    const request = fetcher(reply(200, SCRIPT), reply(401, REFUSAL));
    await expect(isServerEnrollmentReportReachable("https://hivra.example", request)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("https://hivra.example/enroll", expect.objectContaining({
      method: "GET", redirect: "manual", credentials: "omit" }));
    expect(request).toHaveBeenCalledWith("https://hivra.example/api/infrastructure/server-enrollments/report",
      expect.objectContaining({ method: "POST", redirect: "manual", credentials: "omit" }));
  });

  it.each([
    ["a login redirect on /enroll", reply(307, ""), reply(401, REFUSAL)],
    ["a protection page on /enroll", reply(200, "<html>Log in</html>", "text/html"), reply(401, REFUSAL)],
    ["/enroll without the refusal line", reply(200, "hse_x() {\n  :\n}\n"), reply(401, REFUSAL)],
    ["a 404 for /enroll", reply(404, ""), reply(401, REFUSAL)],
    ["a redirected report endpoint", reply(200, SCRIPT), reply(302, "")],
    ["another report body", reply(200, SCRIPT), reply(401, "Unauthorized")],
  ])("is not ready with %s", async (_label, script, report) => {
    await expect(isServerEnrollmentReportReachable("https://hivra.example", fetcher(script, report))).resolves.toBe(false);
  });

  it("is not ready when the request fails", async () => {
    const request = jest.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(isServerEnrollmentReportReachable("https://hivra.example", request)).resolves.toBe(false);
  });
});
