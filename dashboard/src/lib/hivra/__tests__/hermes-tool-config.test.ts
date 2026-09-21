import {
  buildHermesConfigWithTools,
  readInstalledHermesToolNames,
  isHivraManagedServerName,
  hivraServerNameFor,
} from "@/lib/hivra/hermes-tool-config";

const hosted = { name: "nansen", url: "https://mcp.nansen.ai/ra/mcp", headers: { "NANSEN-API-KEY": "k1" } };
const local = { name: "scrapling", command: "uvx", args: ["scrapling-fetch-mcp"], env: { A: "b" } };

describe("buildHermesConfigWithTools", () => {
  it("PRESERVES the config when entries is undefined (general writers must not drop tools)", () => {
    const cfg = { model: "x", mcp_servers: { hivra_scrapling: { command: "uvx" }, composio: { url: "u" } } };
    expect(buildHermesConfigWithTools({ config: cfg })).toBe(cfg);
  });

  it("writes a hosted tool as {url,headers} under a hivra_ prefix", () => {
    const out = buildHermesConfigWithTools({ config: {}, entries: [hosted] });
    expect((out.mcp_servers as Record<string, unknown>).hivra_nansen).toEqual({
      url: hosted.url,
      headers: hosted.headers,
    });
  });

  it("writes a local tool as {command,args,env}", () => {
    const out = buildHermesConfigWithTools({ config: {}, entries: [local] });
    expect((out.mcp_servers as Record<string, unknown>).hivra_scrapling).toEqual({
      command: "uvx",
      args: ["scrapling-fetch-mcp"],
      env: { A: "b" },
    });
  });

  it("NEVER touches the composio entry or user-authored servers", () => {
    const cfg = {
      mcp_servers: {
        composio: { url: "https://connect.composio.dev/mcp", headers: { "X-CONSUMER-API-KEY": "ck" } },
        my_own: { command: "node", args: ["x.js"] },
        hivra_old: { command: "gone" },
      },
    };
    const out = buildHermesConfigWithTools({ config: cfg, entries: [hosted] });
    const s = out.mcp_servers as Record<string, unknown>;
    expect(s.composio).toEqual(cfg.mcp_servers.composio);
    expect(s.my_own).toEqual(cfg.mcp_servers.my_own);
    expect(s.hivra_old).toBeUndefined(); // ours, replaced
    expect(s.hivra_nansen).toBeDefined();
  });

  it("entries: [] strips ALL hivra entries but keeps everything else", () => {
    const cfg = {
      model: "keep",
      mcp_servers: { hivra_a: { command: "a" }, hivra_b: { url: "u" }, composio: { url: "c" } },
    };
    const out = buildHermesConfigWithTools({ config: cfg, entries: [] });
    expect(out.model).toBe("keep");
    expect(out.mcp_servers).toEqual({ composio: { url: "c" } });
  });

  it("drops mcp_servers entirely when the map ends up empty", () => {
    const cfg = { model: "m", mcp_servers: { hivra_a: { command: "a" } } };
    const out = buildHermesConfigWithTools({ config: cfg, entries: [] });
    expect("mcp_servers" in out).toBe(false);
    expect(out.model).toBe("m");
  });

  it("raises the discovery timeout for a hosted tool (upward only)", () => {
    const out = buildHermesConfigWithTools({ config: {}, entries: [hosted] });
    expect(typeof out.mcp_discovery_timeout).toBe("number");
    expect(out.mcp_discovery_timeout as number).toBeGreaterThanOrEqual(15);

    // Already-higher value is preserved, not lowered.
    const hi = buildHermesConfigWithTools({ config: { mcp_discovery_timeout: 60 }, entries: [hosted] });
    expect(hi.mcp_discovery_timeout).toBe(60);
  });

  it("does not raise the discovery timeout for local-only tools", () => {
    const out = buildHermesConfigWithTools({ config: {}, entries: [local] });
    expect(out.mcp_discovery_timeout).toBeUndefined();
  });

  it("is idempotent — re-applying the same entries yields the same config", () => {
    const a = buildHermesConfigWithTools({ config: {}, entries: [hosted, local] });
    const b = buildHermesConfigWithTools({ config: a, entries: [hosted, local] });
    expect(b.mcp_servers).toEqual(a.mcp_servers);
  });

  it("tolerates a malformed mcp_servers value instead of throwing", () => {
    for (const bad of [null, "nope", 42, ["a"]]) {
      const out = buildHermesConfigWithTools({ config: { mcp_servers: bad }, entries: [local] });
      expect((out.mcp_servers as Record<string, unknown>).hivra_scrapling).toBeDefined();
    }
  });
});

describe("name helpers + readback", () => {
  it("prefixes and detects managed names", () => {
    expect(hivraServerNameFor("x")).toBe("hivra_x");
    expect(isHivraManagedServerName("hivra_x")).toBe(true);
    expect(isHivraManagedServerName("composio")).toBe(false);
  });

  it("reads back installed bare tool names, ignoring foreign servers", () => {
    const cfg = { mcp_servers: { hivra_nansen: {}, hivra_scrapling: {}, composio: {}, mine: {} } };
    expect(readInstalledHermesToolNames(cfg).sort()).toEqual(["nansen", "scrapling"]);
  });

  it("returns [] for a config with no/!object mcp_servers", () => {
    expect(readInstalledHermesToolNames({})).toEqual([]);
    expect(readInstalledHermesToolNames({ mcp_servers: "x" })).toEqual([]);
  });
});
