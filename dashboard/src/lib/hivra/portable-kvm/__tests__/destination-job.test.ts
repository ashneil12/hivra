import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { runProxmoxHostScript, runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import { dispatchPortableKvmDestinationJob, pollPortableKvmDestinationJob } from "../destination-job";
import { buildPortableKvmDestinationDiskScript, serializePortableKvmDestinationReservation } from "../destination-disk";

jest.mock("server-only", () => ({}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  runProxmoxHostScriptWithStdin: jest.fn(),
}));
jest.mock("../destination-disk", () => ({
  ...jest.requireActual("../destination-disk"),
  buildPortableKvmDestinationDiskScript: jest.fn(),
}));

const reservation = {
  agentId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222",
  generation: 2, checkpointSha256: "3".repeat(64), hostId: "qa-destination", vmid: 9344,
  bindingTag: "hivra-bind-" + "a".repeat(32), configurationSha256: "b".repeat(64),
  rawConfigurationSha256: "c".repeat(64), storageId: "local-lvm", volumeName: "vm-9344-disk-0",
  volumeGroup: "pve", deviceMapperUuid: "LVM-" + "A".repeat(64),
  disk: { key: "scsi0" as const, snapshotId: "4".repeat(64), sha256: "d".repeat(64), bytes: 1024 },
};
const receipt = { state: "disk_restored_verified", reservation, readback: { bytes: 1024, sha256: reservation.disk.sha256 } };
const diskOutput = "HIVRA_KVM_PORTABLE_DESTINATION_V1 " + JSON.stringify(receipt);
const jobPrefix = "HIVRA_KVM_PORTABLE_DESTINATION_JOB_V1 ";
const password = "e".repeat(64);
const env = {};
const run = jest.mocked(runProxmoxHostScript);
const runWithStdin = jest.mocked(runProxmoxHostScriptWithStdin);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  jest.resetAllMocks();
});

function fakeHost() {
  const root = mkdtempSync(join(tmpdir(), "hivra-kvm-job-"));
  const registry = join(root, "portable-kvm-destinations");
  const jobs = join(root, "portable-kvm-destination-jobs");
  const job = join(jobs, reservation.operationId);
  const marker = join(registry, "9344");
  const bin = join(root, "bin");
  roots.push(root);
  for (const dir of [registry, bin]) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(marker, serializePortableKvmDestinationReservation(reservation), { mode: 0o600 });
  const put = (name: string, source: string) => writeFileSync(join(bin, name), source, { mode: 0o700 });
  put("hostname", "#!/bin/bash\necho qa-destination\n");
  put("systemctl", `#!/bin/bash
if [ -e "$TEST_ROOT/active" ]; then
  printf 'LoadState=loaded\\nActiveState=active\\n'
else
  printf 'LoadState=not-found\\nActiveState=inactive\\n'
  exit 1
fi
`);
  put("systemd-run", `#!/usr/bin/python3
import os
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
assert args[:4] == ["--quiet", "--collect", "--no-block", "--service-type=exec"]
assert "RuntimeMaxSec=3615s" in args and "Restart=no" in args
assert "StandardOutput=null" in args and "StandardError=null" in args
root = Path(os.environ["TEST_ROOT"])
with (root / "launches").open("a") as log:
    log.write("launch\\n")
if (root / "dispatch-failure").exists():
    sys.exit(1)
(root / "active").touch()
index = args.index("/usr/bin/python3")
fifo = args[index - 1].removeprefix("StandardInput=file:")
subprocess.Popen(["/bin/bash", "-c",
    """timeout -k 1 3 /bin/bash -c 'exec "$@" < "$TEST_FIFO"' fifo "$@"; rm -f "$TEST_ROOT/active" """,
    "unit", *args[index:]], env=dict(os.environ, TEST_FIFO=fifo), start_new_session=True,
    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
`);
  jest.mocked(buildPortableKvmDestinationDiskScript).mockReturnValue(`set -euo pipefail
IFS= read -r key
[ "$(printf '%s' "$key" | sha256sum | cut -d ' ' -f 1)" = ${createHash("sha256").update(password).digest("hex")} ]
until [ -e "$TEST_ROOT/release" ]; do sleep 0.02; done
echo write >> "$TEST_ROOT/writes"
printf '%s\\n' ${shellQuote(diskOutput)}
[ ! -e "$TEST_ROOT/worker-failure" ]
`);
  const exec = async (script: string, input = "") => {
    const uid = process.getuid?.() ?? 0;
    const local = script.replace('Path("/var/lib/hivra-sleep")', `Path(${JSON.stringify(root)})`)
      .replaceAll("info.st_uid == 0", "info.st_uid == " + uid).replace("os.geteuid() == 0", "os.geteuid() == " + uid);
    const result = await new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve, reject) => {
      const child = spawn("bash", ["-c", local], { env: { NODE_ENV: "test", PATH: bin + ":/usr/bin:/bin", TEST_ROOT: root } });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      child.on("error", reject).on("close", status => resolve({ stdout, stderr, status }));
      child.stdin.end(input);
    });
    expect(result.stderr).not.toContain(password);
    expect(result.stdout).not.toContain(password);
    expect(result.status).toBe(0);
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  };
  run.mockImplementation(async script => exec(script));
  runWithStdin.mockImplementation(async (script, stdin) => exec(script, stdin));
  const touch = (name: string) => writeFileSync(join(root, name), "");
  const count = (name: string) => existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").trim().split("\n").length : 0;
  return { job, jobs, marker, root, touch, count };
}

const dispatch = () => dispatchPortableKvmDestinationJob(reservation, password, env);
const poll = () => pollPortableKvmDestinationJob(reservation, env);

async function settled() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = await poll();
    if (status.state !== "running") return status;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Fake destination worker did not settle");
}

it("dispatches once, hands off the key via FIFO, and polls the same durable receipt", async () => {
  const host = fakeHost();
  expect(await poll()).toEqual({ state: "missing" });
  expect(existsSync(host.jobs)).toBe(false);
  expect(await Promise.all([dispatch(), dispatch()])).toEqual([{ state: "running" }, { state: "running" }]);
  const [script, stdin, transport, options] = runWithStdin.mock.calls[0];
  expect(script).not.toContain(password);
  expect(stdin).toBe(password + "\n");
  expect(transport).toBe(env);
  expect(options).toEqual({ timeoutMs: 25_000, maxOutputBytes: 8192 });
  expect(run.mock.calls[0][2]).toEqual(options);
  expect(existsSync(join(host.job, "input"))).toBe(false);
  expect(await dispatch()).toEqual({ state: "running" });
  expect(await poll()).toEqual({ state: "running" });
  expect(host.count("launches")).toBe(1);
  expect(host.count("writes")).toBe(0);
  host.touch("release");
  expect(await settled()).toEqual({ state: "succeeded", receipt });
  expect(await dispatch()).toEqual({ state: "succeeded", receipt });
  expect(await poll()).toEqual({ state: "succeeded", receipt });
  expect(host.count("writes")).toBe(1);
  expect(host.count("launches")).toBe(1);
});

it("retains a failed claim and discards even a valid-looking output from a failed worker", async () => {
  const host = fakeHost();
  host.touch("worker-failure");
  host.touch("release");
  expect(await dispatch()).toEqual({ state: "running" });
  expect(await settled()).toEqual({ state: "failed" });
  expect(await dispatch()).toEqual({ state: "failed" });
  expect(host.count("writes")).toBe(1);
  expect(host.count("launches")).toBe(1);
  expect(readdirSync(host.job).sort()).toEqual(["identity", "restore.sh"]);
  expect(existsSync(host.marker)).toBe(true);
});

it("does not retry an uncertain launch or unlink its durable claim", async () => {
  const host = fakeHost();
  host.touch("dispatch-failure");
  expect(await dispatch()).toEqual({ state: "unavailable" });
  expect(await poll()).toEqual({ state: "failed" });
  expect(await dispatch()).toEqual({ state: "failed" });
  expect(host.count("launches")).toBe(1);
  expect(host.count("writes")).toBe(0);
  expect(readdirSync(host.job).sort()).toEqual(["identity", "restore.sh"]);
});

it("resumes a detached worker when the dispatch response is lost", async () => {
  const host = fakeHost();
  const execute = runWithStdin.getMockImplementation()!;
  runWithStdin.mockImplementationOnce(async (...args) => {
    await execute(...args);
    return { ok: false, stdout: "", stderr: "", error: "request timed out" };
  });
  expect(await dispatch()).toEqual({ state: "unavailable" });
  expect(await poll()).toEqual({ state: "running" });
  host.touch("release");
  expect(await settled()).toEqual({ state: "succeeded", receipt });
  expect(host.count("launches")).toBe(1);
  expect(host.count("writes")).toBe(1);
});

it("requires the live root-only reservation and the original claim even after settlement", async () => {
  const host = fakeHost();
  chmodSync(host.marker, 0o644);
  expect(await dispatch()).toEqual({ state: "unavailable" });
  expect(await poll()).toEqual({ state: "unavailable" });
  chmodSync(host.marker, 0o600);
  host.touch("release");
  expect(await dispatch()).toEqual({ state: "running" });
  expect(await settled()).toEqual({ state: "succeeded", receipt });

  const changed = { ...reservation, generation: reservation.generation + 1 };
  writeFileSync(host.marker, serializePortableKvmDestinationReservation(changed));
  expect(await poll()).toEqual({ state: "unavailable" });
  expect(await pollPortableKvmDestinationJob(changed, env)).toEqual({ state: "unavailable" });
  expect(await dispatchPortableKvmDestinationJob(changed, password, env)).toEqual({ state: "unavailable" });
  rmSync(host.marker);
  symlinkSync(join(host.job, "identity"), host.marker);
  expect(await poll()).toEqual({ state: "unavailable" });
  expect(host.count("launches")).toBe(1);
  expect(host.count("writes")).toBe(1);
});

it("rejects malformed, duplicate, mismatched, or unsuccessful host output", async () => {
  const reservationSha256 = createHash("sha256").update(serializePortableKvmDestinationReservation(reservation)).digest("hex");
  const valid = { operationId: reservation.operationId, reservationSha256, state: "succeeded", receipt: diskOutput };
  for (const value of [
    { ...valid, operationId: reservation.agentId },
    { ...valid, reservationSha256: "9".repeat(64) },
    { ...valid, receipt: diskOutput.replace(reservation.disk.sha256, "9".repeat(64)) },
    { ...valid, receipt: diskOutput + "\n" + diskOutput },
    { ...valid, receipt: null },
    { ...valid, unexpected: true },
  ]) {
    run.mockResolvedValueOnce({ ok: true, stdout: jobPrefix + JSON.stringify(value), stderr: "" });
    expect(await poll()).toEqual({ state: "unavailable" });
  }
  const validLine = jobPrefix + JSON.stringify(valid);
  run.mockResolvedValueOnce({ ok: true, stdout: validLine + "\n" + validLine, stderr: "" });
  expect(await poll()).toEqual({ state: "unavailable" });
  run.mockResolvedValueOnce({ ok: false, stdout: validLine, stderr: "", error: "timeout" });
  expect(await poll()).toEqual({ state: "unavailable" });
  run.mockRejectedValueOnce(new Error("transport disconnected"));
  expect(await poll()).toEqual({ state: "unavailable" });
  await expect(dispatchPortableKvmDestinationJob(reservation, password + "\n", env)).rejects.toThrow("Invalid portable KVM repository password");
  expect(runWithStdin).not.toHaveBeenCalled();
});
