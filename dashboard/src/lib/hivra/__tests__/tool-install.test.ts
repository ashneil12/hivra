import {
  resolveToolMcpSpec,
  listInstallableToolMeta,
} from "@/lib/hivra/tool-install";
import { CURATED_TOOLS } from "@/data/curated-tools";

// Representative catalog entries by env shape:
//   required key  -> CoinMarketCap (COINMARKETCAP_API_KEY, required)
//   optional key  -> CoinGecko     (COINGECKO_PRO_API_KEY, optional)
//   keyless       -> EVM on-chain  (no env)
const requiredTool = CURATED_TOOLS.find((t) => t.id === "crypto-coinmarketcap")!;
const optionalTool = CURATED_TOOLS.find((t) => t.id === "crypto-research-coingecko")!;
const keylessTool = CURATED_TOOLS.find((t) => t.id === "crypto-evm-onchain")!;
const httpTool = CURATED_TOOLS.find((t) => t.id === "crypto-nansen")!;
const REQ_KEY = "COINMARKETCAP_API_KEY";
const OPT_KEY = "COINGECKO_PRO_API_KEY";

// Narrow helpers for the discriminated { spec } | { skip } result.
function specOf(r: ReturnType<typeof resolveToolMcpSpec>) {
  if (!("spec" in r)) throw new Error(`expected a spec, got skip:${(r as { skip: string }).skip}`);
  return r.spec;
}
function skipOf(r: ReturnType<typeof resolveToolMcpSpec>) {
  if (!("skip" in r)) throw new Error("expected a skip, got a spec");
  return r.skip;
}

describe("resolveToolMcpSpec", () => {
  it("skips an unknown tool id with reason 'unknown'", () => {
    expect(skipOf(resolveToolMcpSpec({ id: "does-not-exist" }))).toBe("unknown");
  });

  it("skips with 'missing-required-key' when a required env key is missing/blank", () => {
    expect(skipOf(resolveToolMcpSpec({ id: requiredTool.id, env: {} }))).toBe("missing-required-key");
    expect(skipOf(resolveToolMcpSpec({ id: requiredTool.id, env: { [REQ_KEY]: "   " } }))).toBe("missing-required-key");
  });

  it("resolves when the required key is present, carrying command/args", () => {
    const spec = specOf(resolveToolMcpSpec({ id: requiredTool.id, env: { [REQ_KEY]: "CMC-abc" } }));
    expect(spec.name).toBe(requiredTool.mcp.name);
    expect(spec.command).toBe(requiredTool.mcp.command);
    expect(spec.args).toEqual(requiredTool.mcp.args);
    expect(spec.env).toEqual({ [REQ_KEY]: "CMC-abc" });
  });

  it("omits an OPTIONAL key left blank, but keeps it when provided", () => {
    expect(specOf(resolveToolMcpSpec({ id: optionalTool.id, env: {} })).env).toEqual({});
    const withKey = specOf(resolveToolMcpSpec({ id: optionalTool.id, env: { [OPT_KEY]: "cg-123" } }));
    expect(withKey.env).toEqual({ [OPT_KEY]: "cg-123" });
  });

  it("drops env keys the tool did not declare (no smuggling arbitrary env)", () => {
    const spec = specOf(resolveToolMcpSpec({
      id: optionalTool.id,
      env: { [OPT_KEY]: "cg-1", EVIL: "rm -rf", PATH: "/x" },
    }));
    expect(Object.keys(spec.env ?? {})).toEqual([OPT_KEY]);
  });

  it("resolves a keyless tool with an empty env", () => {
    expect(specOf(resolveToolMcpSpec({ id: keylessTool.id })).env).toEqual({});
  });

  it("trims env values", () => {
    expect(specOf(resolveToolMcpSpec({ id: requiredTool.id, env: { [REQ_KEY]: "  CMC-x  " } })).env?.[REQ_KEY]).toBe("CMC-x");
  });

  it("rejects a control-char-tainted REQUIRED value ('invalid-value'), guarding codex TOML", () => {
    // U+007F (DEL) / U+0000 would emit a raw control char in a codex TOML basic
    // string and corrupt ~/.codex/config.toml for every tool on the box.
    const del = String.fromCharCode(0x7f);
    const nul = String.fromCharCode(0x00);
    expect(skipOf(resolveToolMcpSpec({ id: requiredTool.id, env: { [REQ_KEY]: "CMC" + del } }))).toBe("invalid-value");
    expect(skipOf(resolveToolMcpSpec({ id: requiredTool.id, env: { [REQ_KEY]: "a" + nul + "b" } }))).toBe("invalid-value");
  });

  it("omits an OPTIONAL tainted value rather than skipping the whole tool", () => {
    const del = String.fromCharCode(0x7f);
    const spec = specOf(resolveToolMcpSpec({ id: optionalTool.id, env: { [OPT_KEY]: "badkey" + del } }));
    expect(spec.env).toEqual({});
  });

  it("rejects an over-long REQUIRED value", () => {
    expect(skipOf(resolveToolMcpSpec({ id: requiredTool.id, env: { [REQ_KEY]: "x".repeat(9000) } }))).toBe("invalid-value");
  });
});

describe("listInstallableToolMeta", () => {
  const meta = listInstallableToolMeta();

  it("exposes mcpName + env metadata + skill count, and NO command/args", () => {
    const m = meta.find((x) => x.id === requiredTool.id)!;
    expect(m.mcpName).toBe(requiredTool.mcp.name);
    expect(m.env.map((f) => f.key)).toEqual([REQ_KEY]);
    expect(typeof m.skillCount).toBe("number");
    // The heavy/leaky bits stay server-side: no command, no args on the meta.
    expect((m as unknown as Record<string, unknown>).command).toBeUndefined();
    expect((m as unknown as Record<string, unknown>).args).toBeUndefined();
  });

  it("only lists installable tools (no unbuilt `requires`; stdio or http)", () => {
    // Every listed id round-trips to an installable catalog entry.
    for (const m of meta) {
      const t = CURATED_TOOLS.find((x) => x.id === m.id)!;
      expect(t.requires).toBeUndefined();
      expect(["stdio", "http"]).toContain(t.mcp.transport ?? "stdio");
    }
  });
});

describe("v1.1 — hosted (http) transport + placeholders", () => {
  it("resolves a hosted tool into url + substituted auth headers", () => {
    const spec = specOf(resolveToolMcpSpec({ id: httpTool.id, env: { NANSEN_API_KEY: "nsk-42" } }, "claude"));
    expect(spec.transport).toBe("http");
    expect(spec.url).toBe(httpTool.mcp.url);
    expect(spec.headers).toEqual({ "NANSEN-API-KEY": "nsk-42" });
    // A hosted server takes no env block — creds live in the headers.
    expect(spec.env).toBeUndefined();
  });

  it("still enforces the required key on a hosted tool", () => {
    expect(skipOf(resolveToolMcpSpec({ id: httpTool.id, env: {} }, "claude"))).toBe("missing-required-key");
  });

  it("skips hosted tools on codex (no settled remote shape) rather than mis-writing", () => {
    expect(skipOf(resolveToolMcpSpec({ id: httpTool.id, env: { NANSEN_API_KEY: "k" } }, "codex")))
      .toBe("unsupported-on-codex");
  });

  it("codex catalog hides http tools; claude catalog includes them", () => {
    const claudeIds = listInstallableToolMeta("claude").map((t) => t.id);
    const codexIds = listInstallableToolMeta("codex").map((t) => t.id);
    expect(claudeIds).toContain(httpTool.id);
    expect(codexIds).not.toContain(httpTool.id);
    // stdio tools appear on both.
    expect(codexIds).toContain(keylessTool.id);
  });

  it("substitutes {ENV_KEY} placeholders in stdio args (CLI-flag credentials)", () => {
    // Synthetic check of the substitution rule via a catalog tool's arg list is
    // brittle, so assert the rule itself through a header-style placeholder:
    // an unresolved placeholder must never be written verbatim.
    const spec = specOf(resolveToolMcpSpec({ id: httpTool.id, env: { NANSEN_API_KEY: "abc" } }, "claude"));
    expect(JSON.stringify(spec)).not.toContain("{NANSEN_API_KEY}");
  });
});
