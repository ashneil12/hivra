import crypto from "node:crypto";

import { isHivraMemoryEnabled } from "../flag";
import { MEMORY_INSTRUCTIONS, MEMORY_KEY_PLACEHOLDER, memoryMcpUrl, memorySetupOptions } from "../setup";
import { isAllowedMemoryRoute, memorySignatureHeaders, memorySignedMessage } from "../signing";

describe("Hivra Memory flag", () => {
  it("is off unless set to 1 or true", () => {
    expect(isHivraMemoryEnabled(undefined)).toBe(false);
    expect(isHivraMemoryEnabled("")).toBe(false);
    expect(isHivraMemoryEnabled("0")).toBe(false);
    expect(isHivraMemoryEnabled("1")).toBe(true);
    expect(isHivraMemoryEnabled(" TRUE ")).toBe(true);
  });
});

describe("memory worker signing", () => {
  it("signs method, path, account, time and the body hash like the Worker expects", () => {
    const secret = "s".repeat(40);
    const body = JSON.stringify({ label: "Laptop" });
    const headers = memorySignatureHeaders(secret, "post", "/admin/keys", "user_abc", body, 1_700_000_000_000);
    expect(headers["x-hivra-account"]).toBe("user_abc");
    expect(headers["x-hivra-timestamp"]).toBe("1700000000");
    const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
    const expected = crypto.createHmac("sha256", secret).update(`memory|v1|POST|/admin/keys|user_abc|1700000000|${bodyHash}`).digest("hex");
    expect(headers["x-hivra-signature"]).toBe(expected);
    expect(memorySignedMessage("get", "/admin/stats", "user_abc", "1", "")).toBe(
      `memory|v1|GET|/admin/stats|user_abc|1|${crypto.createHash("sha256").update("").digest("hex")}`,
    );
  });

  it("allows only the owner routes", () => {
    expect(isAllowedMemoryRoute("GET", "/admin/keys")).toBe(true);
    expect(isAllowedMemoryRoute("post", "/admin/keys")).toBe(true);
    expect(isAllowedMemoryRoute("DELETE", "/admin/keys")).toBe(true);
    expect(isAllowedMemoryRoute("GET", "/admin/stats")).toBe(true);
    expect(isAllowedMemoryRoute("DELETE", "/admin/account")).toBe(true);
    expect(isAllowedMemoryRoute("POST", "/admin/stats")).toBe(false);
    expect(isAllowedMemoryRoute("GET", "/admin/keys/../account")).toBe(false);
    expect(isAllowedMemoryRoute("POST", "/v1/remember")).toBe(false);
    expect(isAllowedMemoryRoute("GET", "/mcp")).toBe(false);
  });
});

describe("memory setup text", () => {
  const key = ["hm", "abc.def.rw.0123"].join("_");

  it("builds the MCP address without doubled slashes", () => {
    expect(memoryMcpUrl("https://memory.example.com/")).toBe("https://memory.example.com/mcp");
  });

  it("fills the key into every option, or a placeholder when there is none", () => {
    const filled = memorySetupOptions("https://memory.example.com", key);
    expect(filled.map((option) => option.id)).toEqual(["claude-code", "codex", "json", "http"]);
    for (const option of filled) {
      expect(option.code).toContain(key);
      expect(option.code).toContain("https://memory.example.com/");
    }
    expect(filled[0].code).toBe(
      `claude mcp add --transport http --scope user memory https://memory.example.com/mcp --header "Authorization: Bearer ${key}"`,
    );
    expect(JSON.parse(filled[2].code).mcpServers.memory.url).toBe("https://memory.example.com/mcp");
    for (const option of memorySetupOptions("https://memory.example.com")) expect(option.code).toContain(MEMORY_KEY_PLACEHOLDER);
  });

  it("tells the agent to wake first and to name what it replaces", () => {
    expect(MEMORY_INSTRUCTIONS).toContain("call `wake` before any other tool");
    expect(MEMORY_INSTRUCTIONS).toContain("nothing is replaced unless you name it");
  });
});
