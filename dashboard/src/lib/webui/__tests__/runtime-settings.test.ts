import { mapWebUIRuntimeError } from "../runtime-settings";
import { WebUIError } from "../client";

// The client-calling wrappers (resolveWebUIRuntime / readWebUIRuntimeSettings /
// saveWebUIRuntimeSettings / setWebUIDefaultModel / setWebUIProviderKey) were
// retired along with the legacy /api/settings, /api/default-model and
// /api/providers endpoints they targeted (all 404 on the fleet agent image).
// Only the pure error mapper survives — still used by the connectors-sync route.

describe("mapWebUIRuntimeError", () => {
  it("maps WebUI errors to safe runtime error metadata", () => {
    const mapped = mapWebUIRuntimeError(
      new WebUIError("POST /api/settings 502", {
        status: 502,
        body: "provider_secret=super-secret",
      }),
      "WebUI settings request failed.",
    );

    expect(mapped).toEqual({
      message: "WebUI settings request failed.",
      status: 502,
      failureType: "webui_runtime_request_failed",
      retryable: false,
      upstreamStatus: 502,
    });
    expect(JSON.stringify(mapped)).not.toContain("super-secret");
  });

  it("maps generic errors to a safe bad gateway response", () => {
    expect(
      mapWebUIRuntimeError(new Error("network secret leaked"), "Runtime failed."),
    ).toEqual({
      message: "Runtime failed.",
      status: 502,
      failureType: "webui_runtime_request_failed",
      retryable: false,
      upstreamStatus: 502,
    });
  });
});
