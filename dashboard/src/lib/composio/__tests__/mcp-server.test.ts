import {
  COMPOSIO_MCP_SERVER_NAME,
  extractComposioRedirectUrl,
  getDashboardOrigin,
  isComposioManagedServerName,
  parseComposioToolResult,
  readCurrentComposioEntry,
} from "@/lib/composio/mcp-server";

describe("composio mcp-server helpers (SDK-free)", () => {
  it("COMPOSIO_MCP_SERVER_NAME is 'composio' and only that is managed", () => {
    expect(COMPOSIO_MCP_SERVER_NAME).toBe("composio");
    expect(isComposioManagedServerName("composio")).toBe(true);
    expect(isComposioManagedServerName("other")).toBe(false);
    expect(isComposioManagedServerName("composio_gmail")).toBe(false);
  });

  it("getDashboardOrigin strips trailing slash + falls back to the apex", () => {
    expect(getDashboardOrigin("https://x.example/")).toBe("https://x.example");
    expect(getDashboardOrigin(undefined)).toBe("https://hivra.cloud");
    expect(getDashboardOrigin("   ")).toBe("https://hivra.cloud");
  });

  describe("readCurrentComposioEntry", () => {
    const entry = {
      url: "https://backend.composio.dev/v3/mcp/srv_1?user_id=u1",
      headers: { "x-api-key": "ck_1" },
    };

    it("reads a well-formed composio entry", () => {
      expect(readCurrentComposioEntry({ mcp_servers: { composio: entry, other: {} } })).toEqual(entry);
    });

    it("returns null when there's no composio entry / no mcp_servers", () => {
      expect(readCurrentComposioEntry({})).toBeNull();
      expect(readCurrentComposioEntry({ mcp_servers: { other: {} } })).toBeNull();
      expect(readCurrentComposioEntry({ mcp_servers: [] as unknown as Record<string, unknown> })).toBeNull();
    });

    it("returns null for a malformed entry (missing url)", () => {
      expect(readCurrentComposioEntry({ mcp_servers: { composio: { headers: {} } } })).toBeNull();
    });

    it("keeps only string header values", () => {
      const res = readCurrentComposioEntry({
        mcp_servers: { composio: { url: "https://x", headers: { a: "1", b: 2 } } },
      });
      expect(res).toEqual({ url: "https://x", headers: { a: "1" } });
    });
  });

  describe("extractComposioRedirectUrl", () => {
    // Real shape: the link is inside a JSON-string-in-JSON SSE frame, so the
    // quotes around redirect_url are backslash-escaped in the raw body.
    const raw =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":' +
      '"{\\"data\\":{\\"results\\":{\\"gmail\\":{\\"status\\":\\"initiated\\",' +
      '\\"redirect_url\\":\\"https://connect.composio.dev/link/lk_rZQSb9Y75CBB\\"}}}}"}]}}';

    it("pulls the login link out of an escaped SSE tool-result body", () => {
      expect(extractComposioRedirectUrl(raw)).toBe(
        "https://connect.composio.dev/link/lk_rZQSb9Y75CBB",
      );
    });

    it("handles an unescaped redirect_url too", () => {
      expect(
        extractComposioRedirectUrl('{"redirect_url":"https://connect.composio.dev/link/lk_abc123"}'),
      ).toBe("https://connect.composio.dev/link/lk_abc123");
    });

    it("returns null when there's no link", () => {
      expect(extractComposioRedirectUrl('{"error":"nope"}')).toBeNull();
      expect(extractComposioRedirectUrl("")).toBeNull();
    });
  });

  describe("parseComposioToolResult", () => {
    it("parses the JSON tool result out of an SSE frame (content[].text)", () => {
      const inner = JSON.stringify({ data: { results: { gmail: { status: "active" } } } });
      const raw =
        "event: message\ndata: " +
        JSON.stringify({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: inner }] } });
      expect(parseComposioToolResult(raw)).toEqual({ data: { results: { gmail: { status: "active" } } } });
    });

    it("returns null when there's no parsable tool result", () => {
      expect(parseComposioToolResult("event: ping\ndata: not json")).toBeNull();
      expect(parseComposioToolResult("")).toBeNull();
    });
  });
});
