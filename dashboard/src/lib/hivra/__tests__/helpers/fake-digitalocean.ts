import {
  DigitalOceanApiError,
  type DigitalOceanManagedAgentsClient,
  type DigitalOceanSession,
  type DigitalOceanSessionEvent,
  type DigitalOceanSessionStatus,
} from "@/lib/digitalocean/managed-agents-client";

/** In-memory DigitalOcean Harness Runtime with scriptable failures. */
export class FakeDigitalOcean {
  sessions = new Map<string, DigitalOceanSession>();
  manifests: Record<string, unknown>[] = [];
  inputs: Array<{ sessionId: string; text: string }> = [];
  decisions: Array<{ sessionId: string; requestId: string; outcome: string }> = [];
  events: DigitalOceanSessionEvent[] = [];
  tokens: string[] = [];
  /** Tokens DigitalOcean now rejects with 401 on every session call. */
  rejectedTokens = new Set<string>();
  /** Files in each session's /workspace, keyed by path relative to /workspace. */
  workspace = new Map<string, { kind: "f" | "d" | "l"; size?: number; mtime?: number; content?: string }>();
  execs: Array<{ sessionId: string; argv: string[] }> = [];
  execResult: { exitCode: number; stdout?: string; stderr?: string } | null = null;
  downloads: Array<{ sessionId: string; path: string; asArchive: boolean }> = [];
  /** Next create call throws this error (after optionally creating anyway). */
  failNextCreate: { error: DigitalOceanApiError; createAnyway?: boolean } | null = null;
  readyAfterPolls = 0;
  destroyedAfterPolls = 0;
  private counter = 0;
  private polls = new Map<string, number>();

  client = (apiToken: string): DigitalOceanManagedAgentsClient => {
    this.tokens.push(apiToken);
    const guard = () => {
      if (this.rejectedTokens.has(apiToken)) throw new DigitalOceanApiError("unauthorized", 401, "GET", "/v2/agents/sessions");
    };
    return {
      listSandboxSizes: async () => {
        if (apiToken === "bad-token-000000000000000") throw new DigitalOceanApiError("unauthorized", 401, "GET", "/v2/agents/sessions/sandbox/sizes");
        return [
          { slug: "mars-1vcpu-1gb", vcpus: 1, memoryMb: 1024 },
          { slug: "mars-2vcpu-4gb", vcpus: 2, memoryMb: 4096 },
          { slug: "mars-8vcpu-64gb", vcpus: 8, memoryMb: 65536 },
        ];
      },
      createSessionFromManifest: async (manifest) => {
        this.manifests.push(manifest);
        const failure = this.failNextCreate;
        this.failNextCreate = null;
        let session: DigitalOceanSession | null = null;
        if (!failure || failure.createAnyway) {
          this.counter += 1;
          session = {
            sessionId: `sess_${this.counter}`, name: String(manifest.name), agentKind: "AGENT_KIND_CLAUDE_CODE",
            status: "SESSION_STATUS_PROVISIONING", pauseReason: null, createdAt: null, lastEventAt: null, configId: null, warnings: [],
          };
          this.sessions.set(session.sessionId, session);
        }
        if (failure) throw failure.error;
        return { ...session! };
      },
      getSession: async (sessionId) => {
        guard();
        const session = this.sessions.get(sessionId);
        if (!session) throw new DigitalOceanApiError("not_found", 404, "GET", "/v2/agents/sessions");
        this.advance(session);
        return { ...session };
      },
      findSessionByName: async (name) => {
        guard();
        const session = [...this.sessions.values()].find((candidate) => candidate.name === name) ?? null;
        if (session) this.advance(session);
        return session ? { ...session } : null;
      },
      destroySession: async (sessionId) => {
        const session = this.sessions.get(sessionId);
        if (!session) throw new DigitalOceanApiError("not_found", 404, "DELETE", "/v2/agents/sessions");
        session.status = this.destroyedAfterPolls > 0 ? "SESSION_STATUS_DESTROYING" : "SESSION_STATUS_DESTROYED";
        this.polls.set(sessionId, 0);
      },
      pauseSession: async (sessionId) => { this.setStatus(sessionId, "SESSION_STATUS_PAUSED", "manual"); },
      resumeSession: async (sessionId) => { this.setStatus(sessionId, "SESSION_STATUS_READY", null); },
      sendInput: async (sessionId, text) => {
        this.inputs.push({ sessionId, text });
        const session = this.sessions.get(sessionId);
        if (session?.status === "SESSION_STATUS_PAUSED") this.setStatus(sessionId, "SESSION_STATUS_READY", null);
        return { runId: `run_${this.inputs.length}` };
      },
      resolveHitl: async (sessionId, requestId, outcome) => { this.decisions.push({ sessionId, requestId, outcome }); },
      streamEvents: () => this.replayEvents(),
      execInSandbox: async (sessionId, input) => {
        guard();
        this.execs.push({ sessionId, argv: input.argv });
        if (this.execResult) return { stdout: "", stderr: "", ...this.execResult };
        // Emulate the listing script: argv = [sh, -c, script, $0, $1].
        const dir = (input.argv[4] ?? "/workspace").replace(/^\/workspace\/?/, "");
        const isDir = dir === "" || this.workspace.get(dir)?.kind === "d";
        if (!isDir) return { exitCode: 3, stdout: "", stderr: "" };
        const prefix = dir ? `${dir}/` : "";
        const stdout = [...this.workspace.entries()]
          .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
          .map(([path, entry]) => `${entry.kind}\t${entry.size ?? 4096}\t${entry.mtime ?? 1_790_000_000.5}\t${path.slice(prefix.length)}\u0000`)
          .join("");
        return { exitCode: 0, stdout, stderr: "" };
      },
      downloadWorkspace: async (sessionId, input) => {
        guard();
        this.downloads.push({ sessionId, path: input.path, asArchive: Boolean(input.asArchive) });
        const entry = this.workspace.get(input.path);
        if (!entry && !input.asArchive) throw new DigitalOceanApiError("not_found", 404, "GET", "/v2/agents/sessions/workspace/download");
        const bytes = new TextEncoder().encode(input.asArchive ? "tar-bytes" : entry?.content ?? "");
        return {
          body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
          isArchive: Boolean(input.asArchive),
          sizeBytes: entry?.size ?? bytes.byteLength,
        };
      },
    };
  };

  private async *replayEvents(): AsyncGenerator<DigitalOceanSessionEvent, void, void> {
    for (const event of this.events) yield event;
  }

  private setStatus(sessionId: string, status: DigitalOceanSessionStatus, pauseReason: string | null) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new DigitalOceanApiError("not_found", 404, "POST", "/v2/agents/sessions");
    session.status = status;
    session.pauseReason = pauseReason;
  }

  private advance(session: DigitalOceanSession) {
    const polls = (this.polls.get(session.sessionId) ?? 0) + 1;
    this.polls.set(session.sessionId, polls);
    if (session.status === "SESSION_STATUS_PROVISIONING" && polls > this.readyAfterPolls) session.status = "SESSION_STATUS_READY";
    if (session.status === "SESSION_STATUS_DESTROYING" && polls > this.destroyedAfterPolls) {
      this.sessions.delete(session.sessionId);
    }
  }
}
