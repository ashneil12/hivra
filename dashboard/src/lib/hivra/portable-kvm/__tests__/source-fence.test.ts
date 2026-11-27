import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPortableKvmSourceFenceScript, parsePortableKvmSourceFence } from "../source-fence";

jest.mock("server-only", () => ({}));

const scope = {
  agentId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  generation: 7, hostId: "qa-source", vmid: 9343, bindingTag: `hivra-bind-${"a".repeat(32)}`,
};

function fakeHost(additional = "") {
  const root = mkdtempSync(join(tmpdir(), "hivra-kvm-fence-"));
  for (const dir of ["bin", "state", "pve", "run", "lock"]) mkdirSync(join(root, dir));
  const config = join(root, "pve", "9343.conf");
  writeFileSync(config, `name: test\nonboot: 0\ntags: ${scope.bindingTag}\n${additional}`);
  writeFileSync(join(root, "state", "cold-9343"), `${scope.bindingTag}\n`);
  const put = (name: string, body: string) => writeFileSync(join(root, "bin", name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  put("hostname", 'printf "%s\n" qa-source');
  put("qm", `case "$1" in
    config) cat "$TEST_CONFIG" ;;
    status) printf "%s\\n" "status: stopped" ;;
    set) printf "%s\\n" "lock: backup" >> "$TEST_CONFIG" ;;
    *) exit 99 ;;
  esac`);
  put("stat", 'case "$2" in "%u:%a:%h") echo 0:600:1 ;; *) echo 0:700 ;; esac');
  const run = (input = scope) => spawnSync("bash", ["-c", buildPortableKvmSourceFenceScript(input)
    .replaceAll("/var/lib/hivra-sleep", join(root, "state"))
    .replaceAll("/etc/pve/qemu-server", join(root, "pve"))
    .replaceAll("/run/qemu-server", join(root, "run"))
    .replaceAll("/run/lock", join(root, "lock"))], {
    encoding: "utf8", env: { ...process.env, TEST_CONFIG: config, PATH: `${join(root, "bin")}:${process.env.PATH}` },
  });
  return { run, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

it("fences the exact stopped cold source once and only accepts its exact retry", () => {
  const host = fakeHost();
  try {
    const first = host.run();
    expect(first.status).toBe(0);
    expect(parsePortableKvmSourceFence(first.stdout, scope)).toMatchObject({ ...scope, state: "fenced" });
    expect(host.run().stdout).toBe(first.stdout);
    expect(host.run({ ...scope, generation: 8 }).status).not.toBe(0);
    expect(readFileSync(host.config, "utf8").match(/lock: backup/g)).toHaveLength(1);
  } finally { host.cleanup(); }
});

it.each(["vmstate: local:memory\n", "[PENDING]\nmemory: 4096\n", "lock: backup\n"])(
  "does not adopt a conflicting saved, pending, or already locked source (%s)", config => {
    const host = fakeHost(config);
    try {
      const result = host.run();
      expect(result.status).not.toBe(0);
      expect(parsePortableKvmSourceFence(result.stdout, scope)).toBeNull();
      expect(readFileSync(host.config, "utf8")).toBe(`name: test\nonboot: 0\ntags: ${scope.bindingTag}\n${config}`);
    } finally { host.cleanup(); }
  },
);
