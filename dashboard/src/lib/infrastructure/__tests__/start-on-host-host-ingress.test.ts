import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The host ingress branch of hivra-start-on-host.sh: when the host runs the
// computer's connector (a route file names this computer's hostname), a start
// must not bring a guest connector back. The branch runs for real; host
// commands (systemctl, nft, ip, curl) and fixed root paths are replaced.

const source = readFileSync(path.join(process.cwd(), "provisioner", "hivra-start-on-host.sh"), "utf8");
const start = source.indexOf('INGRESS_ROUTE="/etc/hivra/ingress/routes/${VMID}.json"');
const end = source.indexOf("# Named-tunnel boxes keep a STABLE URL across restarts");
const branch = source.slice(start, end);

function run(options: { route?: object | null; curlOk?: boolean } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), "hivra-start-ingress-"));
  try {
    const bin = path.join(work, "bin");
    mkdirSync(bin);
    mkdirSync(path.join(work, "ingress/routes"), { recursive: true });
    mkdirSync(path.join(work, "ingress/pins"), { recursive: true });
    for (const name of ["systemctl", "nft", "ip"]) {
      writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${work}/calls"\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
    writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env bash\necho "curl $*" >> "${work}/calls"\nexit ${options.curlOk === false ? 1 : 0}\n`);
    chmodSync(path.join(bin, "curl"), 0o755);
    if (options.route !== null) {
      writeFileSync(path.join(work, "ingress/routes/1107.json"), JSON.stringify(options.route ?? { hostname: "box-1107.example.test" }));
    }
    writeFileSync(path.join(work, "ingress/pins/1107.nft"), "add table bridge hivra_ingress_pin\n");
    writeFileSync(path.join(work, "ingress/pins/1107.neigh"), "10.250.20.7 bc:24:11:aa:bb:cc vmbr9\n");
    const harness = `set -euo pipefail
VMID=1107
IP=10.250.20.7
HIVRA_TUNNEL_URL=https://box-1107.example.test
publish_result() { printf 'RESULT %s\\n' "$1"; }
seq() { echo 1; }
sleep() { :; }
${branch.replaceAll("/etc/hivra/ingress", `${work}/ingress`)}
echo FELL_THROUGH
`;
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    let calls = "";
    try { calls = readFileSync(path.join(work, "calls"), "utf8"); } catch { /* none */ }
    return { ...result, calls };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("hivra-start-on-host.sh host ingress branch", () => {
  it("finds the branch before the named-tunnel restart", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("skips the guest tunnel restart, re-applies the pin and starts the host connector", () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RESULT {"vmid":1107,"ip":"10.250.20.7","chat_url":"https://box-1107.example.test","ready":true}');
    expect(result.stdout).not.toContain("FELL_THROUGH");
    expect(result.calls).toContain("systemctl start hivra-cf@1107.service");
    expect(result.calls).toContain("nft -f");
    expect(result.calls).toContain("ip neigh replace 10.250.20.7 lladdr bc:24:11:aa:bb:cc dev vmbr9 nud permanent");
    expect(result.calls).not.toContain("hivra-cf-tunnel");
  });

  it("reports not ready when the public address does not answer", () => {
    const result = run({ curlOk: false });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('"ready":false,"error":"host ingress health check timed out"');
  });

  it("falls through to the existing path with no route, or a route for another hostname", () => {
    expect(run({ route: null }).stdout).toContain("FELL_THROUGH");
    const other = run({ route: { hostname: "other.example.test" } });
    expect(other.stdout).toContain("FELL_THROUGH");
    expect(other.calls).toBe("");
  });
});
