/** @jest-environment node */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildVmidBoundGuestExecPrelude } from "../vmid-bound-guest-exec";

describe("VMID-bound guest execution", () => {
  it("uses only the selected QGA virtio channel and bounded stdin", () => {
    const prelude = buildVmidBoundGuestExecPrelude();
    expect(prelude).toContain('case "${HIVRA_QGA_RESULT_FILE:-}" in');
    expect(prelude).not.toContain('case "\\${HIVRA_QGA_RESULT_FILE:-}" in');
    expect(prelude).toContain('qm guest exec "$VMID" --timeout 0 -- "$@"');
    expect(prelude).toContain('qm guest exec "$VMID" --timeout 0 --pass-stdin 1 -- "$@"');
    expect(prelude).toContain("HIVRA_QGA_FAILURE result_invalid");
    expect(prelude).toContain("HIVRA_QGA_FAILURE result_too_large");
    expect(prelude).toContain("HIVRA_QGA_FAILURE dispatch_stdin");
    expect(prelude).not.toContain("ssh ");
    expect(prelude).not.toContain("GUEST_IP");
    const syntax = spawnSync("/bin/bash", ["-n"], { encoding: "utf8", input: prelude });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("executes and cleans a successful QGA receipt through the complete generated helper", () => {
    const prelude = buildVmidBoundGuestExecPrelude()
      .replaceAll("/run/hivra-qga-result", "/tmp/hivra-qga-result");
    const run = spawnSync("/bin/bash", ["-c", `
set -Eeuo pipefail
VMID=1112
stat() { printf '32\\n'; }
qm() { printf '%s\\n' '{"exitcode":0,"exited":1}'; }
${prelude}
run_vmid_bound_guest_exec /usr/bin/true
printf 'complete\\n'
`], { encoding: "utf8" });
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({
      status: 0,
      stdout: "complete\n",
      stderr: "",
    });
  });

  it("decodes only a completed QGA result and preserves the guest exit status", () => {
    const prelude = buildVmidBoundGuestExecPrelude();
    const parser = prelude.match(/\/usr\/bin\/perl -MJSON::PP - "\$HIVRA_QGA_RESULT_FILE" <<'HIVRA_QGA_DECODE' \|\| decode_status=\$\?\n([\s\S]+?)\nHIVRA_QGA_DECODE/)?.[1];
    expect(parser).toBeTruthy();

    for (const [document, status, stdout, stderr] of [
      [{ exited: 1, exitcode: 0, "out-data": "ready\n", "err-data": "" }, 0, "ready\n", ""],
      [{ exited: true, exitcode: 0, "out-data": "ready\n", "err-data": "" }, 0, "ready\n", ""],
      [{ exited: 1, exitcode: 17, "out-data": "", "err-data": "failed\n" }, 17, "", "failed\n"],
      [{ exited: 0, exitcode: 0, "out-data": "unsafe\n" }, 125, "", "HIVRA_QGA_FAILURE result_invalid\n"],
      [{ exited: "true", exitcode: 0, "out-data": "unsafe\n" }, 125, "", "HIVRA_QGA_FAILURE result_invalid\n"],
      [{ exited: 1, exitcode: "0", "out-data": "unsafe\n" }, 125, "", "HIVRA_QGA_FAILURE result_invalid\n"],
    ] as const) {
      // Decode a regular file, as the helper does with its mktemp receipt. On
      // Linux spawnSync stdin is a socket, which /dev/stdin cannot open.
      const directory = mkdtempSync(path.join(tmpdir(), "hivra-qga-result-"));
      try {
        const resultFile = path.join(directory, "result.json");
        writeFileSync(resultFile, JSON.stringify(document), { mode: 0o600 });
        const run = spawnSync("/usr/bin/perl", ["-MJSON::PP", "-e", parser!, resultFile], { encoding: "utf8" });
        expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status, stdout, stderr });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
