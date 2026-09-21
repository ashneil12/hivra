import { buildAgentExport, exportFileName, EXPORT_SESSION_CAP } from "../agent-export";

// The export builder reads the box over fetch. We stub global.fetch per-test and
// route by URL so we can shape sessions / messages / files independently.

interface RouteResponse {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, ok = true, status = 200): RouteResponse {
  return { ok, status, json: async () => body };
}

const BOX = "https://box.example.com";
const TOKEN = "tok_abc";

const agent = {
  id: "agent-1",
  name: "Scout",
  type: "claude-code",
  chat_url: BOX,
  api_token: TOKEN,
};

describe("buildAgentExport", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("assembles chats + memory into the structured export shape", async () => {
    const sessions = [
      { id: "s1", title: "First", updatedAt: 100 },
      { id: "s2", title: "Second", updatedAt: 200 },
    ];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // Token must be forwarded as a Bearer header.
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      if (url.endsWith("/api/sessions")) return jsonResponse({ sessions });
      if (url.includes("/api/sessions/s1")) {
        return jsonResponse({ messages: [{ role: "user", text: "hi", tools: [] }] });
      }
      if (url.includes("/api/sessions/s2")) {
        return jsonResponse({ messages: [{ role: "assistant", text: "yo", tools: ["bash"] }] });
      }
      if (url.includes("USER.md")) return jsonResponse({ content: "# user" });
      if (url.includes("MEMORY.md")) return jsonResponse({ content: "# memory" });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const out = await buildAgentExport(agent);

    expect(out.meta).toEqual(
      expect.objectContaining({
        agentId: "agent-1",
        name: "Scout",
        type: "claude-code",
        sessionCount: 2,
        truncated: false,
        schemaVersion: 1,
      }),
    );
    expect(typeof out.meta.exportedAt).toBe("string");
    // Sessions ordered newest-first by updatedAt (s2 before s1).
    expect(out.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(out.sessions[0].messages).toEqual([{ role: "assistant", text: "yo", tools: ["bash"] }]);
    expect(out.memory).toEqual({ userMd: "# user", memoryMd: "# memory" });
  });

  it("caps the session window and flags truncated when the box has more than the cap", async () => {
    const many = Array.from({ length: EXPORT_SESSION_CAP + 7 }, (_, i) => ({
      id: `s${i}`,
      title: `S${i}`,
      // Ascending updatedAt so the newest (highest index) survive the cap.
      updatedAt: i,
    }));
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/sessions")) return jsonResponse({ sessions: many });
      if (url.includes("/api/sessions/")) return jsonResponse({ messages: [] });
      if (url.includes(".md")) return jsonResponse({ content: "x" });
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const out = await buildAgentExport(agent);

    expect(out.meta.truncated).toBe(true);
    expect(out.meta.sessionCount).toBe(EXPORT_SESSION_CAP);
    expect(out.sessions).toHaveLength(EXPORT_SESSION_CAP);
    // The newest session (highest updatedAt) is first and is kept; the oldest is dropped.
    expect(out.sessions[0].id).toBe(`s${EXPORT_SESSION_CAP + 6}`);
    expect(out.sessions.some((s) => s.id === "s0")).toBe(false);
  });

  it("does not set truncated when session count is exactly the cap", async () => {
    const exact = Array.from({ length: EXPORT_SESSION_CAP }, (_, i) => ({ id: `s${i}`, title: "t", updatedAt: i }));
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/sessions")) return jsonResponse({ sessions: exact });
      if (url.includes("/api/sessions/")) return jsonResponse({ messages: [] });
      return jsonResponse({ content: "" });
    }) as unknown as typeof fetch;

    const out = await buildAgentExport(agent);
    expect(out.meta.truncated).toBe(false);
    expect(out.meta.sessionCount).toBe(EXPORT_SESSION_CAP);
  });

  it("returns null memory + empty sessions gracefully when the box is unreachable (no throw)", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const out = await buildAgentExport(agent);

    expect(out.sessions).toEqual([]);
    expect(out.meta.sessionCount).toBe(0);
    expect(out.meta.truncated).toBe(false);
    expect(out.memory).toEqual({ userMd: null, memoryMd: null });
  });

  it("treats missing / non-OK memory files as null (legacy token-less box)", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/sessions")) return jsonResponse({ sessions: [{ id: "s1", title: "t", updatedAt: 1 }] });
      if (url.includes("/api/sessions/s1")) return jsonResponse({ messages: [] });
      // Both memory files 404 / forbidden.
      if (url.includes(".md")) return jsonResponse({ error: "forbidden" }, false, 403);
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const out = await buildAgentExport(agent);
    expect(out.sessions).toHaveLength(1);
    expect(out.memory).toEqual({ userMd: null, memoryMd: null });
  });

  it("returns a well-formed empty export when the agent has no box URL", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;

    const out = await buildAgentExport({ id: "agent-x", name: null, type: null, chat_url: null, api_token: null });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(out.meta.sessionCount).toBe(0);
    expect(out.sessions).toEqual([]);
    expect(out.memory).toEqual({ userMd: null, memoryMd: null });
  });

  it("handles a malformed sessions payload without throwing", async () => {
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/sessions")) return jsonResponse({ sessions: "not-an-array" });
      return jsonResponse({ content: null });
    }) as unknown as typeof fetch;

    const out = await buildAgentExport(agent);
    expect(out.sessions).toEqual([]);
    expect(out.memory).toEqual({ userMd: null, memoryMd: null });
  });
});

describe("exportFileName", () => {
  it("slugifies the agent name", () => {
    expect(exportFileName({ name: "My Scout Agent!", id: "agent-1" })).toBe("my-scout-agent-export.json");
  });
  it("falls back to the id when name is empty", () => {
    expect(exportFileName({ name: "", id: "agent-1" })).toBe("agent-1-export.json");
  });
  it("falls back to 'agent' when name and id slugify to nothing", () => {
    expect(exportFileName({ name: "!!!", id: "" })).toBe("agent-export.json");
  });
});
