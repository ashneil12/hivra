/**
 * @jest-environment node
 */
import {
  GSC_SITES,
  buildJwtParts,
  parseIndexStatus,
  parseServiceAccountKey,
} from "../gsc-client";

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

describe("buildJwtParts", () => {
  const NOW_SECONDS = 1_752_500_000;
  const CLIENT_EMAIL = "seo-bot@example-project.iam.gserviceaccount.com";

  it("builds an RS256 JWT header", () => {
    const { header } = buildJwtParts(CLIENT_EMAIL, NOW_SECONDS);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("builds the service-account claim set with the webmasters scope", () => {
    const { claims } = buildJwtParts(CLIENT_EMAIL, NOW_SECONDS);
    expect(claims).toEqual({
      iss: CLIENT_EMAIL,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 3600,
    });
  });

  it("produces a signing input of exactly two base64url segments that round-trip", () => {
    const { header, claims, signingInput } = buildJwtParts(CLIENT_EMAIL, NOW_SECONDS);
    const segments = signingInput.split(".");

    expect(segments).toHaveLength(2);
    // base64url alphabet only — no padding, no +/ characters.
    for (const segment of segments) {
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(decodeBase64UrlJson(segments[0])).toEqual(header);
    expect(decodeBase64UrlJson(segments[1])).toEqual(claims);
  });
});

describe("parseServiceAccountKey", () => {
  it("extracts client_email and private_key", () => {
    const parsed = parseServiceAccountKey(
      JSON.stringify({
        type: "service_account",
        client_email: "seo-bot@example-project.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      }),
    );
    expect(parsed.client_email).toBe("seo-bot@example-project.iam.gserviceaccount.com");
    expect(parsed.private_key).toContain("BEGIN PRIVATE KEY");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseServiceAccountKey("not-json")).toThrow(/not valid JSON/);
  });

  it("throws when required fields are missing", () => {
    expect(() => parseServiceAccountKey(JSON.stringify({ client_email: "x@y.z" }))).toThrow(
      /missing client_email or private_key/,
    );
  });
});

describe("GSC_SITES", () => {
  it("targets both sc-domain properties", () => {
    expect(GSC_SITES).toEqual(["sc-domain:hivra.cloud", "sc-domain:hermesos.cloud"]);
  });
});

describe("parseIndexStatus", () => {
  it("extracts every index status field from a full inspection response", () => {
    const status = parseIndexStatus({
      inspectionResult: {
        indexStatusResult: {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
          robotsTxtState: "ALLOWED",
          indexingState: "INDEXING_ALLOWED",
          pageFetchState: "SUCCESSFUL",
          googleCanonical: "https://hivra.cloud/blog/x",
          userCanonical: "https://hivra.cloud/blog/x",
          lastCrawlTime: "2026-07-20T10:00:00Z",
        },
      },
    });

    expect(status).toEqual({
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      robotsTxtState: "ALLOWED",
      indexingState: "INDEXING_ALLOWED",
      pageFetchState: "SUCCESSFUL",
      googleCanonical: "https://hivra.cloud/blog/x",
      userCanonical: "https://hivra.cloud/blog/x",
      lastCrawlTime: "2026-07-20T10:00:00Z",
    });
  });

  it("nulls the fields an unindexed URL omits instead of inventing them", () => {
    // Real shape for a discovered-but-uncrawled URL: no lastCrawlTime, no
    // googleCanonical. Those must not come back as undefined or "".
    const status = parseIndexStatus({
      inspectionResult: {
        indexStatusResult: {
          verdict: "FAIL",
          coverageState: "Discovered - currently not indexed",
          robotsTxtState: "ALLOWED",
        },
      },
    });

    expect(status.verdict).toBe("FAIL");
    expect(status.coverageState).toBe("Discovered - currently not indexed");
    expect(status.lastCrawlTime).toBeNull();
    expect(status.googleCanonical).toBeNull();
    expect(status.userCanonical).toBeNull();
    expect(status.pageFetchState).toBeNull();
  });

  it("returns all-null rather than throwing on malformed or empty payloads", () => {
    const allNull = {
      verdict: null,
      coverageState: null,
      robotsTxtState: null,
      indexingState: null,
      pageFetchState: null,
      googleCanonical: null,
      userCanonical: null,
      lastCrawlTime: null,
    };

    expect(parseIndexStatus(null)).toEqual(allNull);
    expect(parseIndexStatus({})).toEqual(allNull);
    expect(parseIndexStatus({ inspectionResult: {} })).toEqual(allNull);
    expect(parseIndexStatus("nonsense")).toEqual(allNull);
  });

  it("ignores wrong-typed fields so a bad row can never be written", () => {
    const status = parseIndexStatus({
      inspectionResult: { indexStatusResult: { verdict: 42, coverageState: "" } },
    });

    expect(status.verdict).toBeNull();
    expect(status.coverageState).toBeNull();
  });
});
