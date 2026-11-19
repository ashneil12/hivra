/** @jest-environment node */
jest.mock("server-only", () => ({}));
// Stop only at the VMID-scoped QGA dispatch boundary. Execute the complete
// generated host preflight with real bash/grep and fake read-only qm/nft tools.
jest.mock("@/lib/hivra/vmid-bound-guest-exec", () => ({
  buildVmidBoundGuestExecPrelude: () => `run_vmid_bound_guest_exec() {
    printf 'VM=%s NATIVE_ROUTE_PROVEN=%s\\n' "$VMID" "${"$"}{@: -1}"
  }`,
}));

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPreparedOmarchyNativeCapabilityInspectionScript } from "../omarchy-native-capability";

const binding = `hivra-bind-${"b".repeat(32)}`;
const guestIp = "10.240.20.62";
const nativeRoutes = (ip: string) => [
  `ip daddr 203.0.113.9 tcp dport { 47984, 47989, 48010 } dnat to ${ip}`,
  `ip daddr 203.0.113.9 udp dport { 47998, 47999, 48000, 48002, 48010 } dnat to ${ip}`,
  `ip daddr ${ip} tcp dport { 47984, 47989, 48010 } accept`,
  `ip daddr ${ip} udp dport { 47998, 47999, 48000, 48002, 48010 } accept`,
].join("\n");

function inspect(mode: "browser" | "native", options: {
  routes?: string; tag?: string; ip?: string; running?: boolean;
} = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "omarchy-readiness-"));
  try {
    writeFileSync(path.join(directory, "qm"), `#!/bin/bash
case "$1" in
  status) printf '%s\\n' 'status: ${options.running === false ? "stopped" : "running"}' ;;
  config) printf '%s\\n' 'tags: ${options.tag ?? binding}' 'ipconfig0: ip=${options.ip ?? guestIp}/24,gw=10.240.20.1' ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
    writeFileSync(path.join(directory, "nft"), `#!/bin/bash
cat <<'RULES'
${options.routes ?? nativeRoutes("10.240.20.63")}
RULES
`, { mode: 0o700 });
    return spawnSync("/bin/bash", ["-s"], {
      encoding: "utf8", timeout: 5_000,
      env: { ...process.env, PATH: `${directory}:/usr/bin:/bin` },
      input: buildPreparedOmarchyNativeCapabilityInspectionScript({
        computerId: "11111111-1111-4111-8111-111111111111", vmid: 2222,
        guestIp, publicIpv4: "203.0.113.9", infrastructureBindingTag: binding,
        inspectionMode: mode,
      }),
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

it("admits browser inspection when a different guest owns the native ports, without claiming native proof", () => {
  const result = inspect("browser");
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr })
    .toEqual({ status: 0, stdout: "VM=2222 NATIVE_ROUTE_PROVEN=0\n", stderr: "" });
});

it("refuses native inspection when another guest owns the exclusive routes", () => {
  const result = inspect("native");
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
});

it.each(["browser", "native"] as const)("preserves native proof in %s mode when all exact guest routes exist", mode => {
  const result = inspect(mode, { routes: nativeRoutes(guestIp) });
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr })
    .toEqual({ status: 0, stdout: "VM=2222 NATIVE_ROUTE_PROVEN=1\n", stderr: "" });
});

it.each([
  { tag: `hivra-bind-${"c".repeat(32)}` },
  { ip: "10.240.20.63" },
  { running: false },
  { routes: `${nativeRoutes(guestIp)}\ntcp dport 47990 accept` },
])("keeps the browser authority and admin exposure checks fail-closed: %j", options => {
  const result = inspect("browser", options);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
});

it("never proves native reachability from only a partial set of matching routes", () => {
  const routes = nativeRoutes(guestIp).split("\n").slice(0, -1).join("\n");
  expect(inspect("browser", { routes }).stdout).toBe("VM=2222 NATIVE_ROUTE_PROVEN=0\n");
  expect(inspect("native", { routes }).status).toBe(1);
});

it("rejects exposed administration even when the ruleset exceeds the shell pipe buffer", () => {
  const routes = "tcp dport 47990 accept\n" + "# padding\n".repeat(20_000);
  const result = inspect("browser", { routes });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("sunshine_admin_exposed");
});
