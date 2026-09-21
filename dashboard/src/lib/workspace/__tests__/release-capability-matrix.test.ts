import type { UnifiedAgent } from "@/lib/hivra/unified-agent";

import {
  RELEASE_CAPABILITY_MATRIX_FIELDS,
  RELEASE_CAPABILITY_REASON_CODES,
  RELEASE_CAPABILITY_SURFACES,
  buildReleaseCapabilityMatrix,
  releaseAgentLabel,
  serializeReleaseCapabilityMatrix,
  type ReleaseAgentDetailLoader,
} from "../release-capability-matrix";

const SECRET = "sk_live_DO_NOT_LEAK_123456789";

function unifiedAgent(
  kind: "hermes" | "hivra",
  id: string,
  name: string,
): UnifiedAgent {
  return {
    uid: `${kind === "hermes" ? "h" : "x"}-${id}`,
    kind,
    id,
    name,
    statusRaw: "running",
    state: "running",
    dot: "#22c55e",
    vendor: kind === "hermes" ? "Hermes" : "Hivra",
    typeLabel: kind === "hermes" ? "Hermes" : "Codex",
    agentType: kind === "hermes" ? null : "codex",
  };
}

function detailFor(agent: UnifiedAgent): unknown {
  if (agent.kind === "hermes") {
    return {
      kind: "hermes",
      uid: agent.uid,
      instance: {
        id: agent.id,
        name: agent.name,
        status: "running",
        backend: "gateway",
        gateway_url: `https://gateway.internal/?token=${SECRET}#private`,
        error: `raw provider error ${SECRET}`,
      },
    };
  }

  return {
    kind: "hivra",
    uid: agent.uid,
    agent: {
      id: agent.id,
      name: agent.name,
      status: "running",
      type: "codex",
      chat_url: "https://agent.internal",
      api_token: SECRET,
      transcript: `private transcript ${SECRET}`,
    },
    browserEnabled: true,
  };
}

const loadDetail: ReleaseAgentDetailLoader = async (agent) => detailFor(agent);

describe("release capability matrix", () => {
  it("returns an empty, fully enumerated matrix for zero loaded agents", async () => {
    const loader = jest.fn(loadDetail);

    const matrix = await buildReleaseCapabilityMatrix([], loader);

    expect(loader).not.toHaveBeenCalled();
    expect(matrix.rows).toEqual([]);
    expect(matrix.aggregate).toEqual({
      totalAgents: 0,
      resolvedAgents: 0,
      unknownAgents: 0,
      surfaces: Object.fromEntries(
        RELEASE_CAPABILITY_SURFACES.map((surface) => [surface, "no"]),
      ),
    });
  });

  it("derives one safe ordinal row from one current Hermes projection", async () => {
    const agent = unifiedAgent("hermes", "hermes-private-id", "Private Hermes");

    const matrix = await buildReleaseCapabilityMatrix([agent], loadDetail);

    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0]).toMatchObject({
      family: "hermes",
      ordinal: 1,
      detailState: "resolved",
      detailReason: "evidence-resolved",
      surfaces: {
        // A Hermes instance advertises only `terminal` beside its conversation:
        // workspace/browser/native were all the same embed as the conversation.
        workspace: { state: "unsupported", reason: "capability-not-advertised" },
        files: { state: "unsupported", reason: "capability-not-advertised" },
        git: { state: "unsupported", reason: "capability-not-advertised" },
        terminal: { state: "ready", reason: "capability-advertised" },
        browser: { state: "unsupported", reason: "capability-not-advertised" },
        desktop: { state: "unsupported", reason: "capability-not-advertised" },
        native: { state: "unsupported", reason: "capability-not-advertised" },
      },
    });
    expect(releaseAgentLabel(matrix.rows[0])).toBe("Hermes agent 1");
    expect(matrix.aggregate.surfaces.terminal).toBe("yes");
  });

  it("keeps mixed families with colliding raw IDs as separate ordinal rows", async () => {
    const agents = [
      unifiedAgent("hermes", "same-id", "Hermes collision name"),
      unifiedAgent("hivra", "same-id", "Hivra collision name"),
    ];

    const matrix = await buildReleaseCapabilityMatrix(agents, loadDetail);

    expect(matrix.rows).toHaveLength(agents.length);
    expect(matrix.rows.map(releaseAgentLabel)).toEqual([
      "Hermes agent 1",
      "Hivra agent 1",
    ]);
    expect(JSON.stringify(matrix)).not.toContain("same-id");
    expect(JSON.stringify(matrix)).not.toContain("collision name");
  });

  it("keeps a failed detail row explicit unknown while other agents resolve", async () => {
    const agents = [
      unifiedAgent("hermes", "ok", "Visible only to resolver"),
      unifiedAgent("hivra", "failed", `Secret name ${SECRET}`),
    ];
    const loader: ReleaseAgentDetailLoader = async (agent) => {
      if (agent.id === "failed") {
        throw new Error(`raw provider failure ${SECRET}`);
      }
      return detailFor(agent);
    };

    const matrix = await buildReleaseCapabilityMatrix(agents, loader);

    expect(matrix.rows).toHaveLength(agents.length);
    expect(matrix.rows[0].detailState).toBe("resolved");
    expect(matrix.rows[1]).toMatchObject({
      family: "hivra",
      ordinal: 1,
      detailState: "unknown",
      detailReason: "detail-unavailable",
    });
    expect(
      Object.values(matrix.rows[1].surfaces).every(
        ({ state, reason }) =>
          state === "unknown" && reason === "detail-unavailable",
      ),
    ).toBe(true);
    expect(matrix.aggregate.unknownAgents).toBe(1);
    expect(matrix.aggregate.surfaces.workspace).toBe("unknown");
    expect(JSON.stringify(matrix)).not.toContain(SECRET);
  });

  it("marks malformed projected detail unknown instead of dropping its row", async () => {
    const agent = unifiedAgent("hivra", "malformed", "Malformed agent");
    const matrix = await buildReleaseCapabilityMatrix([agent], async () => ({
      kind: "hivra",
      uid: agent.uid,
      agent: {
        id: agent.id,
        name: agent.name,
        status: "running",
        type: "made-up-runtime",
      },
    }));

    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0].detailState).toBe("unknown");
    expect(matrix.rows[0].detailReason).toBe("unsupported-record");
    expect(matrix.aggregate.surfaces.workspace).toBe("unknown");
  });

  it("keeps every row unknown when all detail loads fail", async () => {
    const agents = [
      unifiedAgent("hermes", "first", "First"),
      unifiedAgent("hermes", "second", "Second"),
      unifiedAgent("hivra", "third", "Third"),
    ];

    const matrix = await buildReleaseCapabilityMatrix(agents, async () => {
      throw new Error(`provider URL https://secret.invalid/?token=${SECRET}`);
    });

    expect(matrix.rows).toHaveLength(agents.length);
    expect(matrix.rows.every((row) => row.detailState === "unknown")).toBe(true);
    expect(matrix.aggregate).toMatchObject({
      totalAgents: 3,
      resolvedAgents: 0,
      unknownAgents: 3,
    });
    expect(
      Object.values(matrix.aggregate.surfaces).every(
        (support) => support === "unknown",
      ),
    ).toBe(true);
  });

  it("uses bounded concurrency while retaining input row order", async () => {
    const agents = Array.from({ length: 7 }, (_, index) =>
      unifiedAgent("hermes", `agent-${index}`, `Agent ${index}`),
    );
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const loader: ReleaseAgentDetailLoader = async (agent) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return detailFor(agent);
    };

    const pending = buildReleaseCapabilityMatrix(agents, loader, {
      concurrency: 2,
    });
    while (releases.length < 2) await Promise.resolve();
    while (releases.length > 0) releases.shift()?.();
    while (active > 0) await Promise.resolve();
    while (releases.length < 2) await Promise.resolve();
    while (releases.length > 0) releases.shift()?.();
    while (active > 0) await Promise.resolve();
    while (releases.length < 2) await Promise.resolve();
    while (releases.length > 0) releases.shift()?.();
    while (active > 0) await Promise.resolve();
    while (releases.length < 1) await Promise.resolve();
    releases.shift()?.();

    const matrix = await pending;

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(matrix.rows.map((row) => row.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("distinguishes unavailable from unsupported using current parsed detail", async () => {
    const agent = unifiedAgent("hivra", "no-access", "No access");
    const matrix = await buildReleaseCapabilityMatrix([agent], async () => ({
      kind: "hivra",
      uid: agent.uid,
      agent: {
        id: agent.id,
        name: agent.name,
        status: "running",
        type: "codex",
        chat_url: `https://agent.internal/?token=${SECRET}#private`,
        api_token: SECRET,
      },
      browserEnabled: false,
    }));

    expect(matrix.rows[0].surfaces.files).toEqual({
      state: "unavailable",
      reason: "access-unavailable",
    });
    expect(matrix.rows[0].surfaces.browser).toEqual({
      state: "unsupported",
      reason: "capability-not-advertised",
    });
    expect(JSON.stringify(matrix)).not.toContain("agent.internal");
  });

  it("serializes only public ordinal fields and allowlisted reason codes", async () => {
    const agents = [
      unifiedAgent("hermes", `uid-${SECRET}`, `Name ${SECRET}`),
      unifiedAgent("hivra", "safe", "Safe name"),
    ];
    const matrix = await buildReleaseCapabilityMatrix(agents, loadDetail);
    const copied = serializeReleaseCapabilityMatrix(matrix);
    const json = JSON.stringify(matrix);

    expect(RELEASE_CAPABILITY_MATRIX_FIELDS).toEqual(["rows", "aggregate"]);
    expect(Object.keys(matrix)).toEqual(RELEASE_CAPABILITY_MATRIX_FIELDS);
    expect(Object.keys(matrix.rows[0])).toEqual([
      "family",
      "ordinal",
      "detailState",
      "detailReason",
      "surfaces",
    ]);
    for (const row of matrix.rows) {
      expect(RELEASE_CAPABILITY_REASON_CODES).toContain(row.detailReason);
      for (const surface of RELEASE_CAPABILITY_SURFACES) {
        expect(RELEASE_CAPABILITY_REASON_CODES).toContain(
          row.surfaces[surface].reason,
        );
      }
    }
    for (const forbidden of [
      SECRET,
      "uid-",
      "Name ",
      "api_token",
      "chat_url",
      "gateway_url",
      "raw provider",
      "transcript",
      "?token=",
      "#private",
    ]) {
      expect(json).not.toContain(forbidden);
      expect(copied).not.toContain(forbidden);
    }
    expect(copied).toContain("Hermes agent 1");
    expect(copied).toContain("Hivra agent 1");
  });
});
