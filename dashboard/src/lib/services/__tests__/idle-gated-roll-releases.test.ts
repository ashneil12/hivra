import { rmSync, writeFileSync } from "fs";

import { buildIdleGatedUpdateProvisioningScript } from "@/lib/services/idle-gated-update-builder";

import { FakeBox, decodeEmbeddedScripts, type BoxImage } from "./support/fake-box";

/**
 * Runs the real hourly roll script against a fake docker and a fake dashboard
 * to prove the release behaviour end to end: which image it pulls, when it
 * moves, what it reports, and that a bad release is rolled back and paused.
 */

const INST = "11111111-1111-4111-8111-111111111111";
const REPO = "ghcr.io/example/agent";
const D_OLD = `sha256:${"a".repeat(64)}`;
const D_NEW = `sha256:${"b".repeat(64)}`;
const D_BAD = `sha256:${"c".repeat(64)}`;
const ID_OLD = "sha256:1111old";
const ID_NEW = "sha256:2222new";
const ID_BAD = "sha256:3333bad";

const rollScript = (() => {
  const files = decodeEmbeddedScripts(
    buildIdleGatedUpdateProvisioningScript({ instanceId: INST, backend: "gateway", agentImage: `${REPO}:stable` })
  );
  const script = files[`/usr/local/bin/hermes-roll-${INST}`];
  if (!script) throw new Error("roll script not found");
  return script;
})();

const IMAGES: BoxImage[] = [
  { id: ID_OLD, digests: [`${REPO}@${D_OLD}`] },
  { id: ID_NEW, digests: [`${REPO}@${D_NEW}`] },
  { id: ID_BAD, digests: [`${REPO}@${D_BAD}`], health: "unhealthy" },
];

function reply(action: string, digest?: string, extra = "") {
  return digest
    ? `action=${action}\nimage=${REPO}@${digest}\ndigest=${digest}\nversion=1.0.0\ndirection=upgrade\n${extra}`
    : `action=${action}\n${extra}`;
}

function newBox(overrides: Partial<ConstructorParameters<typeof FakeBox>[0]> = {}) {
  return new FakeBox(
    {
      instanceId: INST,
      repo: REPO,
      images: IMAGES,
      running: ID_OLD,
      registry: { [`${REPO}@${D_NEW}`]: ID_NEW, [`${REPO}@${D_BAD}`]: ID_BAD, [`${REPO}:stable`]: ID_BAD },
      releaseReply: reply("roll", D_NEW),
      sessions: 12,
      ...overrides,
    },
    rollScript
  );
}

const boxes: FakeBox[] = [];
afterEach(() => {
  while (boxes.length) boxes.pop()!.destroy();
});
function make(overrides: Partial<ConstructorParameters<typeof FakeBox>[0]> = {}) {
  const box = newBox(overrides);
  boxes.push(box);
  return box;
}

describe("hourly roll against the release registry", () => {
  it("rolls to the exact digest the dashboard names, never the floating tag", () => {
    const box = make();
    const result = box.run();
    expect(result.status).toBe(0);
    expect(box.log).toContain("roll complete + healthy");

    const calls: string[] = box.state.calls;
    expect(calls).toContain(`pull ${REPO}@${D_NEW}`);
    expect(calls.filter((call) => call.startsWith("pull")).join("\n")).not.toContain(":stable");
    expect(calls.some((call) => call.startsWith("compose pull"))).toBe(false);

    // The containers now run the new image, and the box says so.
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_NEW);
    const finalReport = box.reports.at(-1)!;
    expect(finalReport).toContain("s=succeeded");
    expect(finalReport).toContain("k=updated");
    expect(finalReport).toContain("sv=2");
    expect(finalReport).toContain(`i=${D_NEW}`);
    expect(finalReport).toContain(`ti=${D_NEW}`);
    expect(box.exists(`var/lib/hermes-release-governed-${INST}`)).toBe(true);
    expect(box.exists(`var/lib/hermes-roll-paused-${INST}`)).toBe(false);
  });

  it("asks the dashboard with the digest the box actually runs", () => {
    const box = make();
    box.run();
    const lookup = box.dashboardCalls.find((line) => line.includes("/release"))!;
    expect(lookup).toContain(`repo=${REPO}`);
    expect(lookup).toContain(`cur=${D_OLD}`);
  });

  it("rolls a bad release back, pauses itself, and reports the rollback against that release", () => {
    const box = make({ releaseReply: reply("roll", D_BAD) });
    const result = box.run();
    expect(result.status).toBe(1);
    expect(box.log).toContain("rollback applied");

    // Back on the last-known-good image, with its source.
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_OLD);
    expect(box.state.refs[`${REPO}:stable`]).toBe(ID_OLD);
    expect(box.state.source_stamp).toBe(ID_OLD);
    expect(box.exists(`var/lib/hermes-roll-paused-${INST}`)).toBe(true);

    const report = box.reports.at(-1)!;
    expect(report).toContain("s=failed");
    expect(report).toContain("k=rolled_back");
    expect(report).toContain(`i=${D_OLD}`); // what runs now
    expect(report).toContain(`ti=${D_BAD}`); // the release to blame
  });

  it("stays paused and tells the dashboard exactly once per pause", () => {
    const box = make({ releaseReply: reply("roll", D_BAD) });
    box.run();
    const afterRollback = box.reports.length;
    box.run();
    box.run();
    expect(box.log).toContain("PAUSED");
    // The pause was reported when it happened; later ticks do not repeat it.
    expect(box.reports.length).toBe(afterRollback);
  });

  it("reports a pause that predates the registry once, then stays quiet", () => {
    const box = make();
    writeFileSync(box.pauseFile, "auto-roll paused 2026-09-23T10:00:00+00:00: image came up unhealthy\n");
    expect(box.run().status).toBe(0);
    const paused = box.reports.filter((line) => line.includes("k=paused"));
    expect(paused).toHaveLength(1);
    expect(paused[0]).toContain("s=failed");
    expect(paused[0]).toContain(`i=${D_OLD}`);
    box.run();
    expect(box.reports.filter((line) => line.includes("k=paused"))).toHaveLength(1);
    // Nothing was pulled or rolled while paused.
    expect(box.state.calls.some((call: string) => call.startsWith("pull"))).toBe(false);
  });

  it("says the box is healthy again after an operator clears the pause", () => {
    const box = make({ releaseReply: reply("none", D_OLD) });
    writeFileSync(box.pauseFile, "auto-roll paused: x\n");
    box.run();
    rmSync(box.pauseFile);
    box.run();
    const last = box.reports.at(-1)!;
    expect(last).toContain("k=updated");
    expect(last).toContain("s=succeeded");
  });

  it("does nothing when the box is already on its target, and reports its version once", () => {
    const box = make({ running: ID_NEW, releaseReply: reply("none", D_NEW) });
    expect(box.run().status).toBe(0);
    expect(box.log).toContain("on the target release");
    expect(box.state.calls.some((call: string) => call.startsWith("pull"))).toBe(false);
    expect(box.state.calls.some((call: string) => call.startsWith("compose stop"))).toBe(false);
    expect(box.reports).toHaveLength(1);
    expect(box.reports[0]).toContain(`i=${D_NEW}`);
    box.run();
    expect(box.reports).toHaveLength(1);
  });

  it("holds when no release is offered, never falling back to a floating tag", () => {
    const box = make({ releaseReply: "action=hold\nreason=no_release\n" });
    expect(box.run().status).toBe(0);
    expect(box.log).toContain("no release offered");
    expect(box.state.calls.some((call: string) => call.startsWith("pull") || call.startsWith("compose pull"))).toBe(false);
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_OLD);
  });

  it("does nothing when the dashboard cannot be reached", () => {
    const box = make({ releaseDown: true });
    expect(box.run().status).toBe(0);
    expect(box.log).toContain("release lookup failed");
    expect(box.state.calls.some((call: string) => call.startsWith("pull") || call.startsWith("compose pull"))).toBe(false);
  });

  it("follows the floating tag exactly as before while the registry has no release of this repository", () => {
    const box = make({
      releaseReply: "action=legacy\n",
      registry: { [`${REPO}:stable`]: ID_NEW },
    });
    expect(box.run().status).toBe(0);
    expect(box.state.calls).toContain("compose pull official-dashboard gateway");
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_NEW);
    expect(box.exists(`var/lib/hermes-release-governed-${INST}`)).toBe(false);
  });

  it("refuses a reply that names an image outside the box's repository", () => {
    const box = make({ releaseReply: `action=roll\nimage=evil.example/x@${D_NEW}\ndigest=${D_NEW}\nversion=9\n` });
    expect(box.run().status).toBe(0);
    expect(box.log).toContain("outside");
    expect(box.state.calls.some((call: string) => call.startsWith("pull"))).toBe(false);
  });

  it("does not move the box when the release image cannot be pulled", () => {
    const box = make({ registry: {} });
    expect(box.run().status).toBe(0);
    expect(box.log).toContain("pull failed");
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_OLD);
    expect(box.exists(`var/lib/hermes-roll-paused-${INST}`)).toBe(false);
  });

  it("rolls back and pauses when the roll loses the agent's sessions", () => {
    const images = IMAGES.map((image) => (image.id === ID_NEW ? { ...image, wipe_sessions: true } : image));
    const box = make({ images });
    expect(box.run().status).toBe(1);
    expect(box.log).toContain("sessions did not survive the roll");
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_OLD);
    const report = box.reports.at(-1)!;
    expect(report).toContain("k=rolled_back");
    expect(report).toContain(`ti=${D_NEW}`);
  });

  it("keeps a roll that preserves sessions", () => {
    const box = make({ sessions: 40 });
    expect(box.run().status).toBe(0);
    expect(box.log).toContain("sessions before roll: ok 40");
    expect(box.log).toContain("sessions after roll: ok 40");
  });

  it("refuses a roll whose source reseed fails, restoring the old image", () => {
    const images = IMAGES.map((image) => (image.id === ID_NEW ? { ...image, reseed_fail: true } : image));
    const box = make({ images });
    expect(box.run().status).toBe(1);
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_OLD);
    expect(box.state.refs[`${REPO}:stable`]).toBe(ID_OLD);
    const report = box.reports.at(-1)!;
    expect(report).toContain("s=failed");
    expect(report).toContain(`ti=${D_NEW}`);
  });

  it("does not move the alias before the services are stopped", () => {
    const box = make({ releaseReply: reply("roll", D_NEW) });
    box.patchState({ stop_fail: true });
    expect(box.run().status).toBe(1);
    expect(box.log).toContain("failed to stop services cleanly");
    expect(box.state.refs[`${REPO}:stable`]).toBe(ID_OLD);
  });
});
