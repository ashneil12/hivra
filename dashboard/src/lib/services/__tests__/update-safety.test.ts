import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { buildInstanceUpdateReporterShell } from "@/lib/services/update-status-reporting";
import {
  UPDATE_STACK_TOUCHED,
  UPDATE_VERIFY_CALL,
  buildUpdateResultExtrasShell,
  buildUpdateSafetyPrelude,
  updateResultFilePath,
} from "@/lib/services/box-update-safety";

import { FakeBox, type BoxImage } from "./support/fake-box";

/**
 * Runs the update script's last-known-good / rollback / result machinery for
 * real, against a fake docker, by playing out the steps the update script takes
 * between the prelude and the success check.
 */

const INST = "22222222-2222-4222-8222-222222222222";
const REPO = "ghcr.io/example/agent";
const ALIAS = `${REPO}:stable`;
const D_OLD = `sha256:${"a".repeat(64)}`;
const D_NEW = `sha256:${"b".repeat(64)}`;
const ID_OLD = "sha256:1111old";
const ID_NEW = "sha256:2222new";
const ID_BAD = "sha256:3333bad";
const D_BAD = `sha256:${"c".repeat(64)}`;
const RESULT = updateResultFilePath(INST);

const IMAGES: BoxImage[] = [
  { id: ID_OLD, digests: [`${REPO}@${D_OLD}`] },
  { id: ID_NEW, digests: [`${REPO}@${D_NEW}`] },
  { id: ID_BAD, digests: [`${REPO}@${D_BAD}`], health: "unhealthy" },
];

const boxes: FakeBox[] = [];
afterEach(() => {
  while (boxes.length) boxes.pop()!.destroy();
  rmSync(RESULT, { force: true });
});

function make(overrides: Partial<ConstructorParameters<typeof FakeBox>[0]> = {}) {
  const box = new FakeBox(
    {
      instanceId: INST,
      repo: REPO,
      images: IMAGES,
      running: ID_OLD,
      registry: { [`${REPO}@${D_NEW}`]: ID_NEW, [`${REPO}@${D_BAD}`]: ID_BAD },
      sessions: 20,
      ...overrides,
    },
    "true"
  );
  boxes.push(box);
  return box;
}

const seed = `docker run --rm -v vol_agent-source:/target --entrypoint sh ${ALIAS} -lc 'true'`;

/** The update script's skeleton: prelude, then the caller's steps. */
function updateScript(box: FakeBox, steps: string) {
  return `set -euo pipefail
INSTANCE_DIR="${box.instanceDir}"
cd "$INSTANCE_DIR"
${buildUpdateSafetyPrelude({
  instanceId: INST,
  containerName: `agent-${INST}`,
  agentImage: ALIAS,
  repo: REPO,
  agentSourceSeedCommand: seed,
})}
${steps}
`;
}

const pinned = (ref: string) => `docker pull ${ref}\ndocker tag ${ref} ${ALIAS}\n`;
const touchAndRecreate = `${UPDATE_STACK_TOUCHED}\n${seed}\ndocker compose up -d --force-recreate\n`;
const result = () => (existsSync(RESULT) ? readFileSync(RESULT, "utf8") : "");

describe("update last-known-good and rollback", () => {
  it("commits a healthy update: result says updated with the new digest, last-known-good tag is dropped", () => {
    const box = make();
    const run = box.runScript(
      updateScript(box, `${pinned(`${REPO}@${D_NEW}`)}${touchAndRecreate}${UPDATE_VERIFY_CALL}\necho done`)
    );
    expect(run.status).toBe(0);
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_NEW);
    expect(result()).toContain("kind=updated");
    expect(result()).toContain(`running=${D_NEW}`);
    expect(result()).not.toContain("target=");
    expect(box.state.refs[`${REPO}:hermes-last-known-good`]).toBeUndefined();
    expect(run.stdout).toContain("last-known-good saved");
  });

  it("says why it failed in the script's own words when nothing named a reason", () => {
    const box = make();
    const log = `/tmp/hermes-update-${INST}.log`;
    writeFileSync(log, "[webui-update] pulled\n[agent-image] WARN: docker pull failed for old, continuing\n[webui-update] FATAL: containers did not converge to :stable after recreate retries\n");
    try {
      const run = box.runScript(updateScript(box, `${touchAndRecreate}exit 1`));
      expect(run.status).toBe(1);
      expect(result()).toContain("reason=[webui-update] FATAL: containers did not converge to :stable after recreate retries");
    } finally {
      rmSync(log, { force: true });
    }
  });

  it("clears a paused hourly roll when the update succeeds, and leaves it when the update fails", () => {
    const pause = `/var/lib/hermes-roll-paused-${INST}`;
    const box = make();
    const script = updateScript(box, `${touchAndRecreate}${UPDATE_VERIFY_CALL}`).split(pause).join(join(box.root, "paused"));
    writeFileSync(join(box.root, "paused"), "auto-roll paused\n");
    expect(box.runScript(script).status).toBe(0);
    expect(existsSync(join(box.root, "paused"))).toBe(false);

    const failing = make();
    const failScript = updateScript(failing, `${touchAndRecreate}exit 1`).split(pause).join(join(failing.root, "paused"));
    writeFileSync(join(failing.root, "paused"), "auto-roll paused\n");
    expect(failing.runScript(failScript).status).toBe(1);
    expect(existsSync(join(failing.root, "paused"))).toBe(true);
  });

  it("rolls a bad image back: old image, old compose file, source reseeded, result blames the release", () => {
    const box = make();
    writeFileSync(join(box.instanceDir, "docker-compose.yml"), "old compose\n");
    const run = box.runScript(
      updateScript(
        box,
        `${pinned(`${REPO}@${D_BAD}`)}printf 'new compose\\n' > docker-compose.yml\n${touchAndRecreate}echo "WebUI did not become healthy" >&2\nexit 1`
      )
    );
    expect(run.status).toBe(1); // the update still fails: it is reported as failed
    expect(run.stderr).toContain("ROLLBACK to last-known-good");
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_OLD);
    expect(box.state.refs[ALIAS]).toBe(ID_OLD);
    expect(box.state.source_stamp).toBe(ID_OLD);
    expect(readFileSync(join(box.instanceDir, "docker-compose.yml"), "utf8")).toBe("old compose\n");
    expect(result()).toContain("kind=rolled_back");
    expect(result()).toContain(`running=${D_OLD}`);
    expect(result()).toContain(`target=${D_BAD}`);
  });

  it("restores only the alias and compose file when the live stack was never touched", () => {
    const box = make({ registry: {} }); // the pinned pull fails
    writeFileSync(join(box.instanceDir, "docker-compose.yml"), "old compose\n");
    const run = box.runScript(
      updateScript(
        box,
        `printf 'new compose\\n' > docker-compose.yml\nHERMES_FAIL_REASON="cannot pull the release image"\ndocker pull ${REPO}@${D_NEW}\n`
      )
    );
    expect(run.status).toBe(1);
    expect(box.state.recreates ?? []).toEqual([]); // no needless restart of a running stack
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_OLD);
    expect(readFileSync(join(box.instanceDir, "docker-compose.yml"), "utf8")).toBe("old compose\n");
    expect(result()).toContain("kind=failed");
    expect(result()).toContain("cannot pull the release image");
    expect(result()).not.toContain("target=");
  });

  it("rolls back when the sessions did not survive, and says why", () => {
    const images = IMAGES.map((image) => (image.id === ID_NEW ? { ...image, wipe_sessions: true } : image));
    const box = make({ images });
    const run = box.runScript(
      updateScript(box, `${pinned(`${REPO}@${D_NEW}`)}${touchAndRecreate}${UPDATE_VERIFY_CALL}\necho done`)
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("sessions did not survive the update");
    expect(box.state.containers[`agent-${INST}-gateway`].image).toBe(ID_OLD);
    expect(result()).toContain("kind=rolled_back");
    expect(result()).toContain("sessions did not survive");
    expect(result()).toContain(`target=${D_NEW}`);
  });

  it("keeps an update whose sessions all came through", () => {
    const box = make({ sessions: 20 });
    const run = box.runScript(
      updateScript(box, `${pinned(`${REPO}@${D_NEW}`)}${touchAndRecreate}${UPDATE_VERIFY_CALL}\necho done`)
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("sessions after update: ok 20 (before: ok 20)");
  });

  it("does not blame a release for a config-only redeploy that fails on the same image", () => {
    const box = make();
    const run = box.runScript(
      updateScript(box, `${UPDATE_STACK_TOUCHED}\n${seed}\ndocker compose up -d --force-recreate\nexit 1`)
    );
    expect(run.status).toBe(1);
    expect(result()).toContain("kind=rolled_back");
    expect(result()).not.toContain("target=");
  });

  it("has no rollback to offer when the stack was not healthy before the update", () => {
    const box = make();
    box.patchState({
      containers: {
        [`agent-${INST}-gateway`]: { image: ID_OLD, health: "unhealthy", running: true },
        [`agent-${INST}-official-dashboard`]: { image: ID_OLD, health: "healthy", running: true },
      },
    });
    const run = box.runScript(updateScript(box, `${touchAndRecreate}exit 1`));
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("no last-known-good");
    expect(result()).toContain("kind=failed");
    expect(box.state.recreates).toHaveLength(1); // only the update's own recreate, no rollback recreate
  });

  it("leaves a script that exits 0 alone", () => {
    const box = make();
    const run = box.runScript(updateScript(box, "exit 0"));
    expect(run.status).toBe(0);
    expect(result()).toBe("");
  });
});

describe("wrapper result extras", () => {
  const extras = (box: FakeBox) =>
    box.runScript(`${buildUpdateResultExtrasShell(INST)}\nhermes_result_extras; echo; hermes_result_reason`).stdout.split("\n");

  it("turns the result file into validated query fields", () => {
    const box = make();
    writeFileSync(RESULT, `kind=rolled_back\nrunning=${D_OLD}\ntarget=${D_BAD}\nreason=sessions did not survive\n`);
    const [line, reason] = extras(box);
    expect(line).toBe(`&k=rolled_back&i=${D_OLD}&ti=${D_BAD}`);
    expect(reason).toBe("sessions did not survive");
  });

  it("drops anything that is not a kind or a digest", () => {
    const box = make();
    writeFileSync(RESULT, `kind=exploded\nrunning=nope\n`);
    expect(extras(box)[0]).toBe("");
    writeFileSync(RESULT, `kind=updated\nrunning=sha256:zz&k=failed\ntarget=${D_NEW}\n`);
    expect(extras(box)[0]).toBe(`&k=updated&ti=${D_NEW}`);
  });

  it("prints nothing when no update left a result", () => {
    const box = make();
    expect(extras(box)[0]).toBe("");
  });
});

describe("the report the wrapper sends", () => {
  it("carries the rollback outcome to the dashboard, and still sends the plain legacy report when there is none", () => {
    const box = make();
    const wrapper = (extraSetup: string) => `
cd "${box.instanceDir}"
${buildInstanceUpdateReporterShell({ instanceId: INST, runType: "manual" })}
${buildUpdateResultExtrasShell(INST)}
${extraSetup}
ru "failed" "$(hermes_result_reason)" "" "$(hermes_result_extras)"
`;
    writeFileSync(RESULT, `kind=rolled_back\nrunning=${D_OLD}\ntarget=${D_BAD}\nreason=sessions did not survive\n`);
    const withResult = box.runScript(wrapper(""));
    expect(withResult.status).toBe(0);
    const calls = readFileSync(box.curlLog, "utf8");
    expect(calls).toContain(`/api/u/${INST}?s=failed&t=manual&k=rolled_back&i=${D_OLD}&ti=${D_BAD}`);
    expect(calls).toContain("r=sessions did not survive");

    rmSync(RESULT);
    rmSync(box.curlLog);
    box.runScript(wrapper(""));
    expect(readFileSync(box.curlLog, "utf8")).toContain(`/api/u/${INST}?s=failed&t=manual\n`.trimEnd());
    expect(readFileSync(box.curlLog, "utf8")).not.toContain("&k=");
  });
});
