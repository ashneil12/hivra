import { NextRequest } from "next/server";

type OpsEventInput = {
  source: string;
  severity?: string;
  title: string;
  message: string;
  route?: string;
  metadata?: Record<string, unknown>;
};

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn(),
}));

// The rate limiter and the distinct-fingerprint budget keep counters in module
// memory. Load a fresh copy of the route (and of both) for every test so one
// test's traffic never counts against the next.
let POST: (request: NextRequest) => Promise<Response>;
let reportOpsEventMock: jest.Mock<Promise<unknown>, [OpsEventInput]>;

const HOST = "hermesos.cloud";

function buildRequest(body: unknown, ip = "203.0.113.10", host = HOST): NextRequest {
  return new NextRequest(`https://${host}/api/csp/report`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
  });
}

function legacyReport(overrides: Record<string, unknown> = {}) {
  return {
    "csp-report": {
      "blocked-uri": "https://evil.example/x.js",
      "document-uri": `https://${HOST}/page`,
      "violated-directive": "script-src",
      "effective-directive": "script-src",
      disposition: "enforce",
      ...overrides,
    },
  };
}

function writtenEvents(): OpsEventInput[] {
  return reportOpsEventMock.mock.calls.map(([input]) => input);
}

describe("POST /api/csp/report", () => {
  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    reportOpsEventMock = require("@/lib/ops-events").reportOpsEvent;
    reportOpsEventMock.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    POST = require("../route").POST;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns 204 and writes one ops event for a single legacy csp-report", async () => {
    const response = await POST(buildRequest(legacyReport()));

    expect(response.status).toBe(204);
    expect(reportOpsEventMock).toHaveBeenCalledTimes(1);
    expect(writtenEvents()[0]).toMatchObject({
      source: "csp-report",
      severity: "error",
      title: "CSP enforce: script-src",
      message: "Blocked evil.example on /page",
      route: "/page",
    });
  });

  it("silently 204s on malformed JSON without writing any ops event", async () => {
    const req = new NextRequest(`https://${HOST}/api/csp/report`, {
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
        documentURL: `https://${HOST}/page`,
        effectiveDirective: "script-src",
        disposition: "enforce",
      },
    }));

    const response = await POST(buildRequest(giant));

    expect(response.status).toBe(204);
    expect(reportOpsEventMock).toHaveBeenCalledTimes(16);
  });

  it("drops reports whose document is on another host, and still answers 204", async () => {
    const foreign = await POST(buildRequest(legacyReport({ "document-uri": "https://attacker.example/page" })));
    const missing = await POST(buildRequest(legacyReport({ "document-uri": undefined })));
    const notAUrl = await POST(buildRequest(legacyReport({ "document-uri": "not a url" })));
    const nonWeb = await POST(buildRequest(legacyReport({ "document-uri": "javascript:alert(1)" })));

    expect([foreign.status, missing.status, notAUrl.status, nonWeb.status]).toEqual([204, 204, 204, 204]);
    expect(reportOpsEventMock).not.toHaveBeenCalled();
  });

  it("accepts a report from the request's own host whatever the port", async () => {
    const response = await POST(
      buildRequest(legacyReport({ "document-uri": "http://localhost:3000/dashboard" }), "203.0.113.11", "localhost:3000"),
    );

    expect(response.status).toBe(204);
    expect(reportOpsEventMock).toHaveBeenCalledTimes(1);
  });

  it("stops writing once one address passes its request limit, and keeps answering 204", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      statuses.push((await POST(buildRequest(legacyReport(), "203.0.113.20"))).status);
    }

    expect(new Set(statuses)).toEqual(new Set([204]));
    expect(reportOpsEventMock).toHaveBeenCalledTimes(30);

    // Another address is not held back by the first one.
    await POST(buildRequest(legacyReport(), "203.0.113.21"));
    expect(reportOpsEventMock).toHaveBeenCalledTimes(31);
  });

  it("keeps the same title, message and route when only ids and query strings change", async () => {
    await POST(
      buildRequest(
        legacyReport({
          "blocked-uri": "https://cdn.example/a.js?token=one",
          "document-uri": `https://${HOST}/dashboard/agents/11111111-1111-4111-8111-111111111111?tab=chat#x`,
        }),
        "203.0.113.30",
      ),
    );
    await POST(
      buildRequest(
        legacyReport({
          "blocked-uri": "https://cdn.example/b.js?token=two",
          "document-uri": `https://${HOST}/dashboard/agents/22222222-2222-4222-8222-222222222222?tab=files`,
        }),
        "203.0.113.31",
      ),
    );

    const [first, second] = writtenEvents();
    expect(first.title).toBe(second.title);
    expect(first.message).toBe(second.message);
    expect(first.route).toBe(second.route);
    expect(first.message).toBe("Blocked cdn.example on /dashboard/agents/:id");
  });

  it("keeps query strings and fragments out of the stored metadata", async () => {
    await POST(
      buildRequest(
        legacyReport({
          "blocked-uri": "https://cdn.example/a.js?token=secret-value",
          "document-uri": `https://${HOST}/page?code=abc#frag`,
          "source-file": `https://${HOST}/_next/static/app.js?v=1`,
        }),
      ),
    );

    const metadata = writtenEvents()[0].metadata as Record<string, unknown>;
    expect(metadata.blockedUri).toBe("https://cdn.example/a.js");
    expect(metadata.documentUri).toBe(`https://${HOST}/page`);
    expect(metadata.sourceFile).toBe(`https://${HOST}/_next/static/app.js`);
    expect(JSON.stringify(writtenEvents()[0])).not.toContain("secret-value");
  });

  it("turns 1,000 distinct blocked URLs into a bounded number of rows", async () => {
    // Each request is one report with a blocked host, document path and
    // directive nobody has used before, from an address nobody has used before.
    // That is the worst case the old route allowed: one new row per request.
    let clock = Date.parse("2026-09-30T10:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => clock);

    const directives = ["script-src", "connect-src", "img-src", "frame-src", "made-up-directive"];
    for (let i = 0; i < 1000; i += 1) {
      // Spread the traffic over a few minutes, so the per-minute caps do not
      // hide the distinct-row budget. 100 requests per simulated minute keeps
      // each address and the instance under their per-minute limits.
      clock += 600;
      const response = await POST(
        buildRequest(
          legacyReport({
            "blocked-uri": `https://blocked-${i}.example/payload-${i}.js`,
            "document-uri": `https://${HOST}/p${i}/q${i}/r${i}`,
            "effective-directive": `${directives[i % directives.length]}`,
            "violated-directive": `${directives[i % directives.length]} 'self'`,
            disposition: i % 2 === 0 ? "enforce" : "report",
          }),
          `198.51.100.${(i % 250) + 1}`,
        ),
      );
      expect(response.status).toBe(204);
    }

    const events = writtenEvents();
    const distinctRows = new Set(events.map((event) => JSON.stringify([event.source, event.title, event.message, event.route])));

    // 100 distinct slots per hour plus the one shared overflow row per
    // disposition. The old route produced one row per request (1,000 here).
    expect(distinctRows.size).toBeLessThanOrEqual(102);
    expect(distinctRows.size).toBeGreaterThan(1);
    // The instance cap is 240 events per minute, and this run lasts 10 minutes.
    expect(events.length).toBeLessThanOrEqual(2400);
    // Unknown directives fold into "other" instead of becoming a new title.
    expect(events.some((event) => event.title.includes("made-up-directive"))).toBe(false);
  });

  it("caps events per minute for the whole instance, however many addresses send them", async () => {
    const clock = Date.parse("2026-09-30T11:00:00Z");
    jest.spyOn(Date, "now").mockImplementation(() => clock);

    const statuses: number[] = [];
    for (let i = 0; i < 400; i += 1) {
      statuses.push((await POST(buildRequest(legacyReport(), `192.0.2.${(i % 250) + 1}`))).status);
    }

    expect(new Set(statuses)).toEqual(new Set([204]));
    expect(reportOpsEventMock).toHaveBeenCalledTimes(240);
  });
});
