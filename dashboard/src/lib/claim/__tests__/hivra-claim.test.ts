import {
  NO_CLAIM,
  claimHrefOf,
  formatUtcInstant,
  readSablierCampaignUrl,
  readUtcInstant,
  resolveHivraClaim,
} from "../hivra-claim";

const CAMPAIGN = "https://app.sablier.com/airdrops/campaign/0xabc123/";
const OPENS = "2026-11-01T16:00:00Z";
const CLOSES = "2026-12-01T16:00:00Z";
const NOW = new Date("2026-11-10T12:00:00Z");

describe("readSablierCampaignUrl", () => {
  it.each([
    [CAMPAIGN, CAMPAIGN],
    ["https://app.sablier.com/airdrops/campaign/0xabc123/?c=base-8453", "https://app.sablier.com/airdrops/campaign/0xabc123/?c=base-8453"],
    ["https://APP.SABLIER.COM/x", "https://app.sablier.com/x"],
    ["https://app.sablier.com", "https://app.sablier.com/"],
    ["https://app.sablier.com/a/b.c/d-e_f~g", "https://app.sablier.com/a/b.c/d-e_f~g"],
  ])("accepts %s", (input, expected) => {
    expect(readSablierCampaignUrl(input)).toBe(expected);
  });

  it.each([
    ["http, not https", "http://app.sablier.com/x"],
    ["another scheme", "javascript:alert(1)"],
    ["no scheme", "app.sablier.com/x"],
    ["a different host", "https://sablier.com/x"],
    ["a subdomain of the host", "https://evil.app.sablier.com/x"],
    ["the host as a prefix of another", "https://app.sablier.com.evil.example/x"],
    ["the host as a path on another", "https://evil.example/app.sablier.com/x"],
    ["another host after userinfo", "https://app.sablier.com@evil.example/x"],
    ["credentials", "https://user:pass@app.sablier.com/x"],
    ["a port", "https://app.sablier.com:8443/x"],
    ["the default port written out", "https://app.sablier.com:443/x"],
    ["a trailing dot on the host", "https://app.sablier.com./x"],
    ["a fragment", "https://app.sablier.com/x#evil"],
    ["an empty fragment", "https://app.sablier.com/x#"],
    ["a backslash", "https://app.sablier.com\\@evil.example/x"],
    ["a backslash in the path", "https://app.sablier.com/x\\..\\y"],
    ["a dot segment", "https://app.sablier.com/a/../b"],
    ["a trailing dot segment", "https://app.sablier.com/a/.."],
    ["a current-directory segment", "https://app.sablier.com/a/./b"],
    ["an encoded dot segment", "https://app.sablier.com/a/%2e%2e/b"],
    ["an encoded slash", "https://app.sablier.com/a%2fb"],
    ["an encoded backslash", "https://app.sablier.com/a%5cb"],
    ["any percent-encoding", "https://app.sablier.com/a%20b"],
    ["whitespace", "https://app.sablier.com/a b"],
    ["leading whitespace", " https://app.sablier.com/x"],
    ["a newline", "https://app.sablier.com/x\nhttps://evil.example"],
    ["a non-ASCII lookalike", "https://app.sablier.com/ａ"],
    ["a lookalike host", "https://app.sablіer.com/x"],
    ["an empty string", ""],
  ])("rejects %s", (_why, input) => {
    expect(readSablierCampaignUrl(input)).toBeNull();
  });

  it("rejects what is not a string, and an over-long link", () => {
    expect(readSablierCampaignUrl(null)).toBeNull();
    expect(readSablierCampaignUrl(undefined)).toBeNull();
    expect(readSablierCampaignUrl(`https://app.sablier.com/${"a".repeat(2100)}`)).toBeNull();
  });
});

describe("readUtcInstant", () => {
  it("reads a real UTC instant to the second", () => {
    expect(readUtcInstant("2026-10-21T16:00:00Z")).toBe(Date.parse("2026-10-21T16:00:00Z"));
  });

  it.each(["2026-10-21", "2026-10-21 16:00:00", "2026-10-21T16:00:00", "2026-10-21T16:00:00.000Z", "2026-10-21T16:00:00+01:00", "2026-02-30T16:00:00Z", "2026-10-21T25:00:00Z", ""])(
    "rejects %s",
    (input) => {
      expect(readUtcInstant(input)).toBeNull();
    },
  );
});

describe("resolveHivraClaim", () => {
  const resolve = (claim: Parameters<typeof resolveHivraClaim>[0], now = NOW) => resolveHivraClaim(claim, now);

  it("is unpublished with nothing set (the committed default), and for a missing config", () => {
    expect(resolve({ campaignUrl: null, opensAt: null, closesAt: null })).toEqual({ claim: NO_CLAIM, problems: [] });
    expect(resolve(undefined)).toEqual({ claim: NO_CLAIM, problems: [] });
    expect(resolve(null)).toEqual({ claim: NO_CLAIM, problems: [] });
  });

  it("is unpublished without a campaign link, whatever the window says", () => {
    expect(resolve({ campaignUrl: null, opensAt: OPENS, closesAt: CLOSES })).toEqual({ claim: NO_CLAIM, problems: [] });
  });

  it("is open from the opening instant up to, but not including, the closing instant", () => {
    const claim = { campaignUrl: CAMPAIGN, opensAt: OPENS, closesAt: CLOSES };
    expect(resolve(claim, new Date("2026-10-31T23:59:59Z")).claim.phase).toBe("not_open");
    expect(resolve(claim, new Date("2026-11-01T15:59:59Z")).claim.phase).toBe("not_open");
    expect(resolve(claim, new Date(OPENS)).claim.phase).toBe("open");
    expect(resolve(claim, NOW).claim).toEqual({
      phase: "open",
      campaignUrl: CAMPAIGN,
      opensAt: "2026-11-01T16:00:00.000Z",
      closesAt: "2026-12-01T16:00:00.000Z",
    });
    expect(resolve(claim, new Date("2026-12-01T15:59:59Z")).claim.phase).toBe("open");
    expect(resolve(claim, new Date(CLOSES)).claim.phase).toBe("closed");
    expect(resolve(claim, new Date("2027-01-01T00:00:00Z")).claim.phase).toBe("closed");
  });

  it("treats a missing opensAt or closesAt as no limit on that side", () => {
    expect(resolve({ campaignUrl: CAMPAIGN, opensAt: null, closesAt: null }).claim.phase).toBe("open");
    expect(resolve({ campaignUrl: CAMPAIGN, opensAt: null, closesAt: CLOSES }).claim.phase).toBe("open");
    expect(resolve({ campaignUrl: CAMPAIGN, opensAt: null, closesAt: CLOSES }, new Date("2026-12-02T00:00:00Z")).claim.phase).toBe("closed");
    expect(resolve({ campaignUrl: CAMPAIGN, opensAt: "2026-12-01T16:00:00Z", closesAt: null }).claim.phase).toBe("not_open");
  });

  it.each([
    ["an http link", { campaignUrl: "http://app.sablier.com/x", opensAt: OPENS, closesAt: CLOSES }, ["claim.campaignUrl must be a plain https link on app.sablier.com"]],
    ["a lookalike host", { campaignUrl: "https://app-sablier.com/x", opensAt: OPENS, closesAt: CLOSES }, ["claim.campaignUrl must be a plain https link on app.sablier.com"]],
    ["a malformed opensAt", { campaignUrl: CAMPAIGN, opensAt: "2026-11-01", closesAt: CLOSES }, ["claim.opensAt must be a real UTC instant to the second, e.g. 2026-10-21T16:00:00Z"]],
    ["a malformed closesAt", { campaignUrl: CAMPAIGN, opensAt: OPENS, closesAt: "soon" }, ["claim.closesAt must be a real UTC instant to the second, e.g. 2026-10-21T16:00:00Z"]],
    ["a window that closes before it opens", { campaignUrl: CAMPAIGN, opensAt: CLOSES, closesAt: OPENS }, ["claim.opensAt must be before claim.closesAt"]],
    ["a window that opens and closes at once", { campaignUrl: CAMPAIGN, opensAt: OPENS, closesAt: OPENS }, ["claim.opensAt must be before claim.closesAt"]],
  ])("reports %s and keeps the whole claim hidden", (_why, claim, problems) => {
    // A bad opensAt must not open the claim early, and a bad closesAt must not leave it open for ever.
    expect(resolve(claim)).toEqual({ claim: NO_CLAIM, problems });
    expect(claimHrefOf(resolve(claim).claim)).toBeNull();
  });
});

describe("claimHrefOf", () => {
  it("gives the link only while open", () => {
    const claim = { campaignUrl: CAMPAIGN, opensAt: OPENS, closesAt: CLOSES };
    expect(claimHrefOf(resolveHivraClaim(claim, NOW).claim)).toBe(CAMPAIGN);
    expect(claimHrefOf(resolveHivraClaim(claim, new Date("2026-10-01T00:00:00Z")).claim)).toBeNull();
    expect(claimHrefOf(resolveHivraClaim(claim, new Date("2027-01-01T00:00:00Z")).claim)).toBeNull();
    expect(claimHrefOf(NO_CLAIM)).toBeNull();
    expect(claimHrefOf(null)).toBeNull();
    expect(claimHrefOf(undefined)).toBeNull();
  });
});

describe("formatUtcInstant", () => {
  it("writes the instant in UTC", () => {
    expect(formatUtcInstant("2026-11-01T16:00:00.000Z")).toMatch(/^1 November 2026.*16:00 UTC$/);
  });
});
