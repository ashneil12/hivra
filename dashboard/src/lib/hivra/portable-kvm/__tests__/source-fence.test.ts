import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

function fakeHost(additional = "", rawCache = "") {
  const root = mkdtempSync(join(tmpdir(), "hivra-kvm-fence-"));
  for (const dir of ["bin", "state", "pve", "run", "lock"]) mkdirSync(join(root, dir));
  const config = join(root, "pve", "9343.conf");
  const current = join(root, "current.conf");
  writeFileSync(config, `name: test\nonboot: 0\ntags: ${scope.bindingTag}\n${additional}`);
  if (rawCache) {
    writeFileSync(current, readFileSync(config, "utf8"));
    writeFileSync(config, readFileSync(current, "utf8") + rawCache);
  }
  writeFileSync(join(root, "state", "cold-9343"), `${scope.bindingTag}\n`);
  const put = (name: string, body: string) => writeFileSync(join(root, "bin", name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  put("hostname", 'printf "%s\n" qa-source');
  put("qm", `case "$1" in
    config) cat "$TEST_CURRENT" ;;
    status) printf "%s\\n" "status: stopped" ;;
    set)
      if [ "$TEST_CURRENT" != "$TEST_CONFIG" ]; then
        sed -i '/^\\[special:cloudinit\\]/i lock: backup' "$TEST_CONFIG"
      fi
      printf "%s\\n" "lock: backup" >> "$TEST_CURRENT" ;;
    *) exit 99 ;;
  esac`);
  put("stat", 'case "$2:$3" in "%u:%a:%h:"*) echo 0:600:1 ;; *"/state") echo 0:755 ;; *) echo 0:700 ;; esac');
  const run = (input = scope, mode: "acquire" | "verify" = "acquire", managed?: Parameters<typeof buildPortableKvmSourceFenceScript>[2]) => spawnSync("bash", ["-c", buildPortableKvmSourceFenceScript(input, mode, managed)
    .replaceAll("/var/lib/hivra-sleep", join(root, "state"))
    .replaceAll("/etc/pve/qemu-server", join(root, "pve"))
    .replaceAll("/run/qemu-server", join(root, "run"))
    .replaceAll("/run/lock", join(root, "lock"))], {
    encoding: "utf8", env: { ...process.env, TEST_CONFIG: config, TEST_CURRENT: rawCache ? current : config,
      PATH: `${join(root, "bin")}:${process.env.PATH}` },
  });
  return { run, config, current, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

it("fences the exact stopped cold source once and only accepts its exact retry", () => {
  const host = fakeHost();
  try {
    expect(host.run(scope, "verify").status).not.toBe(0);
    const first = host.run();
    expect(first.status).toBe(0);
    expect(parsePortableKvmSourceFence(first.stdout, scope)).toMatchObject({ ...scope, state: "fenced" });
    expect(host.run().stdout).toBe(first.stdout);
    expect(host.run(scope, "verify").stdout).toBe(first.stdout);
    expect(host.run({ ...scope, generation: 8 }).status).not.toBe(0);
    expect(readFileSync(host.config, "utf8").match(/lock: backup/g)).toHaveLength(1);
  } finally { host.cleanup(); }
});

it("does not reacquire a lost source lock during read-only verification", () => {
  const host = fakeHost();
  try {
    expect(host.run().status).toBe(0);
    writeFileSync(host.config, readFileSync(host.config, "utf8").replace("lock: backup\n", ""));
    expect(host.run(scope, "verify").status).not.toBe(0);
    expect(readFileSync(host.config, "utf8")).not.toContain("lock: backup");
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

it("fences an exact ordinary generated cache, measures both representations and refuses later drift", () => {
  const allocationOperationId = "00000000-0000-4000-8000-000000000008";
  const managed: NonNullable<Parameters<typeof buildPortableKvmSourceFenceScript>[2]> = {
    allocationOperationId,
    cpu: { vendor: "GenuineIntel", requiredFlags: ["aes", "cx16", "pni", "popcnt", "sse4_1", "sse4_2", "ssse3"] },
    cpuLimit: 2, cloudInit: { instanceId: "c".repeat(40), gateway: "10.251.10.1", nameservers: ["192.0.2.53"] },
    resources: { balloonMb: 4096, cpuUnits: 100 },
  };
  const cache = `\n[special:cloudinit]\ncicustom: vendor=local:snippets/hivra-qga-9343-${allocationOperationId}.yaml\n`;
  const host = fakeHost("memory: 4096\nballoon: 4096\ncpuunits: 100\n", cache);
  try {
    for (const file of [host.current, host.config]) {
      writeFileSync(file, readFileSync(file, "utf8").replace(scope.bindingTag,
        scope.bindingTag + ";hivra-op-" + allocationOperationId.replaceAll("-", "")));
    }
    const proof = host.run(scope, "acquire", managed);
    expect({ status: proof.status, error: proof.stderr }).toEqual({ status: 0, error: "" });
    const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    expect(parsePortableKvmSourceFence(proof.stdout, scope)).toMatchObject({
      configurationSha256: digest(host.current), rawConfigurationSha256: digest(host.config),
    });
    const raw = readFileSync(host.config, "utf8");
    for (const drift of [raw.replace("9343-", "9344-"), raw + "[PENDING]\nonboot: 1\n",
      raw.replace("cpuunits: 100", "cpuunits: 200")]) {
      writeFileSync(host.config, drift);
      expect(host.run(scope, "verify", managed).status).not.toBe(0);
    }
  } finally { host.cleanup(); }
});
