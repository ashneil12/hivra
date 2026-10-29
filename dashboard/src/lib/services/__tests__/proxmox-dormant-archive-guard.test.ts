/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

import {
  DORMANT_ARCHIVE_NOT_STOPPED_MARKER,
  PROXMOX_VM_IDENTITY_MISMATCH_MARKER,
  buildProxmoxDormantArchiveRemoveScript,
  buildProxmoxDormantArchiveScript,
} from "@/lib/services/proxmox/script-builders";

import {
  GENUINE_GUEST_HOST_KEY,
  createStubProxmoxGuestHost,
  type StubGuestVm,
  type StubProxmoxGuestHost,
} from "@/test-utils/stub-proxmox-guest-host";

const INSTANCE_ID = "00000000-0000-4000-8000-000000001036";
const VMID = 201;

// Stands in for vzdump: records each call and writes the dump file it would
// produce in --dumpdir, so the script's archive-path discovery has something to find.
const VZDUMP_STUB = [
  // Keep the arguments before the loop below shifts them away.
  'args="$*"',
  'dump_dir=""',
  "while [ \"$#\" -gt 0 ]; do",
  '  case "$1" in --dumpdir) dump_dir="$2"; shift ;; esac',
  "  shift",
  "done",
  'echo "$args" >> "$STUB_ROOT/capture/vzdump-calls"',
  'printf vma > "$dump_dir/vzdump-qemu-201-2026_05_14-20_30_00.vma.zst"',
].join("\n");

function guest(overrides: Partial<StubGuestVm>): StubGuestVm {
  return {
    vmid: VMID,
    ip: "10.250.20.201",
    status: "stopped",
    name: `hermes-${INSTANCE_ID}`,
    ...overrides,
  };
}

describe("dormant archive script (host side)", () => {
  let host: StubProxmoxGuestHost;
  let archiveDir: string;

  beforeAll(() => {
    host = createStubProxmoxGuestHost();
  });

  beforeEach(() => {
    archiveDir = fs.mkdtempSync(path.join(host.root, "dump-"));
  });

  afterAll(() => {
    host.cleanup();
  });

  function runArchive(vms: StubGuestVm[]) {
    return host.run(
      buildProxmoxDormantArchiveScript({ vmid: VMID, archiveDir, instanceId: INSTANCE_ID }),
      {
        vms,
        serverHostKey: GENUINE_GUEST_HOST_KEY,
        commands: { vzdump: VZDUMP_STUB, stat: "printf '4096\\n'" },
      }
    );
  }

  function vzdumpCalls(): string[] {
    const file = path.join(host.root, "capture", "vzdump-calls");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  }

  it("refuses a running guest before vzdump runs, so nothing is stopped or dumped", () => {
    const result = runArchive([guest({ status: "running" })]);

    expect(result.status).toBe(45);
    expect(result.stderr).toContain(`${DORMANT_ARCHIVE_NOT_STOPPED_MARKER} ${VMID}`);
    expect(result.stderr).toContain("state=running");
    expect(result.stdout).not.toContain("HERMES_DORMANT_ARCHIVE_PATH=");
    expect(vzdumpCalls()).toEqual([]);
    expect(fs.readdirSync(archiveDir)).toEqual([]);
  });

  it("refuses a paused guest before vzdump runs, not only a running one", () => {
    const result = runArchive([guest({ status: "paused" })]);

    expect(result.status).toBe(45);
    expect(result.stderr).toContain(`${DORMANT_ARCHIVE_NOT_STOPPED_MARKER} ${VMID}`);
    expect(vzdumpCalls()).toEqual([]);
    expect(fs.readdirSync(archiveDir)).toEqual([]);
  });

  it("refuses a VMID that now holds another instance's guest, before vzdump runs", () => {
    // The row is stale: its VMID is a different control plane's guest on a shared host.
    // The dump must not copy that guest under this instance.
    const result = runArchive([
      guest({ status: "stopped", name: "hermes-00000000-0000-4000-8000-000000000999" }),
    ]);

    expect(result.status).toBe(64);
    expect(result.stdout).toContain(`${PROXMOX_VM_IDENTITY_MISMATCH_MARKER} ${VMID}`);
    expect(result.stdout).not.toContain("HERMES_DORMANT_ARCHIVE_PATH=");
    expect(vzdumpCalls()).toEqual([]);
    expect(fs.readdirSync(archiveDir)).toEqual([]);
  });

  it("dumps a guest that is exactly stopped, in stop mode, and reports the archive path", () => {
    const result = runArchive([guest({ status: "stopped" })]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("HERMES_DORMANT_ARCHIVE_PATH=");
    expect(result.stdout).toContain("HERMES_DORMANT_ARCHIVE_SIZE_BYTES=4096");
    expect(result.stderr).not.toContain(DORMANT_ARCHIVE_NOT_STOPPED_MARKER);
    expect(vzdumpCalls()).toHaveLength(1);
    expect(vzdumpCalls()[0]).toContain("--mode stop");
  });
});

describe("dormant archive removal script (host side)", () => {
  let host: StubProxmoxGuestHost;
  let archiveDir: string;

  beforeAll(() => {
    host = createStubProxmoxGuestHost();
  });

  beforeEach(() => {
    archiveDir = fs.mkdtempSync(path.join(host.root, "dump-"));
  });

  afterAll(() => {
    host.cleanup();
  });

  function removeDump(archivePath: string) {
    return host.run(buildProxmoxDormantArchiveRemoveScript({ archiveDir, archivePath }), {
      vms: [],
      serverHostKey: GENUINE_GUEST_HOST_KEY,
    });
  }

  function dumpFile(dir: string, name = "vzdump-qemu-201-2026_05_14-20_30_00.vma.zst"): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "vma");
    return file;
  }

  it("removes an abandoned dump held directly in the archive directory", () => {
    const file = dumpFile(archiveDir);

    const result = removeDump(file);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`HERMES_DORMANT_ARCHIVE_REMOVED ${file}`);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses a dump outside the archive directory and leaves it in place", () => {
    const outsideDir = fs.mkdtempSync(path.join(host.root, "elsewhere-"));
    const file = dumpFile(outsideDir);

    const result = removeDump(file);

    expect(result.status).toBe(46);
    expect(result.stderr).toContain("HERMES_DORMANT_ARCHIVE_REMOVE_REFUSED");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("refuses a path that escapes the archive directory with dot segments", () => {
    const outsideDir = fs.mkdtempSync(path.join(host.root, "elsewhere-"));
    const file = dumpFile(outsideDir);

    // Literal dot segments: path.join would normalise them away before the script sees them.
    const result = removeDump(`${archiveDir}/../${path.basename(outsideDir)}/${path.basename(file)}`);

    expect(result.status).toBe(46);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("refuses a file in the archive directory that is not a vzdump dump", () => {
    const file = dumpFile(archiveDir, "operator-notes.txt");

    const result = removeDump(file);

    expect(result.status).toBe(46);
    expect(fs.existsSync(file)).toBe(true);
  });
});
