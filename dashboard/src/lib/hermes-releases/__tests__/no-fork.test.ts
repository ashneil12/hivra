import { evaluateNoForkOffer, parseNoForkStatus } from "@/lib/hermes-releases/no-fork";
import type { HermesRelease } from "@/lib/hermes-releases/policy";
import { NOFORK_OVERLAY_REPO, NOFORK_UPSTREAM_ALIAS } from "@/lib/services/no-fork-migration-builder";

const DIGEST = `sha256:${"a".repeat(64)}`;

function release(overrides: Partial<HermesRelease> = {}): HermesRelease {
  return {
    id: "rel-1",
    image_repo: NOFORK_OVERLAY_REPO,
    version: "0.21.6+hivra.1",
    digest: DIGEST,
    channel: "stable",
    rollout_percent: 100,
    pilot_instance_ids: [],
    halted: false,
    halted_reason: null,
    halted_at: null,
    halted_by: null,
    notes: null,
    created_by: null,
    created_at: "2026-10-09T00:00:00Z",
    promoted_at: "2026-10-09T00:00:00Z",
    updated_at: "2026-10-09T00:00:00Z",
    ...overrides,
  };
}

const forkBox = { id: "inst-1", status: "running", backend: "gateway", release_channel: "stable", config: {} };

describe("Update to latest Hermes: who is offered it", () => {
  it("offers a running box on the fork image the promoted overlay release, by digest", () => {
    const offer = evaluateNoForkOffer(forkBox, [release()]);
    expect(offer).toMatchObject({ available: true, reason: "available", alreadyUpstream: false });
    expect(offer.target).toEqual({ version: "0.21.6+hivra.1", digest: DIGEST, overlayImage: `${NOFORK_OVERLAY_REPO}@${DIGEST}` });
  });

  it("offers nothing until the registry has promoted a release", () => {
    expect(evaluateNoForkOffer(forkBox, []).reason).toBe("no_release");
    expect(evaluateNoForkOffer(forkBox, [release({ promoted_at: null })]).reason).toBe("no_release");
    expect(evaluateNoForkOffer(forkBox, [release({ halted: true })]).reason).toBe("no_release");
  });

  it("does not offer a box that already follows upstream, is not running, or is not on the fork image", () => {
    const moved = { ...forkBox, config: { webuiAgentImage: NOFORK_UPSTREAM_ALIAS } };
    expect(evaluateNoForkOffer(moved, [release()])).toMatchObject({ available: false, alreadyUpstream: true, reason: "already_upstream" });
    expect(evaluateNoForkOffer({ ...forkBox, status: "stopped" }, [release()]).reason).toBe("not_running");
    expect(evaluateNoForkOffer({ ...forkBox, config: { webuiAgentImage: "ghcr.io/other/thing:stable" } }, [release()]).reason).toBe("not_on_fork_image");
  });

  it("follows the rollout ladder: a stable box outside the rollout is not offered it yet", () => {
    expect(evaluateNoForkOffer(forkBox, [release({ rollout_percent: 0 })]).available).toBe(false);
    expect(evaluateNoForkOffer(forkBox, [release({ rollout_percent: 0, pilot_instance_ids: ["inst-1"] })]).available).toBe(true);
  });
});

describe("box progress file", () => {
  it("reads the last JSON line and ignores junk", () => {
    expect(parseNoForkStatus('{"state":"running","phase":"snapshot","message":"x","updatedAt":"t"}')).toMatchObject({ state: "running", phase: "snapshot" });
    expect(parseNoForkStatus("")).toBeNull();
    expect(parseNoForkStatus("not json")).toBeNull();
    expect(parseNoForkStatus('{"hello":1}')).toBeNull();
  });
});
