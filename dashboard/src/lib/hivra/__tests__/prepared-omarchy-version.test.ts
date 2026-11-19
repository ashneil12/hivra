import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { PREPARED_OMARCHY_GUEST_OBSERVATION, PREPARED_OMARCHY_VERSION_MARKER, preparedOmarchyObservationScript, readPreparedOmarchyVersion } from "../prepared-omarchy-version";

const receipt = { packageVersion: "4.0.6-1", osVersion: "4.0.6", kernelRelease: "7.2.11-arch1-1", observedAt: "2026-11-02T17:00:00Z" };
const line = PREPARED_OMARCHY_VERSION_MARKER + JSON.stringify(receipt);

it("reads the exact observed package, OS and kernel without relabelling it latest", () => {
  expect(readPreparedOmarchyVersion(line)).toEqual(receipt);
  expect(readPreparedOmarchyVersion(line.replaceAll("4.0.6", "4.0.2")).packageVersion).toBe("4.0.2-1");
});

it.each([
  "HIVRA_PREPARED_COMPUTER_READY\n",
  line + "\n" + line,
  PREPARED_OMARCHY_VERSION_MARKER + JSON.stringify({ ...receipt, osVersion: "4.0.0.alpha" }),
  PREPARED_OMARCHY_VERSION_MARKER + JSON.stringify({ ...receipt, osVersion: "4.0.5" }),
  PREPARED_OMARCHY_VERSION_MARKER + JSON.stringify({ ...receipt, privateKey: "must-not-pass" }),
])("refuses missing, duplicate, inconsistent or unexpected version receipts", stdout => {
  expect(() => readPreparedOmarchyVersion(stdout)).toThrow("prepared_omarchy_version_unavailable");
});

it("executes the actual guest observer against package/OS data instead of the stale shared version file", () => {
  const bootstrap = `import pathlib,subprocess\nfrom unittest.mock import patch\nwith patch.object(pathlib.Path,'read_text',return_value='VERSION_ID="4.0.6"\\n') as read, patch.object(subprocess,'check_output',side_effect=['omarchy 4.0.6-1\\n','7.2.11-arch1-1\\n']):\n exec(${JSON.stringify(PREPARED_OMARCHY_GUEST_OBSERVATION)})\n assert read.call_count==1\n`;
  const result = spawnSync("python3", ["-c", bootstrap], { encoding: "utf8" });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(JSON.parse(result.stdout)).toEqual({ packageVersion: "4.0.6-1", osVersion: "4.0.6", kernelRelease: "7.2.11-arch1-1" });
  expect(PREPARED_OMARCHY_GUEST_OBSERVATION).not.toContain("/usr/share/omarchy/version");
});

it("builds only a bounded observation and atomic receipt, with no OS-update command", () => {
  const script = preparedOmarchyObservationScript(2099, "019d13b0-4f19-7f55-9a22-83e72232d8c1");
  expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
  expect(script).toContain("--timeout 6 --synchronous 1");
  expect(script).toContain("os.replace");
  expect(script).not.toContain("omarchy-update");
  expect(script).not.toContain("pacman -S");
  expect(() => preparedOmarchyObservationScript(99, "bad")).toThrow();
});

it("executes the host parser and atomically saves the observed receipt without writing outside its owned fixture", () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "omarchy-observation-"));
  try {
    const fakeBin = path.join(root, "bin");
    fs.mkdirSync(fakeBin);
    const guest = { exited: true, exitcode: 0, "out-data": JSON.stringify({ packageVersion: "4.0.6-1", osVersion: "4.0.6", kernelRelease: "7.2.11-arch1-1" }) };
    fs.writeFileSync(path.join(fakeBin, "qm"), `#!/bin/sh\ncat <<'GUEST'\n${JSON.stringify(guest)}\nGUEST\n`, { mode: 0o755 });
    const script = preparedOmarchyObservationScript(2099, "019d13b0-4f19-7f55-9a22-83e72232d8c1")
      .replace("/var/lib/hivra/omarchy-receipts", path.join(root, "receipts"));
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    const observed = readPreparedOmarchyVersion(result.stdout);
    expect(observed).toEqual(expect.objectContaining({ packageVersion: "4.0.6-1", osVersion: "4.0.6", kernelRelease: "7.2.11-arch1-1" }));
    const receiptPath = path.join(root, "receipts", "2099-019d13b0-4f19-7f55-9a22-83e72232d8c1.observed.json");
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toEqual(observed);
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(root, "receipts"))).toEqual([path.basename(receiptPath)]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
