import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";

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

describe("current-generation compose (managed gateway command)", () => {
  it("rolls instead of pausing on a compose that has no old uv command to rewrite", () => {
    const box = make({ releaseReply: reply("roll", D_NEW) });
    writeFileSync(
      join(box.instanceDir, "docker-compose.yml"),
      `services:\n  gateway:\n    image: ${REPO}:stable\n    command:\n      - |\n          def managed_gateway_command(action):\n              return ["/usr/local/bin/uv", "run", "--project", "x", "hermes", "gateway", action]\n          status_cmd = managed_gateway_command("status")\n          run_cmd = managed_gateway_command("run")\n`
    );
    expect(box.run().status).toBe(0);
    expect(box.log).not.toContain("compose migration mismatch");
    expect(box.log).toContain("roll complete + healthy");
    expect(box.exists(`var/lib/hermes-roll-paused-${INST}`)).toBe(false);
  });
});

describe("a box that follows upstream by itself (no-fork)", () => {
  const UP_REPO = "nousresearch/hermes-agent";
  const UP_DIGEST = `sha256:${"d".repeat(64)}`;
  const UP_BAD_DIGEST = `sha256:${"e".repeat(64)}`;
  const UP_IMAGES: BoxImage[] = [
    ...IMAGES,
    { id: "sha256:4444up", digests: [`${UP_REPO}@${UP_DIGEST}`] },
    { id: "sha256:5555upbad", digests: [`${UP_REPO}@${UP_BAD_DIGEST}`], health: "unhealthy" },
  ];
  const direct = (box: FakeBox) => writeFileSync(join(box.root, `var/lib/hermes-upstream-direct-${INST}`), "1\n");
  const withOverlay = (box: FakeBox) => {
    mkdirSync(join(box.instanceDir, "overlay/bin"), { recursive: true });
    writeFileSync(join(box.instanceDir, "overlay/bin/uv"), "uv\n");
  };
  const seenFiles = (box: FakeBox) => readdirSync(join(box.root, "var/lib")).filter((f) => f.startsWith(`hermes-upstream-seen-${INST}`));
  const backdateSeen = (box: FakeBox, hours: number) => {
    const when = new Date(Date.now() - hours * 3600 * 1000);
    for (const f of seenFiles(box)) utimesSync(join(box.root, "var/lib", f), when, when);
  };
  const upBox = (registryId = "sha256:4444up", extra: Partial<ConstructorParameters<typeof FakeBox>[0]> = {}) =>
    make({ images: UP_IMAGES, releaseDown: true, registry: { [`${UP_REPO}:stable`]: registryId }, ...extra });

  it("keeps waiting for the dashboard when it is not marked as following upstream", () => {
    const box = upBox();
    expect(box.run().status).toBe(0);
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_OLD);
    expect(box.state.calls.some((c: string) => c.startsWith("pull"))).toBe(false);
  });

  it("does not move onto a brand-new upstream image until it has soaked", () => {
    const box = upBox();
    direct(box);
    expect(box.run().status).toBe(0);
    expect(box.log).toContain("following upstream directly");
    expect(box.log).toContain("soaking 24h");
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_OLD);
    expect(seenFiles(box)).toHaveLength(1);
  });

  it("moves onto the upstream image after the soak, with the control plane unreachable, never asking Hivra for an image", () => {
    const box = upBox();
    direct(box);
    withOverlay(box);
    expect(box.run().status).toBe(0);
    backdateSeen(box, 25);
    expect(box.run().status).toBe(0);
    expect(box.log).toContain("roll complete + healthy");
    // the running image is the official one with the box's own overlay tools added locally
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe("sha256:asm-4444up");
    expect((box.state.copied as string[]).some((c) => c.includes("overlay/bin/uv"))).toBe(true);
    const pulls: string[] = box.state.calls.filter((c: string) => c.startsWith("pull"));
    expect(pulls.every((c) => c.includes(UP_REPO))).toBe(true);
    expect(box.state.calls.some((c: string) => c.startsWith("compose pull"))).toBe(false);
    expect(box.exists(`var/lib/hermes-release-governed-${INST}`)).toBe(false);
  });

  it("still rolls an unhealthy upstream image back and pauses", () => {
    const box = upBox("sha256:5555upbad");
    direct(box);
    box.run();
    backdateSeen(box, 25);
    expect(box.run().status).toBe(1);
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_OLD);
    expect(box.exists(`var/lib/hermes-roll-paused-${INST}`)).toBe(true);
  });

  it("lays the box's overlay over every fresh agent source, and only when one exists", () => {
    const withFiles = make({ releaseReply: reply("roll", D_NEW) });
    mkdirSync(join(withFiles.instanceDir, "overlay/files"), { recursive: true });
    expect(withFiles.run().status).toBe(0);
    expect(withFiles.state.calls.some((c: string) => c.startsWith("run ") && c.includes(":/overlay:ro"))).toBe(true);

    const without = make({ releaseReply: reply("roll", D_NEW) });
    expect(without.run().status).toBe(0);
    expect(without.state.calls.some((c: string) => c.includes(":/overlay:ro"))).toBe(false);
  });
});
