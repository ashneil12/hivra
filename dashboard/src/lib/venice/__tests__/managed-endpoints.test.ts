import {
  getDashboardOrigin,
  getManagedVeniceProxyBaseUrl,
} from "@/lib/venice/managed-endpoints";

describe("getManagedVeniceProxyBaseUrl", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
  });

  it("defaults to the current hivra.cloud apex when the env is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(getManagedVeniceProxyBaseUrl()).toBe(
      "https://hivra.cloud/api/managed-venice/v1"
    );
  });

  it("derives the proxy URL from the configured apex", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://hivra.cloud";
    expect(getManagedVeniceProxyBaseUrl()).toBe(
      "https://hivra.cloud/api/managed-venice/v1"
    );
  });

  // The regression guard for the Jun-2026 managed-Venice cliff. The function must read
  // NEXT_PUBLIC_APP_URL at RUNTIME, not via Next's build-time inlining of
  // `process.env.NEXT_PUBLIC_*`. If it were inlined/frozen, a corrected env var would not
  // change the baked proxy URL and webui boxes would keep posting to the dead legacy apex.
  // Mutating process.env after import and seeing the change proves the read is dynamic.
  it("reflects a runtime change to NEXT_PUBLIC_APP_URL (not build-time frozen)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://example-apex.test";
    expect(getManagedVeniceProxyBaseUrl()).toBe(
      "https://example-apex.test/api/managed-venice/v1"
    );
    // And changing it again on the next call is reflected too — no frozen value.
    process.env.NEXT_PUBLIC_APP_URL = "https://another-apex.test";
    expect(getManagedVeniceProxyBaseUrl()).toBe(
      "https://another-apex.test/api/managed-venice/v1"
    );
  });

  it("never re-bakes the legacy hermesos.cloud apex from the default path", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(getManagedVeniceProxyBaseUrl()).not.toContain("hermesos.cloud");
  });

  it("normalizes trailing slashes and honors an explicit override", () => {
    expect(getManagedVeniceProxyBaseUrl("https://hivra.cloud/")).toBe(
      "https://hivra.cloud/api/managed-venice/v1"
    );
  });
});

describe("getDashboardOrigin", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
  });

  // getDashboardOrigin backs the user-facing managed-Venice top-up links (the
  // URL embedded in 402 "insufficient balance" / spend-cap errors). It must
  // resolve to the CURRENT apex, never the legacy hermesos.cloud frozen into the
  // build — see the getManagedVeniceProxyBaseUrl guards above for the incident.
  it("defaults to the current hivra.cloud apex when the env is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(getDashboardOrigin()).toBe("https://hivra.cloud");
  });

  it("never re-bakes the legacy hermesos.cloud apex from the default path", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(getDashboardOrigin()).not.toContain("hermesos.cloud");
  });

  // Mutating process.env after import and seeing the change proves the read is a
  // runtime computed-key read, not Next's build-time inline of process.env.NEXT_PUBLIC_*.
  it("reflects a runtime change to NEXT_PUBLIC_APP_URL (not build-time frozen)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://example-apex.test";
    expect(getDashboardOrigin()).toBe("https://example-apex.test");
    process.env.NEXT_PUBLIC_APP_URL = "https://another-apex.test";
    expect(getDashboardOrigin()).toBe("https://another-apex.test");
  });

  it("trims trailing slashes and honors an explicit override", () => {
    expect(getDashboardOrigin("https://hivra.cloud/")).toBe("https://hivra.cloud");
  });
});
