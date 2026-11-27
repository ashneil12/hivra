/** @jest-environment node */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = readFileSync("provisioner/hivra-provision-on-host.sh", "utf8");

it("accepts only a matching root-owned standalone image within the disk envelope before VM creation", () => {
  const content = "fixture image";
  const digest = createHash("sha256").update(content).digest("hex");
  const work = mkdtempSync(join(tmpdir(), "hermes-image-test-"));
  try {
    const image = join(work, `hivra-hermes-${digest}.qcow2`);
    writeFileSync(image, content);
    const begin = script.indexOf('if [ -n "$HERMES_IMAGE_SHA256" ]; then');
    const end = script.indexOf("launch_stage image_verified", begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    expect(end).toBeLessThan(script.indexOf('qm create "$VMID"'));
    const fragment = script.slice(begin, end).replaceAll("/var/lib/vz/template/iso", work);
    const run = (args: Record<string, string> = {}) => spawnSync("bash", ["-c", `set -euo pipefail
fail() { printf '%s' "$*" >&2; exit 1; }
stat() { printf '%s' "$FIXTURE_STAT"; }
qemu-img() { printf '%s' "$FIXTURE_QEMU_INFO"; }
${fragment}
printf '%s' "$IMG"`], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_KIND: "hermes",
        PROVISION_MODE: "install",
        PROV_DIR: "/root/hivra-provisioner-canary",
        DISK_GB: "40",
        HERMES_IMAGE_SHA256: digest,
        FIXTURE_STAT: "0:0:444:1",
        FIXTURE_QEMU_INFO: JSON.stringify({ format: "qcow2", "virtual-size": 8 * 1024 ** 3 }),
        IMG: "/stock.img",
        ...args,
      },
    });
    expect(run()).toMatchObject({ status: 0, stdout: image });
    expect(run({ AGENT_KIND: "codex" })).toMatchObject({ status: 1, stderr: "invalid baked Hermes image selection" });
    expect(run({ PROV_DIR: "/root/hivra-provisioner" })).toMatchObject({ status: 1, stderr: "invalid baked Hermes image selection" });
    expect(run({ PROVISION_MODE: "empty" })).toMatchObject({ status: 1, stderr: "invalid baked Hermes image selection" });
    expect(run({ FIXTURE_STAT: "0:0:664:1" })).toMatchObject({ status: 1, stderr: expect.stringContaining("root-owned") });
    for (const data of [
      { format: "raw", "virtual-size": 8 * 1024 ** 3 },
      { format: "qcow2", "virtual-size": 41 * 1024 ** 3 },
      { format: "qcow2", "virtual-size": 8 * 1024 ** 3, "backing-filename": "base.qcow2" },
      { format: "qcow2", "virtual-size": 8 * 1024 ** 3, "format-specific": { data: { "data-file": "external.raw" } } },
    ]) {
      expect(run({ FIXTURE_QEMU_INFO: JSON.stringify(data) })).toMatchObject({ status: 1, stderr: expect.stringContaining("standalone qcow2") });
    }
    writeFileSync(image, "wrong bytes");
    expect(run()).toMatchObject({ status: 1, stderr: "baked Hermes image digest mismatch" });
    rmSync(image);
    const other = join(work, "other.qcow2");
    writeFileSync(other, content);
    symlinkSync(other, image);
    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining("root-owned") });
    expect(run({ HERMES_IMAGE_SHA256: "", IMG: other })).toMatchObject({ status: 0, stdout: other });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

it("marks only the verified baked Hermes path in the guest launch document", () => {
  const begin = script.indexOf("guest_launch_document() {");
  const end = script.indexOf("\nguest_launch_document |", begin);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  const run = (kind: string, digest: string) => spawnSync("bash", ["-c", `set -euo pipefail
${script.slice(begin, end)}
guest_launch_document`], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_KIND: kind,
      HIVRA_MODEL_KEY: "",
      HIVRA_MODEL_BASE_URL: "",
      HIVRA_HERMES_MODEL: "",
      HIVRA_COMPUTER_ID: "",
      HIVRA_CONTROL_ORIGIN: "",
      HERMES_IMAGE_SHA256: digest,
    },
  });
  const stock = run("hermes", "");
  expect(stock.status).toBe(0);
  expect(JSON.parse(stock.stdout)).not.toHaveProperty("hermesBaked");
  const baked = run("hermes", "a".repeat(64));
  expect(baked.status).toBe(0);
  expect(JSON.parse(baked.stdout)).toMatchObject({ version: 1, agentKind: "hermes", computerSubstrate: "proxmox-kvm", hermesBaked: true });
  expect(run("codex", "a".repeat(64))).toMatchObject({ status: 1, stdout: "" });
});
