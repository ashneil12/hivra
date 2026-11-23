import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOwnerColdStorageDeleteCommand,
  buildRetentionArchiveTrashCommand,
  COLD_DELETE_STORAGE_RECEIPT,
  COLD_RETENTION_TRASH_RECEIPT,
} from "../cold-storage-delete-command";

const id = "00000000-0000-4000-8000-000000001234";
const neighborId = "00000000-0000-4000-8000-000000004321";
const timestamp = "20261118T090000Z";
const ownedParents = ["free", "paid", "meta", "restic", "daily/free", "daily/paid", "daily-meta"];

describe("cold storage deletion commands", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hivra-storage-delete-"));
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "bin", "ssh"), `#!/usr/bin/env bash
set -efu
[[ "$*" = *"StrictHostKeyChecking=yes"* ]] || exit 30
[[ "$1" = "-n" ]] || exit 31
while [[ "$1" != cold ]]; do shift; done
shift
set -- $1
case "$1 $2" in
  "ls -ld" | "ls -1")
    if [[ "$FAKE_FAILED_PROBE" = "$3" ]]; then
      echo "ssh: connection refused" >&2
      exit 255
    fi
    if [[ ! -e "$3" ]]; then
      printf "/usr/bin/ls: cannot access '%s': No such file or directory\\n" "$3" >&2
      exit 2
    fi
    ;;
  "rm -rf")
    if [[ -n "$FAKE_SKIP_REMOVE" ]]; then
      shift 2
      for path in "$@"; do
        [[ "$path" = "$FAKE_SKIP_REMOVE" ]] || rm -rf -- "$path"
      done
      exit 0
    fi
    ;;
  "mv "*)
    [[ "$FAKE_SKIP_MOVE" = yes ]] && exit 0
    ;;
esac
"$@"
`, { mode: 0o700 });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(path: string) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "sentinel"), "fixture");
  }

  function run(script: string, extra: Record<string, string> = {}) {
    return spawnSync("bash", ["-c", script], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        FAKE_FAILED_PROBE: "",
        FAKE_SKIP_REMOVE: "",
        FAKE_SKIP_MOVE: "",
        ...extra,
      },
    });
  }

  it("erases this instance's archive, backups, and trash without touching adjacent instances, even on retry", () => {
    const paths = [...ownedParents.map((parent) => `${parent}/${id}`), `trash/${id}-${timestamp}`];
    const neighbors = [...ownedParents.map((parent) => `${parent}/${neighborId}`), `trash/${neighborId}-${timestamp}`];
    [...paths, ...neighbors].forEach(fixture);
    const script = buildOwnerColdStorageDeleteCommand(id);

    for (const result of [run(script), run(script)]) {
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(COLD_DELETE_STORAGE_RECEIPT);
    }
    for (const path of paths) expect(existsSync(join(root, path))).toBe(false);
    for (const path of neighbors) expect(existsSync(join(root, path, "sentinel"))).toBe(true);
  });

  it("withholds the receipt if rm silently leaves a directory behind", () => {
    fixture(`restic/${id}`);
    const result = run(buildOwnerColdStorageDeleteCommand(id), { FAKE_SKIP_REMOVE: `restic/${id}` });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain(COLD_DELETE_STORAGE_RECEIPT);
  });

  it("does not treat a failed existence probe as absence", () => {
    const result = run(buildOwnerColdStorageDeleteCommand(id), { FAKE_FAILED_PROBE: `paid/${id}` });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain(COLD_DELETE_STORAGE_RECEIPT);
  });

  it("can safely resume retention after data moved and before the manifest moved", () => {
    fixture(`trash/${id}-${timestamp}/data`);
    fixture(`meta/${id}`);
    const script = buildRetentionArchiveTrashCommand(id, `free/${id}/data-${timestamp}.tar.zst`, timestamp);
    for (const result of [run(script), run(script)]) {
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(COLD_RETENTION_TRASH_RECEIPT);
    }
    expect(existsSync(join(root, `trash/${id}-${timestamp}/meta/sentinel`))).toBe(true);
    expect(existsSync(join(root, `trash/${id}-${timestamp}/data/sentinel`))).toBe(true);
    expect(existsSync(join(root, `meta/${id}`))).toBe(false);
  });

  it("withholds the retention receipt if the archive stayed on its original path", () => {
    fixture(`free/${id}`);
    const script = buildRetentionArchiveTrashCommand(id, `free/${id}/data-${timestamp}.tar.zst`, timestamp);
    const result = run(script, { FAKE_SKIP_MOVE: "yes" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain(COLD_RETENTION_TRASH_RECEIPT);
  });
});
