jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import { createHash } from "node:crypto";

import {
  createDigitalOceanManagedAgentsClient,
  DigitalOceanApiError,
  parseDigitalOceanSessionEvent,
  readServerSentEvents,
  verifyWorkspaceDownloadBody,
} from "../managed-agents-client";

const TOKEN = "dop_v1_" + "a".repeat(64);

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SESSION = {
  session_id: "sess_01HZ",
  name: "hivra-abc",
  agent_kind: "AGENT_KIND_CLAUDE_CODE",
  status: "SESSION_STATUS_PROVISIONING",
  created_at: "2026-09-23T10:00:00Z",
  last_event_at: "2026-09-23T10:00:00Z",
};

describe("readServerSentEvents", () => {
  it("dispatches frames split across chunks, joins data lines, and skips comments", async () => {
    const frames = [];
    for await (const frame of readServerSentEvents(streamOf([
      ": keep-alive\n\nid: e1\nda",
      "ta: {\"a\":\n",
      "data: 1}\n\n",
      "id: e2\r\ndata: two\r\n\r\n",
    ]))) frames.push(frame);
    expect(frames).toEqual([
      { id: "e1", event: null, data: "{\"a\":\n1}" },
      { id: "e2", event: null, data: "two" },
    ]);
  });

  it("dispatches a trailing frame without a blank line at end of stream", async () => {
    const frames = [];
    for await (const frame of readServerSentEvents(streamOf(["data: last"]))) frames.push(frame);
    expect(frames).toEqual([{ id: null, event: null, data: "last" }]);
  });
});

describe("parseDigitalOceanSessionEvent", () => {
  it("maps the SPI envelope (type/data/timestamp) and falls back to the SSE id", () => {
    expect(parseDigitalOceanSessionEvent(JSON.stringify({
      run_id: "run_1", session_id: "sess_1", seq: 4, timestamp: "2026-09-23T10:00:01Z",
      type: "run.token_delta", data: { text: "hi" },
    }), "evt_9")).toEqual({
      eventId: "evt_9", runId: "run_1", seq: 4, at: "2026-09-23T10:00:01Z", type: "run.token_delta", data: { text: "hi" },
    });
  });

  it("drops malformed JSON and non-canonical event types", () => {
    expect(parseDigitalOceanSessionEvent("not json", "e")).toBeNull();
    expect(parseDigitalOceanSessionEvent(JSON.stringify({ type: "Weird Type", data: {} }), "e")).toBeNull();
  });
});

describe("createDigitalOceanManagedAgentsClient", () => {
  it("creates a session from a JSON manifest sent as YAML with the bearer token", async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ session: SESSION }, 201));
    const client = createDigitalOceanManagedAgentsClient(TOKEN, { fetch: fetchMock as unknown as typeof fetch });
    const session = await client.createSessionFromManifest({ name: "hivra-abc", agent: "claude-code" });
    expect(session).toMatchObject({ sessionId: "sess_01HZ", status: "SESSION_STATUS_PROVISIONING", name: "hivra-abc" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.digitalocean.com/v2/agents/sessions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/x-yaml");
    expect(JSON.parse(String(init.body))).toEqual({ name: "hivra-abc", agent: "claude-code" });
  });

  it("maps provider failures to stable codes without copying provider messages", async () => {
    const cases: Array<[number, string]> = [[401, "unauthorized"], [402, "payment_required"], [403, "forbidden"], [404, "not_found"], [429, "rate_limited"], [503, "unavailable"]];
    for (const [status, code] of cases) {
      const client = createDigitalOceanManagedAgentsClient(TOKEN, {
        fetch: (async () => jsonResponse({ id: "some_error", message: `secret ${TOKEN}` }, status)) as unknown as typeof fetch,
      });
      const error = await client.getSession("sess_1").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DigitalOceanApiError);
      expect((error as DigitalOceanApiError).code).toBe(code);
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  it("reports a transport timeout as timeout", async () => {
    const client = createDigitalOceanManagedAgentsClient(TOKEN, {
      timeoutMs: 5,
      fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as unknown as typeof fetch,
    });
    await expect(client.listSandboxSizes()).rejects.toMatchObject({ code: "timeout" });
  });

  it("finds a session only by its exact name", async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ sessions: [
      { ...SESSION, session_id: "sess_other", name: "hivra-abc-2" },
      { ...SESSION, session_id: "sess_match", name: "hivra-abc", status: "SESSION_STATUS_READY" },
    ] }));
    const client = createDigitalOceanManagedAgentsClient(TOKEN, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.findSessionByName("hivra-abc")).resolves.toMatchObject({ sessionId: "sess_match" });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("name=hivra-abc");
  });

  it("resumes the live stream from Last-Event-ID and pages history with replay_only", async () => {
    const fetchMock = jest.fn(async () => new Response(streamOf([
      `id: e2\ndata: ${JSON.stringify({ event_id: "e2", run_id: "r1", type: "run.completed", data: {} })}\n\n`,
    ]), { headers: { "Content-Type": "text/event-stream" } }));
    const client = createDigitalOceanManagedAgentsClient(TOKEN, { fetch: fetchMock as unknown as typeof fetch });
    const live = [];
    for await (const event of client.streamEvents("sess_1", { replayFrom: "e1" })) live.push(event);
    expect(live.map((event) => event.eventId)).toEqual(["e2"]);
    const [liveUrl, liveInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(liveUrl).toBe("https://api.digitalocean.com/v2/agents/sessions/sess_1/events");
    expect((liveInit.headers as Record<string, string>)["Last-Event-ID"]).toBe("e1");

    for await (const event of client.streamEvents("sess_1", { replayOnly: true, replayFrom: "e1" })) void event;
    const [replayUrl, replayInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(replayUrl).toContain("replay_only=true");
    expect(replayUrl).toContain("replay_from=e1");
    expect((replayInit.headers as Record<string, string>)["Last-Event-ID"]).toBeUndefined();
  });

  it("resolves approvals out of band with the DigitalOcean outcome enum", async () => {
    const fetchMock = jest.fn(async () => new Response(null, { status: 204 }));
    const client = createDigitalOceanManagedAgentsClient(TOKEN, { fetch: fetchMock as unknown as typeof fetch });
    await client.resolveHitl("sess_1", "hitl_7", "HITL_OUTCOME_APPROVE");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.digitalocean.com/v2/agents/sessions/sess_1/hitl/hitl_7");
    expect(JSON.parse(String(init.body))).toEqual({ outcome: "HITL_OUTCOME_APPROVE", source: "RESOLUTION_SOURCE_OUT_OF_BAND" });
  });
});

function footerFor(payload: string): string {
  return `DOWSSHA1${createHash("sha256").update(payload).digest("hex")}\n`;
}

describe("verifyWorkspaceDownloadBody", () => {
  it("strips DigitalOcean's integrity footer across chunk boundaries", async () => {
    const payload = "line one\nline two\n";
    const wire = payload + footerFor(payload);
    const chunks = [wire.slice(0, 5), wire.slice(5, 40), wire.slice(40)];
    await expect(new Response(verifyWorkspaceDownloadBody(streamOf(chunks))).text()).resolves.toBe(payload);
  });

  it("delivers an empty file", async () => {
    await expect(new Response(verifyWorkspaceDownloadBody(streamOf([footerFor("")]))).text()).resolves.toBe("");
  });

  it("errors the stream on a checksum mismatch, a missing footer, or a payload over the cap", async () => {
    await expect(new Response(verifyWorkspaceDownloadBody(streamOf(["tampered" + footerFor("original")]))).text()).rejects.toBeInstanceOf(DigitalOceanApiError);
    await expect(new Response(verifyWorkspaceDownloadBody(streamOf(["no footer here"]))).text()).rejects.toBeInstanceOf(DigitalOceanApiError);
    const big = "x".repeat(200);
    await expect(new Response(verifyWorkspaceDownloadBody(streamOf([big + footerFor(big)]), { maxBytes: 100 })).text()).rejects.toBeInstanceOf(DigitalOceanApiError);
  });
});

describe("sandbox exec and workspace download", () => {
  it("posts argv to the exec endpoint and parses the result", async () => {
    const fetchMock = jest.fn(async () => jsonResponse({ exit_code: 0, stdout: "ok", stderr: "" }));
    const client = createDigitalOceanManagedAgentsClient(TOKEN, { fetch: fetchMock as unknown as typeof fetch });
    await expect(client.execInSandbox("sess_1", { argv: ["sh", "-c", "echo", "x", "/workspace"], timeoutSeconds: 15 }))
      .resolves.toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.digitalocean.com/v2/agents/sessions/sess_1/sandbox/exec");
    expect(JSON.parse(String(init.body))).toEqual({ argv: ["sh", "-c", "echo", "x", "/workspace"], timeout_seconds: 15 });
  });

  it("rejects an exec response without an exit code", async () => {
    const client = createDigitalOceanManagedAgentsClient(TOKEN, { fetch: (async () => jsonResponse({ stdout: "?" })) as unknown as typeof fetch });
    await expect(client.execInSandbox("sess_1", { argv: ["true"] })).rejects.toMatchObject({ code: "response_invalid" });
  });

  it("downloads with the path query, reads DigitalOcean's headers, and verifies the body", async () => {
    const payload = "file body";
    const fetchMock = jest.fn(async () => new Response(streamOf([payload + footerFor(payload)]), {
      status: 200,
      headers: { "X-Workspace-Is-Archive": "false", "X-Workspace-Size-Bytes": String(payload.length) },
    }));
    const client = createDigitalOceanManagedAgentsClient(TOKEN, { fetch: fetchMock as unknown as typeof fetch });
    const download = await client.downloadWorkspace("sess_1", { path: "src/a b.txt" });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://api.digitalocean.com/v2/agents/sessions/sess_1/workspace/download?path=src%2Fa+b.txt");
    expect(download).toMatchObject({ isArchive: false, sizeBytes: payload.length });
    await expect(new Response(download.body).text()).resolves.toBe(payload);
  });
});

describe("listDigitalOceanInferenceModels", () => {
  it("reads model ids with the account token, dropping malformed ids, sorted", async () => {
    const { listDigitalOceanInferenceModels } = await import("../managed-agents-client");
    const fetchMock = jest.fn(async () => jsonResponse({ data: [{ id: "llama3.3-70b-instruct" }, { id: "deepseek-v4-pro" }, { id: "bad id; rm -rf" }, { id: 7 }] }));
    await expect(listDigitalOceanInferenceModels(TOKEN, { fetch: fetchMock as unknown as typeof fetch }))
      .resolves.toEqual(["deepseek-v4-pro", "llama3.3-70b-instruct"]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://inference.do-ai.run/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("maps a rejected token without exposing it", async () => {
    const { listDigitalOceanInferenceModels } = await import("../managed-agents-client");
    const failure = listDigitalOceanInferenceModels(TOKEN, { fetch: (async () => jsonResponse({ id: "unauthorized" }, 401)) as unknown as typeof fetch });
    await expect(failure).rejects.toMatchObject({ code: "unauthorized" });
    await expect(failure.catch((error: Error) => error.message)).resolves.not.toContain(TOKEN);
  });
});
