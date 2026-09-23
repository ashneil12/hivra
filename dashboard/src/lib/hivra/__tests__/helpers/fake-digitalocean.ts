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
  /** Next create call throws this error (after optionally creating anyway). */
  failNextCreate: { error: DigitalOceanApiError; createAnyway?: boolean } | null = null;
  readyAfterPolls = 0;
  destroyedAfterPolls = 0;
  private counter = 0;
  private polls = new Map<string, number>();

  client = (apiToken: string): DigitalOceanManagedAgentsClient => {
    this.tokens.push(apiToken);
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
        const session = this.sessions.get(sessionId);
        if (!session) throw new DigitalOceanApiError("not_found", 404, "GET", "/v2/agents/sessions");
        this.advance(session);
        return { ...session };
      },
      findSessionByName: async (name) => {
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
