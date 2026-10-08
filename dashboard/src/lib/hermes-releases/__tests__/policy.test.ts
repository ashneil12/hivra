import {
  decideUpdate,
  HALT_ABSOLUTE_FAILED_BOXES,
  imageRepoOf,
  isReleaseEligible,
  nextStage,
  releaseImageRef,
  releaseStage,
  resolveTargetRelease,
  rolloutBucket,
  shouldHaltRelease,
  stagePatch,
  type HermesRelease,
} from "../policy";

const REPO = "ghcr.io/example/agent";
const digest = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
const BOX = "11111111-1111-4111-8111-111111111111";

function release(overrides: Partial<HermesRelease> & { n: number }): HermesRelease {
  const { n, ...rest } = overrides;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    image_repo: REPO,
    version: `1.0.${n}`,
    digest: digest(n),
    channel: "stable",
    rollout_percent: 100,
    pilot_instance_ids: [],
    halted: false,
    halted_reason: null,
    halted_at: null,
    halted_by: null,
    notes: null,
    created_by: null,
    created_at: `2026-10-0${n}T00:00:00.000Z`,
    promoted_at: `2026-10-0${n}T01:00:00.000Z`,
    updated_at: `2026-10-0${n}T01:00:00.000Z`,
    ...rest,
  };
}

describe("imageRepoOf", () => {
  it.each([
    ["ghcr.io/o/n:stable", "ghcr.io/o/n"],
    ["ghcr.io/o/n@sha256:" + "a".repeat(64), "ghcr.io/o/n"],
    ["ghcr.io/o/n", "ghcr.io/o/n"],
    ["registry.local:5000/n", "registry.local:5000/n"],
    ["registry.local:5000/n:v1", "registry.local:5000/n"],
  ])("%s -> %s", (ref, repo) => {
    expect(imageRepoOf(ref)).toBe(repo);
  });
});

describe("rolloutBucket", () => {
  it("is deterministic, in range, and salted by release", () => {
    const a = rolloutBucket("rel-a", BOX);
    expect(a).toBe(rolloutBucket("rel-a", BOX));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
    expect(rolloutBucket("rel-b", BOX)).not.toBe(a);
  });

  it("admits roughly the requested share of boxes", () => {
    let admitted = 0;
    const total = 4000;
    for (let i = 0; i < total; i += 1) {
      if (rolloutBucket("rel-a", `box-${i}`) < 10) admitted += 1;
    }
    expect(admitted / total).toBeGreaterThan(0.07);
    expect(admitted / total).toBeLessThan(0.13);
  });

  it("keeps a box admitted at 10% admitted at 100%", () => {
    for (let i = 0; i < 500; i += 1) {
      const id = `box-${i}`;
      if (rolloutBucket("rel-a", id) < 10) expect(rolloutBucket("rel-a", id) < 100).toBe(true);
    }
  });
});

describe("isReleaseEligible", () => {
  const subject = { instanceId: BOX, channel: "stable" as const };

  it("never offers a halted or unpromoted release", () => {
    expect(isReleaseEligible(release({ n: 1, halted: true, halted_reason: "x", halted_at: "2026-10-01T00:00:00Z" }), subject)).toBe(false);
    expect(isReleaseEligible(release({ n: 1, promoted_at: null, channel: "canary", rollout_percent: 0 }), { ...subject, channel: "canary" })).toBe(false);
  });

  it("offers a canary-channel release only to canary boxes", () => {
    const canary = release({ n: 1, channel: "canary", rollout_percent: 0 });
    expect(isReleaseEligible(canary, subject)).toBe(false);
    expect(isReleaseEligible(canary, { ...subject, channel: "canary" })).toBe(true);
  });

  it("offers a stable release to the pilot box regardless of percent, and to others by bucket", () => {
    const pilot = release({ n: 1, rollout_percent: 0, pilot_instance_ids: [BOX] });
    expect(isReleaseEligible(pilot, subject)).toBe(true);
    expect(isReleaseEligible(pilot, { ...subject, instanceId: "someone-else" })).toBe(false);
    expect(isReleaseEligible(release({ n: 1, rollout_percent: 100 }), { ...subject, instanceId: "someone-else" })).toBe(true);
    expect(isReleaseEligible(release({ n: 1, rollout_percent: 0 }), subject)).toBe(false);
  });
});

describe("resolveTargetRelease", () => {
  it("picks the newest eligible release of the box's repository", () => {
    const releases = [
      release({ n: 1 }),
      release({ n: 2, rollout_percent: 0 }), // pilot stage, this box not in it
      release({ n: 3, image_repo: "ghcr.io/other/agent" }),
    ];
    const target = resolveTargetRelease(releases, { instanceId: BOX, channel: "stable", imageRepo: REPO });
    expect(target?.version).toBe("1.0.1");
  });

  it("gives canary boxes a release that is still at the canary stage", () => {
    const releases = [release({ n: 1 }), release({ n: 2, channel: "canary", rollout_percent: 0 })];
    expect(resolveTargetRelease(releases, { instanceId: BOX, channel: "canary", imageRepo: REPO })?.version).toBe("1.0.2");
    expect(resolveTargetRelease(releases, { instanceId: BOX, channel: "stable", imageRepo: REPO })?.version).toBe("1.0.1");
  });

  it("returns null when nothing is offered", () => {
    expect(resolveTargetRelease([release({ n: 1, halted: true, halted_reason: "x", halted_at: "2026-10-01T00:00:00Z" })], { instanceId: BOX, channel: "stable", imageRepo: REPO })).toBeNull();
  });
});

describe("decideUpdate", () => {
  const releases = [release({ n: 1 }), release({ n: 2 })];
  const base = { instanceId: BOX, channel: "stable" as const, imageRepo: REPO };

  it("reports nothing to do when the box runs its target", () => {
    expect(decideUpdate(releases, { ...base, currentDigest: digest(2) })).toMatchObject({ direction: "none", autoMove: false, updateAvailable: false });
  });

  it("moves a box forward, automatically", () => {
    expect(decideUpdate(releases, { ...base, currentDigest: digest(1) })).toMatchObject({ direction: "upgrade", autoMove: true, updateAvailable: true });
  });

  it("brings an unknown or never-reported digest onto a registered release", () => {
    expect(decideUpdate(releases, { ...base, currentDigest: null })).toMatchObject({ direction: "unknown_current", autoMove: true });
    expect(decideUpdate(releases, { ...base, currentDigest: digest(99) })).toMatchObject({ direction: "unknown_current", autoMove: true });
  });

  it("does not move a box backwards on its own, but shows the update to the user", () => {
    const walkedBack = [release({ n: 1 }), release({ n: 2, rollout_percent: 0 })];
    expect(decideUpdate(walkedBack, { ...base, currentDigest: digest(2) })).toMatchObject({ direction: "rollback", autoMove: false, updateAvailable: true });
  });

  it("moves a box off a halted release automatically", () => {
    const halted = [release({ n: 1 }), release({ n: 2, halted: true, halted_reason: "bad", halted_at: "2026-10-02T02:00:00Z" })];
    expect(decideUpdate(halted, { ...base, currentDigest: digest(2) })).toMatchObject({ direction: "rollback", autoMove: true, target: expect.objectContaining({ version: "1.0.1" }) });
  });

  it("gives an image reference pinned by digest", () => {
    expect(releaseImageRef(releases[0])).toBe(`${REPO}@${digest(1)}`);
  });
});

describe("shouldHaltRelease", () => {
  it("never halts without a failure", () => {
    expect(shouldHaltRelease({ succeededBoxes: 5, failedBoxes: 0 }).halt).toBe(false);
  });

  it("halts on the first failure while only one or two boxes have tried it", () => {
    expect(shouldHaltRelease({ succeededBoxes: 0, failedBoxes: 1 }).halt).toBe(true);
    expect(shouldHaltRelease({ succeededBoxes: 1, failedBoxes: 1 }).halt).toBe(true);
  });

  it("halts a wider rollout on the failure ratio or the absolute count", () => {
    expect(shouldHaltRelease({ succeededBoxes: 3, failedBoxes: 1 }).halt).toBe(true); // 25%
    expect(shouldHaltRelease({ succeededBoxes: 9, failedBoxes: 1 }).halt).toBe(false); // 10%
    expect(shouldHaltRelease({ succeededBoxes: 100, failedBoxes: HALT_ABSOLUTE_FAILED_BOXES }).halt).toBe(true);
  });
});

describe("promotion ladder", () => {
  const now = "2026-10-07T00:00:00.000Z";

  it("derives the stage from stored fields", () => {
    expect(releaseStage(release({ n: 1, channel: "canary", rollout_percent: 0, promoted_at: null }))).toBe("registered");
    expect(releaseStage(release({ n: 1, channel: "canary", rollout_percent: 0 }))).toBe("canary");
    expect(releaseStage(release({ n: 1, rollout_percent: 0, pilot_instance_ids: [BOX] }))).toBe("pilot");
    expect(releaseStage(release({ n: 1, rollout_percent: 10 }))).toBe("ten_percent");
    expect(releaseStage(release({ n: 1, rollout_percent: 100 }))).toBe("full");
  });

  it("walks canary -> pilot -> 10% -> 100%, one rung at a time", () => {
    expect(nextStage("registered")).toBe("canary");
    expect(stagePatch("registered", "canary", { now })).toMatchObject({ channel: "canary" });
    expect(stagePatch("canary", "pilot", { now, pilotInstanceId: BOX })).toMatchObject({ channel: "stable", rollout_percent: 0, pilot_instance_ids: [BOX] });
    expect(stagePatch("pilot", "ten_percent", { now })).toMatchObject({ rollout_percent: 10 });
    expect(stagePatch("ten_percent", "full", { now })).toMatchObject({ rollout_percent: 100 });
    expect(nextStage("full")).toBeNull();
  });

  it("refuses to skip a rung or to pilot without a box", () => {
    expect(() => stagePatch("registered", "full", { now })).toThrow(/one stage at a time/);
    expect(() => stagePatch("canary", "ten_percent", { now })).toThrow(/one stage at a time/);
    expect(() => stagePatch("canary", "pilot", { now })).toThrow(/needs the box/);
  });
});
