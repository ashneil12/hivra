import { normalizeCatalog } from "@/lib/composio/catalog";

describe("normalizeCatalog", () => {
  it("sorts surfaced/popular apps first, then the rest A–Z, and dedupes categories", () => {
    const { apps, categories } = normalizeCatalog([
      { slug: "zapp", name: "Zapp", category: "misc", toolCount: 1 },
      { slug: "gmail", name: "Gmail", category: "email", toolCount: 63, logo: "custom-logo" },
      { slug: "aardvark", name: "Aardvark", category: "misc", toolCount: 2 },
    ]);
    // gmail is in the curated popular set → floats to the front; the rest A–Z.
    expect(apps.map((a) => a.slug)).toEqual(["gmail", "aardvark", "zapp"]);
    expect(categories).toEqual(["email", "misc"]);
  });

  it("keeps a provided logo and falls back to the logos endpoint otherwise", () => {
    const { apps } = normalizeCatalog([
      { slug: "gmail", name: "Gmail", category: "email", logo: "custom-logo" },
      { slug: "aardvark", name: "Aardvark", category: "misc" },
    ]);
    expect(apps.find((a) => a.slug === "gmail")?.logo).toBe("custom-logo");
    expect(apps.find((a) => a.slug === "aardvark")?.logo).toContain(
      "logos.composio.dev/api/aardvark",
    );
  });

  it("skips entries missing a slug or name, and lowercases slugs", () => {
    const { apps } = normalizeCatalog([
      { slug: "x" }, // no name
      { name: "y" }, // no slug
      { slug: "OK", name: "Okay" },
    ]);
    expect(apps.map((a) => a.slug)).toEqual(["ok"]);
  });

  it("returns an empty catalog for non-array input", () => {
    expect(normalizeCatalog(null)).toEqual({ apps: [], categories: [] });
    expect(normalizeCatalog({})).toEqual({ apps: [], categories: [] });
    expect(normalizeCatalog(undefined)).toEqual({ apps: [], categories: [] });
  });

  it("defaults a missing category to 'other' and a missing toolCount to 0", () => {
    const { apps } = normalizeCatalog([{ slug: "foo", name: "Foo" }]);
    expect(apps[0].category).toBe("other");
    expect(apps[0].toolCount).toBe(0);
  });
});

describe("getComposioCatalog failure backoff", () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const FIVE_MINUTES_MS = 5 * 60 * 1000;

  afterEach(() => {
    global.fetch = originalFetch;
    Date.now = originalNow;
    jest.resetModules();
  });

  it("does not refetch the upstream while a failed refresh is backing off, then retries", async () => {
    let now = 1_700_000_000_000;
    Date.now = () => now;
    const fetchMock = jest.fn().mockRejectedValue(new Error("network down"));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { getComposioCatalog } = await import("@/lib/composio/catalog");

    const first = await getComposioCatalog();
    const second = await getComposioCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first.apps.length).toBeGreaterThan(0);

    now += FIVE_MINUTES_MS + 1;
    await getComposioCatalog();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
