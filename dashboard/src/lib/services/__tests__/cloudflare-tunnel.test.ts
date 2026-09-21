import { boxHostname } from "../cloudflare-tunnel";

// Cloudflare Universal SSL serves an edge cert for `<zone>` and `*.<zone>` ONLY —
// one label deep. A box hostname any deeper has no edge cert, so the browser can't
// TLS-handshake it and every fetch dies with "Failed to fetch" (the real-world bug
// these cases lock down). boxHostname() must therefore ALWAYS return a name exactly
// one label under the zone apex.
describe("boxHostname — pins hostnames one label under the zone apex", () => {
  const apex = "hermesos.cloud";

  it("uses the zone apex directly when domain === apex", () => {
    expect(boxHostname("box-abc123", apex, apex)).toBe("box-abc123.hermesos.cloud");
  });

  it("uses the zone apex when no domain is configured", () => {
    expect(boxHostname("box-abc123", apex)).toBe("box-abc123.hermesos.cloud");
    expect(boxHostname("box-abc123", apex, null)).toBe("box-abc123.hermesos.cloud");
    expect(boxHostname("box-abc123", apex, "")).toBe("box-abc123.hermesos.cloud");
  });

  it("folds deeper domain labels into the slug instead of nesting them as DNS labels (the bug)", () => {
    // The exact misconfig that broke prod: a 3-level domain would have produced
    // box-abc123.agents.canary.hermesos.cloud (no edge cert). It must collapse to
    // a single label under the apex.
    expect(boxHostname("box-abc123", apex, "agents.canary.hermesos.cloud")).toBe(
      "agents-canary-box-abc123.hermesos.cloud",
    );
    expect(boxHostname("box-abc123", apex, "agents.hermesos.cloud")).toBe(
      "agents-box-abc123.hermesos.cloud",
    );
  });

  it("always yields a hostname exactly one label under the apex", () => {
    for (const dom of [apex, "a.hermesos.cloud", "a.b.c.hermesos.cloud", "x.y.hermesos.cloud"]) {
      const host = boxHostname("box-1", apex, dom);
      expect(host.endsWith("." + apex)).toBe(true);
      const labelsUnderApex = host.slice(0, -(apex.length + 1)).split(".");
      expect(labelsUnderApex).toHaveLength(1);
    }
  });

  it("ignores a configured domain that isn't under the zone apex (falls back to apex)", () => {
    expect(boxHostname("box-abc123", apex, "example.com")).toBe("box-abc123.hermesos.cloud");
    expect(boxHostname("box-abc123", apex, "agents.other.net")).toBe("box-abc123.hermesos.cloud");
  });

  it("tolerates leading/trailing dots and case in the apex and domain", () => {
    expect(boxHostname("Box-ABC", "Hermesos.Cloud", ".Agents.Hermesos.Cloud.")).toBe(
      "agents-box-abc.hermesos.cloud",
    );
  });

  it("sanitizes the slug and never emits an empty label", () => {
    expect(boxHostname("", apex)).toBe("box.hermesos.cloud");
    expect(boxHostname("--weird__slug--", apex)).toBe("weird-slug.hermesos.cloud");
  });

  it("keeps the leftmost label within the 63-char DNS limit", () => {
    const host = boxHostname("box-" + "a".repeat(80), apex, "agents.canary.hermesos.cloud");
    const label = host.slice(0, host.indexOf("."));
    expect(label.length).toBeLessThanOrEqual(63);
    expect(host.endsWith(".hermesos.cloud")).toBe(true);
  });
});
