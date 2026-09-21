/** @jest-environment jsdom */
import { readJsonWithDiagnostics } from "../json-response-diagnostics";

import posthog from "posthog-js";
import { clientLog } from "@/lib/client/logger";

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
  },
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: {
    warn: jest.fn(),
  },
}));

function makeResponse({
  body,
  status,
  requestId,
  url = "",
}: {
  body: string;
  status: number;
  requestId?: string;
  url?: string;
}): Response {
  return {
    status,
    url,
    headers: {
      get: (name: string) => (name.toLowerCase() === "x-request-id" ? requestId ?? null : null),
    },
    text: async () => body,
  } as unknown as Response;
}

describe("readJsonWithDiagnostics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns parsed JSON when the response body is valid", async () => {
    const response = makeResponse({
      body: JSON.stringify({ success: true }),
      status: 200,
      requestId: "req_ok",
    });

    await expect(readJsonWithDiagnostics(response, { source: "test" })).resolves.toEqual({
      success: true,
    });
    expect(posthog.captureException).not.toHaveBeenCalled();
  });

  it("captures endpoint, request id, status, and body snippet when JSON parsing fails", async () => {
    const response = makeResponse({
      body: "<html>bad gateway</html>",
      status: 502,
      requestId: "req_bad",
      url: "https://hermesos.cloud/api/billing/usage",
    });

    await expect(readJsonWithDiagnostics(response, { source: "billing-page" })).resolves.toBeNull();

    expect(posthog.captureException).toHaveBeenCalledWith(
      expect.any(SyntaxError),
      expect.objectContaining({
        apiEndpoint: "https://hermesos.cloud/api/billing/usage",
        requestId: "req_bad",
        responseStatus: 502,
        rawBodySnippet: "<html>bad gateway</html>",
        failureType: "json_parse_failed",
      })
    );
    expect(clientLog.warn).toHaveBeenCalledWith(
      "API response was not valid JSON",
      expect.objectContaining({
        requestId: "req_bad",
        responseStatus: 502,
      }),
      expect.any(SyntaxError)
    );
  });

  it("does not let diagnostic reporter failures replace JSON parse handling", async () => {
    jest.mocked(posthog.captureException).mockImplementationOnce(() => {
      throw new Error("PostHog offline");
    });
    jest.mocked(clientLog.warn).mockImplementationOnce(() => {
      throw new Error("logger offline");
    });
    const response = makeResponse({
      body: "<html>bad gateway</html>",
      status: 502,
      requestId: "req_reporter_down",
      url: "https://hermesos.cloud/api/billing/usage",
    });

    await expect(readJsonWithDiagnostics(response, { source: "billing-page" })).resolves.toBeNull();

    expect(posthog.captureException).toHaveBeenCalledWith(
      expect.any(SyntaxError),
      expect.objectContaining({
        requestId: "req_reporter_down",
        failureType: "json_parse_failed",
      })
    );
  });
});
