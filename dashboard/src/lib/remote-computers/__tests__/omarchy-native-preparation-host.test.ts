jest.mock("server-only", () => ({}));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveHivraAgentExecutionContext, type HivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import type { RemoteDesktopAgentRow } from "../guest-installation";
import {
  buildOmarchyNativePreparationHostScript,
  loadOmarchyNativeGuardianBundle,
  OMARCHY_NATIVE_INSTALL_PROGRAM,
  prepareOmarchyNativeGuardian,
  type OmarchyNativePreparationBinding,
  type OmarchyNativePreparationRequest,
} from "../omarchy-native-preparation-host";
import {
  OMARCHY_NATIVE_GUARDIAN_SHA256,
  OMARCHY_NATIVE_OWNERSHIP_SHA256,
  OMARCHY_NATIVE_PREVIOUS_GUARDIAN_SHA256,
  OMARCHY_WEB_SERVER_SHA256,
} from "../omarchy-native-capability";

const USER_ID = "user_fixture";
const request: OmarchyNativePreparationRequest = {
  computerId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  vmid: 2099,
  guestPrivateIpv4: "10.240.20.99",
};
const binding: OmarchyNativePreparationBinding = {
  ...request,
  ownerUid: 1000,
  waylandDisplay: "wayland-1",
};
const agent: RemoteDesktopAgentRow = {
  id: binding.computerId, user_id: USER_ID, type: "linux-desktop", computer_profile: "omarchy",
  status: "running", desired_state: "running", operation_id: binding.operationId,
  operation_kind: "desktop_prepare", vmid: binding.vmid, ip: binding.guestPrivateIpv4,
  chat_url: "https://fixture.invalid", infrastructure_binding_token_hash: "9".repeat(64),
  infrastructure_binding_token_enforced: true,
};
const context: HivraAgentExecutionContext = {
  kind: "managed", host: "fixture", provisionerChannel: "canary",
  infrastructureBindingTagEnforced: true, infrastructureBindingTag: "hivra-bind-" + "9".repeat(32),
  env: { TEST_HOST: "owned" }, paths: { provisionerDirectory: "/fixture/provisioner",
    logDirectory: "/fixture/logs", provisionLogPrefix: "hivra-prov-", startLogPrefix: "hivra-start-",
    storage: "fixture-storage", vmSshKeyPath: null },
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValue(context);
});

it("loads the exact canonical guardian source bundle", async () => {
  const bundle = await loadOmarchyNativeGuardianBundle();
  expect(createHash("sha256").update(bundle.guardian).digest("hex")).toBe(OMARCHY_NATIVE_GUARDIAN_SHA256);
  expect(createHash("sha256").update(bundle.ownership).digest("hex")).toBe(OMARCHY_NATIVE_OWNERSHIP_SHA256);
  expect(bundle.guardian.subarray(0, 22).toString()).toContain("python3");
});

it("builds a bounded VMID-bound source installation and dormant preparation", async () => {
  const bundle = await loadOmarchyNativeGuardianBundle();
  const script = buildOmarchyNativePreparationHostScript(request, context.infrastructureBindingTag, bundle);
  expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8", timeout: 5_000 }).status).toBe(0);
  expect(spawnSync("python3", ["-c", "import sys;compile(sys.stdin.read(),'<install>','exec')"], {
    input: OMARCHY_NATIVE_INSTALL_PROGRAM, encoding: "utf8", timeout: 5_000,
  }).status).toBe(0);
  expect(script).toContain(`VMID=${binding.vmid}`);
  expect(script).toContain('grep -Fxq "$EXPECTED_BINDING_TAG"');
  expect(script).toContain('qm guest exec "$VMID" --timeout 0 --pass-stdin 1 -- "$@"');
  expect(script).toContain("run_vmid_bound_guest_exec_stdin /usr/bin/python3");
  expect(script.indexOf('grep -Fxq "$EXPECTED_BINDING_TAG"'))
    .toBeLessThan(script.lastIndexOf("run_vmid_bound_guest_exec_stdin"));
  expect(script).not.toContain("ssh ");
  expect(OMARCHY_NATIVE_INSTALL_PROGRAM).toContain("os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW");
  expect(OMARCHY_NATIVE_INSTALL_PROGRAM).toContain("installed_source_conflict");
  expect(OMARCHY_NATIVE_INSTALL_PROGRAM).toContain("os.replace(replacement,path)");
  expect(script).toContain(OMARCHY_NATIVE_PREVIOUS_GUARDIAN_SHA256);
  expect(OMARCHY_NATIVE_INSTALL_PROGRAM).toContain("environment.get(b'XDG_RUNTIME_DIR')!=str(runtime).encode()");
  expect(OMARCHY_NATIVE_INSTALL_PROGRAM).toContain("stat.S_ISSOCK(info.st_mode)");
  expect(OMARCHY_NATIVE_INSTALL_PROGRAM).toContain("if len(displays)==1: sessions.append((uid,displays[0]))");
  expect(OMARCHY_NATIVE_INSTALL_PROGRAM).toContain("'prepare'");
  expect(OMARCHY_NATIVE_INSTALL_PROGRAM).toContain("'computerId':binding['computerId'],'guestPrivateIpv4':binding['guestPrivateIpv4']");
  expect(OMARCHY_NATIVE_INSTALL_PROGRAM).not.toContain("web_request={**binding");
  expect(Buffer.byteLength(script)).toBeLessThan(250_000);
});

it("executes one exact preparation and accepts only its bound receipt", async () => {
  const stdout = "HIVRA_OMARCHY_NATIVE_PREPARATION_V1 " + JSON.stringify({
    protocol: "hivra-omarchy-native-guardian-preparation-v3", binding,
    administrationPrepared: true, activation: "forbidden", desktopReady: false,
  }) + "\n";
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: true, stdout, stderr: "" });
  expect(await prepareOmarchyNativeGuardian(USER_ID, agent, request)).toEqual({
    ok: true, targetId: context.host, vmid: binding.vmid, binding,
  });
  expect(runProxmoxHostScript).toHaveBeenCalledWith(
    expect.stringContaining(`VMID=${binding.vmid}`), context.env,
    { timeoutMs: 90_000, maxOutputBytes: 32_768, earlyFinishMarker: "HIVRA_OMARCHY_NATIVE_PREPARATION_V1 " },
  );

  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({
    ok: true, stdout: stdout.replace(binding.operationId, binding.computerId), stderr: "",
  });
  expect(await prepareOmarchyNativeGuardian(USER_ID, agent, request)).toEqual({ ok: false, code: "invalid_result" });
});

it("rejects stale or changed execution authority before source loading", async () => {
  const loadBundle = jest.fn(loadOmarchyNativeGuardianBundle);
  for (const changed of [
    { ...agent, user_id: "other" },
    { ...agent, computer_profile: "ubuntu-desktop" },
    { ...agent, status: "stopped" },
    { ...agent, operation_id: null },
    { ...agent, operation_kind: null },
    { ...agent, vmid: 2098 },
    { ...agent, ip: "10.240.20.98" },
    { ...agent, infrastructure_binding_token_hash: null },
  ]) {
    expect(await prepareOmarchyNativeGuardian(USER_ID, changed, request, { loadBundle })).toEqual({
      ok: false, code: "invalid_target",
    });
  }
  expect(loadBundle).not.toHaveBeenCalled();
  expect(resolveHivraAgentExecutionContext).not.toHaveBeenCalled();
  expect(runProxmoxHostScript).not.toHaveBeenCalled();
});

it("refuses changed host binding and uncertain transport without retrying", async () => {
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValueOnce({
    ...context, infrastructureBindingTag: "hivra-bind-" + "8".repeat(32),
  });
  expect(await prepareOmarchyNativeGuardian(USER_ID, agent, request)).toEqual({
    ok: false, code: "authority_unavailable",
  });
  expect(runProxmoxHostScript).not.toHaveBeenCalled();

  jest.mocked(runProxmoxHostScript).mockRejectedValueOnce(new Error("private details"));
  expect(await prepareOmarchyNativeGuardian(USER_ID, agent, request)).toEqual({
    ok: false, code: "transport_failed", reason: "host_exception",
  });
  expect(runProxmoxHostScript).toHaveBeenCalledTimes(1);

  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({
    ok: false, stdout: "", stderr: "", error: "SSH connection failed: refused",
  });
  expect(await prepareOmarchyNativeGuardian(USER_ID, agent, request)).toEqual({
    ok: false, code: "transport_failed", reason: "host_ssh",
  });
});

// Preparation is what converges a guest onto the pinned release. If it refuses
// to replace content that is not a pre-named predecessor, any local edit to a
// runtime file becomes permanent: the capability inspector fails on the same
// mismatch, so refresh cannot clear it and prepare cannot either. Run the
// shipped install helper rather than asserting on script text, and use content
// the repo has never seen so the outcome cannot depend on a known hash.
it("converges a runtime file onto the pinned bytes whatever the guest currently holds", () => {
  const provisioner = path.join(process.cwd(), "provisioner", "remote-desktop");
  const committedPath = path.join(provisioner, "omarchy-web-server.cjs");
  const committed = readFileSync(committedPath);
  expect(createHash("sha256").update(committed).digest("hex")).toBe(OMARCHY_WEB_SERVER_SHA256);

  const program = OMARCHY_NATIVE_INSTALL_PROGRAM;
  const helper = program.slice(
    program.indexOf("def sync_directory("),
    program.indexOf("safe_directory(pathlib.Path('/usr/local'))"),
  );
  expect(program).not.toContain("OMARCHY_WEB_SERVER_PREVIOUS_SHA256");
  expect(program).toContain("install(root/'omarchy-web-server.cjs',web_server,0o644,converge=True)");
  expect(helper).toContain("installed_source_conflict");

  // The guest runs this program as root against root-owned files, so the
  // ownership half of the guard is reproduced here to exercise the content half
  // that decides the outcome. The helper's atomic replace also needs the Path
  // type and the `expected` mapping the real program defines before these calls.
  const script = [
    "import hashlib,os,pathlib,stat,sys",
    "def fail(code):",
    "    print('HIVRA_PREPARATION_FAILURE '+code,file=sys.stderr); raise SystemExit(1)",
    "_real_fstat=os.fstat",
    "class _RootOwned:",
    "    def __init__(self,st): self._st=st",
    "    def __getattr__(self,name):",
    "        if name in ('st_uid','st_gid'): return 0",
    "        return getattr(self._st,name)",
    "os.fstat=lambda fd:_RootOwned(_real_fstat(fd))",
    "expected={'operationId':'fixture-operation'}",
    helper,
    "data=open(sys.argv[1],'rb').read()",
    "seed=open(sys.argv[2],'rb').read()",
    "converge=(sys.argv[3]=='converge')",
    "directory=pathlib.Path(__import__('tempfile').mkdtemp())",
    "path=directory/'omarchy-web-server.cjs'",
    "path.write_bytes(seed);os.chmod(path,0o644 if len(sys.argv)<5 else int(sys.argv[4],8))",
    "was_current = path.read_bytes()==data and stat.S_IMODE(os.stat(path).st_mode)==0o644",
    "try:",
    "    install(path,data,0o644,(),converge)",
    "    print('ALREADY-CURRENT' if was_current else 'APPLIED')",
    "except SystemExit:",
    "    print('REFUSED')",
    "print(hashlib.sha256(path.read_bytes()).hexdigest())",
  ].join("\n");
  const scratch = mkdtempSync(path.join(tmpdir(), "omarchy-prepare-"));
  const runInstall = (seed: string, converge: boolean, mode?: string) => {
    const seedPath = path.join(scratch, "candidate-runtime.cjs");
    writeFileSync(seedPath, seed);
    const args = ["-c", script, committedPath, seedPath, converge ? "converge" : "strict"];
    if (mode) args.push(mode);
    const result = spawnSync("python3", args, { encoding: "utf8" });
    return result.stdout.trim().split("\n");
  };

  // Content the repo has never seen, so this cannot pass by knowing the hash.
  const unknown = "// locally edited build\n" + committed.toString("utf8");
  const converged = runInstall(unknown, true);
  expect(converged[1]).toBe("APPLIED");
  expect(converged[2]).toBe(OMARCHY_WEB_SERVER_SHA256);
  // The replaced content is reported so the repair is auditable rather than
  // silent. It is emitted on stdout, and parseResult only reads MARKER lines.
  expect(converged[0]).toMatch(/^HIVRA_PREPARATION_REPLACED omarchy-web-server\.cjs [a-f0-9]{64}$/);
  expect(converged[0]).not.toContain(OMARCHY_WEB_SERVER_SHA256);

  // Already-pinned content stays untouched and is not reported as replaced.
  expect(runInstall(committed.toString("utf8"), true))
    .toEqual(["ALREADY-CURRENT", OMARCHY_WEB_SERVER_SHA256]);

  // The strict path still refuses unknown content and leaves it in place, so
  // this is a deliberate convergence at the prepare call sites rather than a
  // blanket relaxation of install().
  const refused = runInstall(unknown, false);
  expect(refused[0]).toBe("REFUSED");
  expect(refused[1]).not.toBe(OMARCHY_WEB_SERVER_SHA256);

  // A mode-only drift is the other way this guard rejects a guest. It is the
  // same failure to a caller, and convergence has to clear it too.
  expect(runInstall(committed.toString("utf8"), true, "600")[1]).toBe("APPLIED");
  expect(runInstall(committed.toString("utf8"), false, "600")[0]).toBe("REFUSED");
});
