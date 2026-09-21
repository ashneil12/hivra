import { NextRequest } from "next/server";

import { POST } from "../route";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
}));

const reportOpsEventMock = reportOpsEvent as jest.MockedFunction<typeof reportOpsEvent>;

function buildRequest(body: unknown): NextRequest {
  return new NextRequest("https://hermesos.cloud/api/csp/report", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/csp/report", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reportOpsEventMock.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof reportOpsEvent>>);
  });

  it("returns 204 and writes one ops event for a single legacy csp-report", async () => {
    const response = await POST(
      buildRequest({
        "csp-report": {
          "blocked-uri": "https://evil.example/x.js",
          "document-uri": "https://hermesos.cloud/page",
          "violated-directive": "script-src",
          "effective-directive": "script-src",
          disposition: "enforce",
        },
      })
    );

    expect(response.status).toBe(204);
    expect(reportOpsEventMock).toHaveBeenCalledTimes(1);
  });

  it("silently 204s on malformed JSON without writing any ops event", async () => {
    const req = new NextRequest("https://hermesos.cloud/api/csp/report", {
      method: "POST",
      body: "not json {{{",
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(req);

    expect(response.status).toBe(204);
    expect(reportOpsEventMock).not.toHaveBeenCalled();
  });

  it("caps fan-out at 16 ops-event writes regardless of array length (DoS guard)", async () => {
    const giant = Array.from({ length: 5000 }, (_, i) => ({
      type: "csp-violation",
      body: {
        blockedURL: `https://evil.example/${i}.js`,
        documentURL: "https://hermesos.cloud/page",
        effectiveDirective: "script-src",
        disposition: "enforce",
      },
    }));

    const response = await POST(buildRequest(giant));

    expect(response.status).toBe(204);
    expect(reportOpsEventMock).toHaveBeenCalledTimes(16);
  });
});
