import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildRemoteDesktopCapabilityInspectionScript,
  inspectRemoteDesktopCapability,
  parseRemoteDesktopCapabilityReceipt,
  REMOTE_DESKTOP_BUNDLE_REVISION,
  REMOTE_DESKTOP_CAPABILITY_TTL_MS,
  REMOTE_DESKTOP_SESSION_REVISIONS,
} from "@/lib/remote-computers/capability-inspection";
import {
  buildPreparedOmarchyNativeCapabilityInspectionScript,
  OMARCHY_NATIVE_GUARDIAN_SHA256,
  OMARCHY_NATIVE_INSPECTION_REVISION,
  OMARCHY_NATIVE_OWNERSHIP_SHA256,
  OMARCHY_NATIVE_PREPARED_MARKER,
  OMARCHY_DESKTOP_SESSION_REVISION,
  OMARCHY_WEB_INSTALLER_SHA256,
  OMARCHY_WEB_BROKER_SHA256,
  OMARCHY_WEB_ADAPTER_SHA256,
  OMARCHY_WEB_SERVER_SHA256,
  OMARCHY_WEB_BROKER_ORIGIN,
  parsePreparedOmarchyNativeCapability,
} from "@/lib/remote-computers/omarchy-native-capability";
import {
  WINDOWS_RDP_INSPECTION_REVISION,
  WINDOWS_RDP_PREPARED_MARKER,
} from "@/lib/remote-computers/windows-rdp-capability";

const AGENT_ID = "00000000-0000-4000-8000-000000001041";
const GENERATION = "00000000-0000-4000-8000-000000001044";
const REVISION = REMOTE_DESKTOP_BUNDLE_REVISION;

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "hivra-remote-desktop-capability-v1",
    computerKind: "hivra-agent",
    computerId: AGENT_ID,
    capabilityGeneration: GENERATION,
    bootIdentitySha256: "f".repeat(64),
    observedRevision: REVISION,
    compositor: "x11",
    installedTransports: ["selkies-websocket"],
    privateNetworkReachable: false,
    supportsInputTakeover: true,
    brokerOrigin: "https://agent.example.test",
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    user_id: "user_123",
    type: "linux-desktop",
    computer_profile: "ubuntu-desktop",
    status: "running",
    desired_state: "running",
    operation_id: null,
    operation_kind: null,
    vmid: 1112,
    ip: "10.250.20.62",
    chat_url: "https://agent.example.test/webchat?token=redacted",
    deployment_mode: "hivra-managed",
    proxmox_host: "fixturenode11",
    infrastructure_binding_token_hash: "b".repeat(64),
    infrastructure_binding_token_enforced: true,
    ...overrides,
  };
}

function omarchyDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "hivra-omarchy-native-prepared-v2",
    computerId: AGENT_ID,
    vmid: 1112,
    profile: "omarchy",
    guestPrivateIpv4: "10.250.20.62",
    inspectionRevision: OMARCHY_NATIVE_INSPECTION_REVISION,
    preparationOperationId: "00000000-0000-4000-8000-000000001042",
    serviceOwnerUid: 1000,
    waylandDisplay: "wayland-1",
    omarchyPackageVersion: "4.0.2-1",
    sunshineVersion: "2026.516.143833-4",
    guardianSha256: OMARCHY_NATIVE_GUARDIAN_SHA256,
    ownershipSha256: OMARCHY_NATIVE_OWNERSHIP_SHA256,
    sunshineSha256: "c".repeat(64),
    preparedSha256: "d".repeat(64),
    guestBootId: "00000000-0000-4000-8000-000000001043",
    observedBoottimeNs: "1234567890",
    compositor: "wayland-hyprland",
    webBrokerOrigin: OMARCHY_WEB_BROKER_ORIGIN,
    webSelkiesImage: "ghcr.io/selkies-project/selkies/desktop@sha256:0bfcce1fa30024a8eb34e2504a74e1fb18f4c1424d92c1b6ad6282fb3b1ae87b",
    webNodeImage: "node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",
    route: {
      status: "configured-proven",
      publicIpv4: "198.51.100.11",
      tcpPorts: [47984, 47989, 48010],
      udpPorts: [5353, 47998, 47999, 48000, 48002, 48010],
      sourceCidrs: ["10.242.42.8/32"],
    },
    privateNetworkReachable: true,
    supportsInputTakeover: true,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function windowsDescriptor(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "hivra-windows-rdp-prepared-v1",
    computerId: AGENT_ID,
    vmid: 1112,
    profile: "windows",
    guestPrivateIpv4: "10.250.20.62",
    inspectionRevision: WINDOWS_RDP_INSPECTION_REVISION,
    machineIdentitySha256: "a".repeat(64),
    bootIdentitySha256: "b".repeat(64),
    lastBootAt: new Date(Date.now() - 60_000).toISOString(),
    windowsCaption: "Microsoft Windows 11 Pro",
    windowsVersion: "10.0.26100",
    windowsBuild: "26100",
    licenseStatus: "licensed",
    rdpServiceState: "running",
    rdpServiceStartMode: "auto",
    rdpPort: 3389,
    nla: true,
    listenerVerified: true,
    certificateFingerprint: `sha256:${"c".repeat(64)}`,
    route: {
      status: "configured-not-proven",
      sourceCidrs: ["10.242.42.0/24"],
      exclusive: true,
    },
    privateNetworkReachable: false,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const observed = receipt();
  return {
    loadAgent: jest.fn().mockResolvedValue(agent()),
    resolveContext: jest.fn().mockResolvedValue({
      kind: "managed",
      host: "fixturenode11",
      env: { PROXMOX_SSH_HOST: "192.0.2.11", PROXMOX_PUBLIC_IP: "198.51.100.11" },
      paths: { vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator" },
      infrastructureBindingTag: `hivra-bind-${"b".repeat(32)}`,
      infrastructureBindingTagEnforced: true,
    }),
    runHostScript: jest.fn().mockResolvedValue({
      ok: true,
      stdout: `HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(observed)}\n`,
      stderr: "",
    }),
    recordCapability: jest.fn().mockResolvedValue({ ok: true, generation: GENERATION }),
    ...overrides,
  };
}

describe("remote desktop capability inspection", () => {
  it("keeps Omarchy cursor pixels out of video while preserving local guest shapes", () => {
    const source = (name: string) => readFileSync(path.join(process.cwd(), "provisioner/remote-desktop", name), "utf8");
    expect(source("install-omarchy-web.py")).toContain("SELKIES_ENABLE_CURSORS=true");
    expect(source("install-omarchy-web.py")).toContain("original_native_cursor(self, False)");
    expect(source("omarchy-web-server.cjs")).not.toContain("capturedCursor");
    expect(source("server.cjs")).not.toContain("capturedCursor");
  });
  it("pins the native guardian sources used by session revision admission", () => {
    for (const [file, expected] of [
      ["provisioner/remote-desktop/omarchy-native-supervisor.py", OMARCHY_NATIVE_GUARDIAN_SHA256],
      ["provisioner/remote-desktop/omarchy-sunshine-ownership.py", OMARCHY_NATIVE_OWNERSHIP_SHA256],
      ["provisioner/remote-desktop/install-omarchy-web.py", OMARCHY_WEB_INSTALLER_SHA256],
      ["provisioner/remote-desktop/broker.cjs", OMARCHY_WEB_BROKER_SHA256],
      ["provisioner/remote-desktop/omarchy-web-broker.cjs", OMARCHY_WEB_ADAPTER_SHA256],
      ["provisioner/remote-desktop/omarchy-web-server.cjs", OMARCHY_WEB_SERVER_SHA256],
    ] as const) {
      expect(createHash("sha256").update(readFileSync(path.join(process.cwd(), file))).digest("hex"))
        .toBe(expected);
    }
  });

  it("builds a fixed identity-bound inspection of the guest and container boundary", () => {
    const script = buildRemoteDesktopCapabilityInspectionScript({
      vmid: 1112,
      guestIp: "10.250.20.62",
      infrastructureBindingTag: "hivra-bind-exact",
    });
    expect(script).toContain("qm status \"$VMID\"");
    expect(script).toContain("grep -Fxq \"$EXPECTED_BINDING_TAG\"");
    expect(script).toContain('grep -Fxq "ip=$GUEST_IP/24"');
    expect(script).toContain('qm guest exec "$VMID" --timeout 0 -- "$@"');
    expect(script).toContain("run_vmid_bound_guest_exec /bin/bash -c");
    expect(script.trim().split("\n").at(-1)).not.toContain("run_vmid_bound_guest_exec_stdin");
    expect(script).not.toContain("StrictHostKeyChecking");
    const encodedProgram = script.trim().split("\n").at(-1)?.match(/hivra '([A-Za-z0-9+/=]+)'$/)?.[1];
    expect(encodedProgram).toBeTruthy();
    const program = Buffer.from(encodedProgram!, "base64").toString("utf8");
    expect(program).toContain("fail(label+'_unsafe')");
    expect(program).toContain("root=pathlib.Path('/opt/hivra/remote-desktop')");
    expect(program).toContain("for label,parent in (('opt',pathlib.Path('/opt')),('hivra',pathlib.Path('/opt/hivra')))");
    expect(program).toContain("fail('immutable_parent_'+label+'_missing')");
    expect(program).toContain("fail('immutable_parent_'+label+'_unsafe')");
    expect(program).toContain("fail('immutable_root_unsafe')");
    expect(program).toContain("workspace=pathlib.Path('/home/bux/Hivra')");
    expect(program).toContain("bux_uid=int(run(['/usr/bin/id','-u','bux']");
    expect(program).toContain("stat.S_IMODE(workspace_info.st_mode)!=0o700");
    expect(program).toContain("stat.S_IMODE(info.st_mode)!=mode");
    expect(program).toContain("ghcr.io/selkies-project/selkies-egl-desktop@sha256:6ee5ddc3");
    expect(program).toContain("revision not in COMPATIBLE_RELEASES");
    expect(program).toContain(REMOTE_DESKTOP_BUNDLE_REVISION);
    expect(program).toContain("d['desktopUid']!=bux_uid");
    expect(program).toContain("base_image=json.loads(run(['/usr/bin/docker','image','inspect',d['baseImage']]");
    expect(program).toContain("runtime_image=json.loads(run(['/usr/bin/docker','image','inspect',d['runtimeImageId']]");
    expect(program).toContain("container.get('Image')!=d['runtimeImageId']");
    expect(program).toContain("container.get('Config',{}).get('User')!='ubuntu'");
    expect(program).toContain("container_value(['/usr/bin/id','-u']");
    expect(program).toContain("container_value(['/usr/bin/id','-un']");
    expect(program).toContain("container_value(['/usr/bin/stat','-Lc','%u:%g:%F:%a','/home/ubuntu/Hivra']");
    expect(program).toContain("'io.hivra.remote-desktop.identity-recipe-sha256':d['identityRecipeSha256']");
    expect(program).toContain("validate_identity_recipe(d['identityRecipeSha256'],bux_uid,bux_gid,recipe_variant)");
    expect(program).toContain("runtime_layers[:len(base_layers)]!=base_layers");
    expect(program).toContain("labels!=expected_labels");
    expect(program).toContain("binding!=[{'HostIp':'127.0.0.1','HostPort':'8088'}]");
    expect(program).toContain("container.get('HostConfig',{}).get('Privileged') is not False");
    expect(program).toContain("/var/run/docker.sock");
    expect(program).toContain("mounts[0].get('Source')!='/home/bux/Hivra'");
    expect(program).toContain("if 'docker' in groups");
    expect(program).toContain("http://127.0.0.1:8080/desktop/handoff");
    expect(program).toContain("if health!='200' or handoff!='200' or unauth!='401'");
    expect(program).toContain("HIVRA_CAPABILITY_FAILURE");
    expect(program).toContain("'service_active_'+unit.split('.')[0].replace('-','_')");
    expect(program).toContain("'docker_inspect'");
    const syntax = spawnSync("/usr/bin/python3", ["-c", "import sys;compile(sys.stdin.read(),'<remote-desktop-inspection>','exec')"], {
      encoding: "utf8",
      input: program,
    });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });
    const hostSyntax = spawnSync("/bin/bash", ["-n"], { encoding: "utf8", input: script });
    expect({ status: hostSyntax.status, stderr: hostSyntax.stderr }).toEqual({ status: 0, stderr: "" });
    expect(script).not.toContain("$COMMAND");
  });

  it("binds a normal Ubuntu capability generation to the proven boot without changing provider admission", () => {
    const script = buildRemoteDesktopCapabilityInspectionScript({ vmid: 1112, guestIp: "10.250.20.62", infrastructureBindingTag: "hivra-bind-exact" });
    const encoded = script.trim().split("\n").at(-1)!.match(/hivra '([A-Za-z0-9+/=]+)'$/)![1];
    const program = Buffer.from(encoded, "base64").toString("utf8");
    const fixture = `import ast,hashlib,json,pathlib,re,sys,uuid
from unittest.mock import patch
tree=ast.parse(sys.stdin.read())
selected=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ('fail','boot_capability_identity')]
installed='00000000-0000-4000-8000-000000001005'
boot='019d13b0-4f19-7f55-9a22-83e72232d8c1'
def observe(provider,boot_id=boot,generation=installed,error=None):
    scope=dict(globals(),provider=provider,d={'capabilityGeneration':generation})
    with patch.object(pathlib.Path,'read_text',return_value=boot_id,side_effect=error) as read:
        exec(compile(ast.Module(body=selected,type_ignores=[]),'<boot-generation>','exec'),scope)
        observed=scope['boot_capability_identity'](generation)
        assert read.call_args.args==() and read.call_args.kwargs=={'encoding':'ascii'}
    return observed
first=observe(None)
assert first==observe(None,boot+'\\n')
assert first[0]!=installed
assert first!=observe(None,'018f6d3c-1d91-7c65-9d86-37fc915b8377')
assert first[0]!=observe(None,generation='028f6d3c-1d91-7c65-9d86-37fc915b8378')[0]
assert first[1]==hashlib.sha256(boot.encode('ascii')).hexdigest()
for invalid in ('','unknown','true','019d13b0-4f19-0f55-9a22-83e72232d8c1'):
    try: observe(None,invalid)
    except SystemExit as error: assert error.code==1
    else: raise AssertionError('malformed boot accepted')
try: observe(None,error=OSError('fixture unavailable'))
except SystemExit as error: assert error.code==1
else: raise AssertionError('missing boot accepted')
print('BOOT_GENERATION_PASS')
`;
    const result = spawnSync("python3", ["-I", "-B", "-c", fixture], { encoding: "utf8", input: program });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("BOOT_GENERATION_PASS\n");
    expect(result.stderr).toBe("HIVRA_CAPABILITY_FAILURE guest_boot_id_invalid\n".repeat(4) + "HIVRA_CAPABILITY_FAILURE guest_boot_id_unavailable\n");
  });

  it("independently rejects a substituted recipe receipt and matching runtime label", () => {
    const script = buildRemoteDesktopCapabilityInspectionScript({
      vmid: 1112,
      guestIp: "10.250.20.62",
      infrastructureBindingTag: "hivra-bind-exact",
    });
    const encodedProgram = script.trim().split("\n").at(-1)?.match(/hivra '([A-Za-z0-9+/=]+)'$/)?.[1];
    expect(encodedProgram).toBeTruthy();
    const program = Buffer.from(encodedProgram!, "base64").toString("utf8");
    const helper = program.slice(program.indexOf("SPECIAL_MODE_VALIDATOR="), program.indexOf("\nroot=pathlib.Path"));
    expect(helper).toContain("def validate_identity_recipe");
    const installerPath = path.join(process.cwd(), "provisioner/remote-desktop/install-guest.py");
    const comparison = `
import hashlib,importlib.util,shlex,sys
spec=importlib.util.spec_from_file_location('desktop_guest',sys.argv[1])
guest=importlib.util.module_from_spec(spec); spec.loader.exec_module(guest)
${helper}
def fail(code): raise RuntimeError(code)
for uid,gid in ((1000,1000),(1001,1001),(1001,1000),(1000,1001),(2000,3000)):
 expected=guest.identity_image_recipe(uid,gid)
 assert identity_recipe(uid,gid)==expected
 digest=hashlib.sha256(expected.encode('utf-8')).hexdigest()
 validate_identity_recipe(digest,uid,gid)
 try: validate_identity_recipe('a'*64,uid,gid); raise AssertionError('substituted receipt and label accepted')
 except RuntimeError as error: assert str(error)=='capability_recipe_mismatch'
`;
    const result = spawnSync("python3", ["-I", "-B", "-c", comparison, installerPath], { encoding: "utf8" });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("builds the dormant v3 Omarchy guardian observation on the same VMID-bound runner", () => {
    const script = buildPreparedOmarchyNativeCapabilityInspectionScript({
      computerId: AGENT_ID,
      vmid: 1112,
      guestIp: "10.250.20.62",
      publicIpv4: "198.51.100.11",
      infrastructureBindingTag: `hivra-bind-${"b".repeat(32)}`,
    });
    expect(script).toContain("qm status \"$VMID\"");
    expect(script).toContain("grep -Fxq \"$EXPECTED_BINDING_TAG\"");
    expect(script).toContain('grep -Fxq "ip=$GUEST_IP/24"');
    expect(script).toContain("run_vmid_bound_guest_exec /bin/bash -c");
    const match = script.trim().split("\n").at(-1)
      ?.match(/hivra '([A-Za-z0-9+/=]+)' '([A-Za-z0-9+/=]+)'$/);
    expect(match).toBeTruthy();
    const program = Buffer.from(match![1], "base64").toString("utf8");
    expect(JSON.parse(Buffer.from(match![2], "base64").toString("utf8"))).toEqual({
      computerId: AGENT_ID,
      vmid: 1112,
      guestPrivateIpv4: "10.250.20.62",
      publicIpv4: "198.51.100.11",
      inspectionRevision: OMARCHY_NATIVE_INSPECTION_REVISION,
    });
    expect(program).toContain("omarchy_version=package('omarchy','omarchy_package')");
    expect(program).toContain("package('sunshine','sunshine_package')");
    expect(program).toContain("/usr/local/libexec/hivra/omarchy-native-supervisor.py");
    expect(program).toContain("/usr/local/libexec/hivra/omarchy-sunshine-ownership.py");
    expect(program).toContain("'observe'");
    expect(program).toContain("guardian_active_lease_conflict");
    expect(program).toContain("sunshine_process_conflict");
    expect(program).toContain("sunshine_listener_conflict");
    expect(program).toContain("guardian_source_mismatch");
    expect(program).toContain("guardian_prepared_shape");
    expect(program).toContain("sunshine_admin_exposed");
    expect(program).toContain("if mentioned&({47984,47989,47990,48010,5353,47998,47999,48000,48002}): fail('firewall_destination_ambiguous')");
    expect(program).toContain("continue\n key=(int(match.group(1)),match.group(2))");
    expect(program).toContain("'configured-proven'");
    expect(program).toContain("'privateNetworkReachable':True");
    expect(program).toContain("'supportsInputTakeover':True");
    expect(program).not.toContain("/api/pin");
    const syntax = spawnSync("/usr/bin/python3", ["-c", "import sys;compile(sys.stdin.read(),'<omarchy-native-inspection>','exec')"], {
      encoding: "utf8",
      input: program,
    });
    expect({ status: syntax.status, stderr: syntax.stderr }).toEqual({ status: 0, stderr: "" });
    const hostSyntax = spawnSync("/bin/bash", ["-n"], { encoding: "utf8", input: script });
    expect({ status: hostSyntax.status, stderr: hostSyntax.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("requires the fixed guardian sources before describing any native capability", () => {
    const script = buildPreparedOmarchyNativeCapabilityInspectionScript({
      computerId: AGENT_ID,
      vmid: 1112,
      guestIp: "10.250.20.62",
      publicIpv4: "198.51.100.11",
      infrastructureBindingTag: `hivra-bind-${"b".repeat(32)}`,
    });
    const match = script.trim().split("\n").at(-1)
      ?.match(/hivra '([A-Za-z0-9+/=]+)' '([A-Za-z0-9+/=]+)'$/);
    expect(match).toBeTruthy();
    const program = Buffer.from(match![1], "base64").toString("utf8");
    expect(program).toContain(`guardian_sha!='${OMARCHY_NATIVE_GUARDIAN_SHA256}'`);
    expect(program).toContain(`ownership_sha!='${OMARCHY_NATIVE_OWNERSHIP_SHA256}'`);
    expect(program.indexOf("guardian_source_mismatch"))
      .toBeLessThan(program.indexOf("'observe'"));
    expect(program.indexOf("sunshine_process_conflict"))
      .toBeLessThan(program.indexOf("descriptor={"));
    expect(program.indexOf("guardian_active_lease_conflict"))
      .toBeLessThan(program.indexOf("descriptor={"));
  });

  it("parses a prepared Omarchy descriptor into a proven routed capability receipt", () => {
    const descriptor = omarchyDescriptor();
    const parsed = parsePreparedOmarchyNativeCapability(
      `${OMARCHY_NATIVE_PREPARED_MARKER}${JSON.stringify(descriptor)}\n`,
      { computerId: AGENT_ID, vmid: 1112, guestIp: "10.250.20.62" },
    );
    expect(parsed).toMatchObject({
      descriptor,
      receipt: {
        computerKind: "hivra-agent",
        computerId: AGENT_ID,
        compositor: "wayland",
        installedTransports: ["sunshine-moonlight", "selkies-websocket"],
        privateNetworkReachable: true,
        supportsInputTakeover: true,
        brokerOrigin: OMARCHY_WEB_BROKER_ORIGIN,
      },
    });
    expect(parsed?.receipt.observedRevision).toBe(OMARCHY_DESKTOP_SESSION_REVISION);
    expect(parsed?.receipt.capabilityGeneration).toMatch(/^[0-9a-f-]{36}$/);

    const renewed = parsePreparedOmarchyNativeCapability(
      `${OMARCHY_NATIVE_PREPARED_MARKER}${JSON.stringify({
        ...descriptor,
        observedAt: new Date(Date.now() + 1_000).toISOString(),
        observedBoottimeNs: "1234567999",
      })}\n`,
      { computerId: AGENT_ID, vmid: 1112, guestIp: "10.250.20.62" },
    );
    const changed = parsePreparedOmarchyNativeCapability(
      `${OMARCHY_NATIVE_PREPARED_MARKER}${JSON.stringify({
        ...descriptor,
        preparedSha256: "e".repeat(64),
      })}\n`,
      { computerId: AGENT_ID, vmid: 1112, guestIp: "10.250.20.62" },
    );
    expect(renewed?.receipt.capabilityGeneration).toBe(parsed?.receipt.capabilityGeneration);
    expect(changed?.receipt.capabilityGeneration).not.toBe(parsed?.receipt.capabilityGeneration);
  });

  it.each([
    omarchyDescriptor({ protocol: "hivra-omarchy-native-prepared-v1" }),
    omarchyDescriptor({ token: "not-allowed" }),
    omarchyDescriptor({ computerId: "00000000-0000-4000-8000-000000000001" }),
    omarchyDescriptor({ guardianSha256: "e".repeat(64) }),
    omarchyDescriptor({ observedBoottimeNs: "0" }),
    omarchyDescriptor({ privateNetworkReachable: false }),
    omarchyDescriptor({ supportsInputTakeover: false }),
    omarchyDescriptor({ guestPrivateIpv4: "203.0.113.10" }),
    omarchyDescriptor({ route: { ...omarchyDescriptor().route, sourceCidrs: ["0.0.0.0/0"] } }),
  ])("rejects a non-canonical or over-authoritative prepared Omarchy descriptor", value => {
    expect(parsePreparedOmarchyNativeCapability(
      `${OMARCHY_NATIVE_PREPARED_MARKER}${JSON.stringify(value)}\n`,
      { computerId: AGENT_ID, vmid: 1112, guestIp: "10.250.20.62" },
    )).toBeNull();
  });

  it("keeps the pinned capability revision aligned with the shipped broker bundle", () => {
    const image = "ghcr.io/selkies-project/selkies-egl-desktop@sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa";
    const digest = createHash("sha256")
      .update(readFileSync(path.join(process.cwd(), "provisioner/remote-desktop/install-guest.py")))
      .update(Buffer.from([0]))
      .update(readFileSync(path.join(process.cwd(), "provisioner/remote-desktop/broker.cjs")))
      .update(Buffer.from([0]))
      .update(readFileSync(path.join(process.cwd(), "provisioner/remote-desktop/server.cjs")))
      .update(Buffer.from([0]))
      .update(image, "ascii")
      .digest("hex");
    expect(REMOTE_DESKTOP_BUNDLE_REVISION).toBe(digest);
  });

  it("admits only brokers that bind the selected mode before their first frame", () => {
    const predecessors = ["2026.09.05.4", "2026.09.05.5", "2026.09.06.1", "2026.09.06.2", "2026.09.06.3", "2026.09.07.1"].map(version =>
      JSON.parse(readFileSync(path.join(process.cwd(), `provisioner-releases/${version}.json`), "utf8")));
    expect(REMOTE_DESKTOP_SESSION_REVISIONS).toEqual([
      "2e6b817785d4788e6292087c89e091db6703095b7c196e19ba66a50379618251",
      // Installer-only DPI/CSS policy update retains the exact sealed broker.
      "e97280bea96549d42fc4e25d8b9880d7fcad2722da950c53fd7810c0c866fb56",
      // Native cursor policy is opt-in; existing Ubuntu session behavior stays admitted.
      "9beeb61195795feb78f86196f5a9b059d1b6828adcbd81f1c00d409642b68cfe",
      "dd070b13194107a5621905e5a8e386977cd8b85a6051af4bd3bc152a948866ca",
      "f2707c137c8363f3dfcc539a1f2eade116378c032ef51779c36bc8097b697d46",
      "78be6f62955aceea5e33345e8187efcc4f16fb886c203e54f9ce3ec3b775146e",
      REMOTE_DESKTOP_BUNDLE_REVISION,
      OMARCHY_DESKTOP_SESSION_REVISION,
    ]);
    for (const previous of predecessors) {
      expect(previous.files.find((file: { path: string }) => file.path === "remote-desktop/broker.cjs")?.sha256)
        .toBe("6c7f3b56e4643bf3039c9ea68cdd18e1e3f3a298812e9b384656b10abc264d41");
      expect(previous.files.find((file: { path: string }) => file.path === "remote-desktop/server.cjs")?.sha256)
        .toBe("f67d189ca4e330af38d5607af816119cceb8eba279292bc3bfd9989a4abd866b");
    }
    expect(REMOTE_DESKTOP_SESSION_REVISIONS).not.toContain("fea9cca814b4a1db98585a15c9fc2b589a53f88cb1f3edfd72877879990c6cab");
  });

  it("parses only one exact, fresh, canonical capability receipt", () => {
    const valid = receipt();
    expect(parseRemoteDesktopCapabilityReceipt(`HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(valid)}\n`)).toEqual(valid);
    expect(parseRemoteDesktopCapabilityReceipt("missing\n")).toBeNull();
    expect(parseRemoteDesktopCapabilityReceipt(`HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify({ ...valid, token: "no" })}\n`)).toBeNull();
    expect(parseRemoteDesktopCapabilityReceipt(`HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify({ ...valid, observedRevision: "a".repeat(64) })}\n`)).toBeNull();
    expect(parseRemoteDesktopCapabilityReceipt(`HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify({ ...valid, brokerOrigin: "https://agent.example.test/path" })}\n`)).toBeNull();
    expect(parseRemoteDesktopCapabilityReceipt(`HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify({ ...valid, observedAt: new Date(Date.now() - 121_000).toISOString() })}\n`)).toBeNull();
    expect(parseRemoteDesktopCapabilityReceipt(`HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(valid)}\nHIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(valid)}\n`)).toBeNull();
  });

  it("routes explicit provider Ubuntu through enrolled inspection without a Proxmox VM ID", async () => {
    const inspectProvider = jest.fn().mockResolvedValue({ ok: true, agentId: AGENT_ID, vmid: null });
    const deps = { ...dependencies({ loadAgent: jest.fn().mockResolvedValue(agent({ computer_substrate: "provider-vm",
      computer_profile: "ubuntu-desktop", vmid: null, infrastructure_binding_token_enforced: false })) }), inspectProvider };
    expect(await inspectRemoteDesktopCapability(AGENT_ID, deps as never)).toMatchObject({ ok: true, vmid: null });
    expect(inspectProvider).toHaveBeenCalledWith({ userId: agent().user_id, agentId: AGENT_ID });
    expect(deps.resolveContext).not.toHaveBeenCalled(); expect(deps.runHostScript).not.toHaveBeenCalled();
  });
  it.each(["omarchy", "windows", null])("never adopts provider profile %s as Ubuntu", async profile => {
    const inspectProvider = jest.fn();
    const deps = { ...dependencies({ loadAgent: jest.fn().mockResolvedValue(agent({ computer_substrate: "provider-vm", computer_profile: profile })) }), inspectProvider };
    expect((await inspectRemoteDesktopCapability(AGENT_ID, deps as never)).ok).toBe(false);
    expect(inspectProvider).not.toHaveBeenCalled(); expect(deps.resolveContext).not.toHaveBeenCalled();
  });
  it("fails before infrastructure access for unstable or unbound agents", async () => {
    for (const changed of [
      { status: "provisioning" },
      { desired_state: "deleted" },
      { operation_kind: "restart" },
      { infrastructure_binding_token_enforced: false },
      { ip: "not-an-ip" },
      { chat_url: "http://agent.example.test" },
      { computer_profile: "omarchy", ip: "203.0.113.10" },
    ]) {
      const deps = dependencies({ loadAgent: jest.fn().mockResolvedValue(agent(changed)) });
      const result = await inspectRemoteDesktopCapability(AGENT_ID, deps as never);
      expect(result.ok).toBe(false);
      expect(deps.resolveContext).not.toHaveBeenCalled();
      expect(deps.runHostScript).not.toHaveBeenCalled();
      expect(deps.recordCapability).not.toHaveBeenCalled();
    }
  });

  it("records eight minutes from the proven observation within the ledger's ten-minute maximum", async () => {
    const observed = receipt({ observedAt: new Date(Date.now() - 60_000).toISOString() });
    const deps = dependencies({ runHostScript: jest.fn().mockResolvedValue({
      ok: true, stdout: `HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(observed)}\n`, stderr: "",
    }) });
    const result = await inspectRemoteDesktopCapability(AGENT_ID, deps as never);
    expect(result).toMatchObject({ ok: true, agentId: AGENT_ID, targetId: "fixturenode11", vmid: 1112 });
    expect(deps.runHostScript).toHaveBeenCalledWith(
      expect.stringContaining("VMID=1112"),
      expect.objectContaining({ PROXMOX_SSH_HOST: "192.0.2.11" }),
      {
        timeoutMs: 45_000,
        maxOutputBytes: 16 * 1024,
        earlyFinishMarker: "HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ",
      },
    );
    expect(deps.recordCapability).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_123",
      receipt: expect.objectContaining({ computerId: AGENT_ID, brokerOrigin: "https://agent.example.test" }),
      expiresAt: expect.any(String),
    }));
    const expiresAt = Date.parse(deps.recordCapability.mock.calls[0][0].expiresAt);
    expect(REMOTE_DESKTOP_CAPABILITY_TTL_MS).toBe(8 * 60_000);
    expect(expiresAt).toBe(Date.parse(observed.observedAt) + 8 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.parse(observed.observedAt) + 10 * 60_000);
  });

  it("admits only the exact in-flight preparation operation for its completion inspection", async () => {
    const operation = "77777777-7777-4777-8777-777777777777";
    for (const [kind, option, allowed] of [
      ["desktop_prepare", operation, true], ["desktop_prepare", undefined, false],
      ["desktop_prepare", GENERATION, false], ["restart", operation, false],
    ] as const) {
      const deps = dependencies({ loadAgent: jest.fn().mockResolvedValue(agent({ operation_id: operation, operation_kind: kind })) });
      const result = await inspectRemoteDesktopCapability(AGENT_ID, deps as never, { preparationOperationId: option });
      expect(result.ok).toBe(allowed);
      expect(deps.runHostScript).toHaveBeenCalledTimes(allowed ? 1 : 0);
    }
  });

  it("records prepared Omarchy only after its public route and controlled-input capability are proven", async () => {
    const descriptor = omarchyDescriptor();
    const deps = dependencies({
      loadAgent: jest.fn().mockResolvedValue(agent({ computer_profile: "omarchy", chat_url: null })),
      // Simulate the SSH marker arriving in a chunk before the JSON body.
      // An early-finish request loses that body; waiting for close preserves it.
      runHostScript: jest.fn().mockImplementation(async (_script, _env, options) => ({
        ok: true,
        stdout: options?.earlyFinishMarker
          ? OMARCHY_NATIVE_PREPARED_MARKER
          : `${OMARCHY_NATIVE_PREPARED_MARKER}${JSON.stringify(descriptor)}\n`,
        stderr: "",
      })),
    });

    await expect(inspectRemoteDesktopCapability(AGENT_ID, deps as never)).resolves.toMatchObject({
      ok: true,
      agentId: AGENT_ID,
      targetId: "fixturenode11",
      vmid: 1112,
      nativeDescriptor: descriptor,
      receipt: {
        installedTransports: ["sunshine-moonlight", "selkies-websocket"],
        privateNetworkReachable: true,
        supportsInputTakeover: true,
        brokerOrigin: OMARCHY_WEB_BROKER_ORIGIN,
      },
    });
    expect(deps.runHostScript).toHaveBeenCalledWith(
      expect.stringContaining("VMID=1112"),
      expect.objectContaining({ PROXMOX_SSH_HOST: "192.0.2.11" }),
      expect.not.objectContaining({ earlyFinishMarker: expect.anything() }),
    );
    expect(deps.recordCapability).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_123",
      receipt: expect.objectContaining({
        computerId: AGENT_ID,
        installedTransports: ["sunshine-moonlight", "selkies-websocket"],
        privateNetworkReachable: true,
        supportsInputTakeover: true,
      }),
    }));
  });

  it("can inspect an activation descriptor without replacing the admitted route receipt", async () => {
    const descriptor = omarchyDescriptor();
    const deps = dependencies({
      loadAgent: jest.fn().mockResolvedValue(agent({ computer_profile: "omarchy" })),
      runHostScript: jest.fn().mockResolvedValue({
        ok: true,
        stdout: `${OMARCHY_NATIVE_PREPARED_MARKER}${JSON.stringify(descriptor)}\n`,
        stderr: "",
      }),
    });

    await expect(inspectRemoteDesktopCapability(
      AGENT_ID,
      deps as never,
      { persistReceipt: false },
    )).resolves.toMatchObject({ ok: true, nativeDescriptor: descriptor });
    expect(deps.recordCapability).not.toHaveBeenCalled();
  });

  it("runs the strict Windows RDP inspector without admitting a browser transport", async () => {
    const descriptor = windowsDescriptor();
    const deps = dependencies({
      loadAgent: jest.fn().mockResolvedValue(agent({ computer_profile: "windows" })),
      runHostScript: jest.fn().mockResolvedValue({
        ok: true,
        stdout: `${WINDOWS_RDP_PREPARED_MARKER}${JSON.stringify(descriptor)}\n`,
        stderr: "",
      }),
    });

    await expect(inspectRemoteDesktopCapability(AGENT_ID, deps as never)).resolves.toEqual({
      ok: true,
      agentId: AGENT_ID,
      targetId: "fixturenode11",
      vmid: 1112,
      windowsDescriptor: descriptor,
    });
    expect(deps.runHostScript).toHaveBeenCalledWith(
      expect.stringContaining("VMID=1112"),
      expect.objectContaining({ PROXMOX_SSH_HOST: "192.0.2.11" }),
      { timeoutMs: 45_000, maxOutputBytes: 16 * 1024 },
    );
    expect(deps.recordCapability).not.toHaveBeenCalled();
  });

  it("rejects public Windows guest addressing before infrastructure access", async () => {
    const deps = dependencies({
      loadAgent: jest.fn().mockResolvedValue(agent({ computer_profile: "windows", ip: "203.0.113.10" })),
    });
    await expect(inspectRemoteDesktopCapability(AGENT_ID, deps as never)).resolves.toMatchObject({ ok: false });
    expect(deps.resolveContext).not.toHaveBeenCalled();
    expect(deps.runHostScript).not.toHaveBeenCalled();
    expect(deps.recordCapability).not.toHaveBeenCalled();
  });

  it.each([
    ['#< CLIXML\n<Objs><S S="Error">HIVRA_CAPABILITY_FAILURE inspection_failed_x000D__x000A_</S></Objs>', "guest_inspection_failed"],
    ["HIVRA_QGA_FAILURE result_invalid\nHIVRA_QGA_FAILURE guest_exit_125\n", "qga_result_invalid"],
    ["HIVRA_CAPABILITY_FAILURE private_secret\n", "host_remote_exit_1"],
    ["HIVRA_WINDOWS_INSPECTION_HOST_FAILURE guest_ip_binding\n", "host_phase_guest_ip_binding"],
  ])("reports only allowlisted Windows failure tokens", async (stderr, failure) => {
    const deps = dependencies({
      loadAgent: jest.fn().mockResolvedValue(agent({ computer_profile: "windows" })),
      runHostScript: jest.fn().mockResolvedValue({ ok: false, stdout: "", stderr,
        error: "Remote bash exited with code 1" }),
    });
    await expect(inspectRemoteDesktopCapability(AGENT_ID, deps as never)).resolves.toMatchObject({
      ok: false, error: `Remote desktop capability could not be verified (${failure}).`,
    });
    expect(deps.recordCapability).not.toHaveBeenCalled();
  });

  it.each(["1", "undefined"])("reports bounded Windows remote host exit code %s", async code => {
    const deps = dependencies({
      loadAgent: jest.fn().mockResolvedValue(agent({ computer_profile: "windows" })),
      runHostScript: jest.fn().mockResolvedValue({ ok: false, stdout: "", stderr: "private output",
        error: `Remote bash exited with code ${code}` }),
    });
    await expect(inspectRemoteDesktopCapability(AGENT_ID, deps as never)).resolves.toMatchObject({
      ok: false, error: `Remote desktop capability could not be verified (host_remote_exit_${code}).`,
    });
  });

  it("does not record a receipt from another computer or broker", async () => {
    for (const changed of [
      receipt({ computerId: "00000000-0000-4000-8000-000000000001" }),
      receipt({ brokerOrigin: "https://other.example.test" }),
    ]) {
      const deps = dependencies({
        runHostScript: jest.fn().mockResolvedValue({
          ok: true,
          stdout: `HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(changed)}\n`,
          stderr: "private output",
        }),
      });
      await expect(inspectRemoteDesktopCapability(AGENT_ID, deps as never)).resolves.toMatchObject({
        ok: false,
        error: "Remote desktop capability could not be verified (identity_mismatch).",
      });
      expect(deps.recordCapability).not.toHaveBeenCalled();
    }
  });

  it("reports a legacy UID-mismatched desktop without upgrading or revoking it on inspection", async () => {
    const deps = dependencies({
      runHostScript: jest.fn().mockResolvedValue({
        ok: false,
        stdout: "",
        stderr: "HIVRA_CAPABILITY_FAILURE capability_shape_mismatch\n",
        error: "Remote bash exited with code 1",
      }),
    });
    await expect(inspectRemoteDesktopCapability(AGENT_ID, deps as never)).resolves.toMatchObject({
      ok: false,
      error: "Remote desktop capability could not be verified (guest_capability_shape_mismatch).",
    });
    expect(deps.recordCapability).not.toHaveBeenCalled();
    const inspection = deps.runHostScript.mock.calls[0][0] as string;
    expect(inspection).not.toContain("docker build");
    expect(inspection).not.toContain("docker pull");
    expect(inspection).not.toContain("install-guest.py");
  });

  it("returns only bounded capability failure codes", async () => {
    for (const [hostResult, code] of [
      [{ ok: false, stdout: "", stderr: "HIVRA_CAPABILITY_FAILURE capability_pin_mismatch\n", error: "Remote bash exited with code 1" }, "guest_capability_pin_mismatch"],
      [{ ok: false, stdout: "", stderr: "HIVRA_CAPABILITY_FAILURE container_boundary_mismatch\n", error: "Remote bash exited with code 1" }, "guest_container_boundary_mismatch"],
      [{ ok: false, stdout: "", stderr: "HIVRA_CAPABILITY_FAILURE container_desktop_identity_mismatch\n", error: "Remote bash exited with code 1" }, "guest_container_desktop_identity_mismatch"],
      [{ ok: false, stdout: "", stderr: "private output", error: "Remote bash exited with code 1" }, "guest_remote_exit"],
      [{ ok: true, stdout: "", stderr: "" }, "capability_marker_absent"],
      [{ ok: true, stdout: "HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 {}\n", stderr: "" }, "capability_marker_invalid"],
    ] as const) {
      const deps = dependencies({ runHostScript: jest.fn().mockResolvedValue(hostResult) });
      await expect(inspectRemoteDesktopCapability(AGENT_ID, deps as never)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining(code),
      });
      expect(deps.recordCapability).not.toHaveBeenCalled();
    }
  });
});
