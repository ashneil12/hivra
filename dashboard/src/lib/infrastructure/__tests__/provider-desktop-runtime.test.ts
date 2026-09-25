import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { buildProviderDesktopRuntimeProbe, parseProviderDesktopRuntimeReceipt, buildProviderDesktopPowerProbe, parseProviderDesktopPowerReceipt,
  buildProviderWorkspaceRuntimeProbe, parseProviderWorkspaceRuntimeReceipt } from "../provider-desktop-runtime";
// The fixture identity is bound to the current release, so install its gateway files.
import workspaceRelease from "../../../../provisioner-releases/2026.09.24.2.json";
import { desktopInstallFixture } from "@/lib/hivra/__tests__/provider-desktop-install.fixtures";
import { REMOTE_DESKTOP_BUNDLE_REVISION } from "@/lib/remote-computers/capability-inspection";
import { parseProviderDesktopWorkerIdentity } from "../provider-desktop-worker";

const f=desktopInstallFixture();
const input={identity:f.identity,access:{mode:"cloudflare-named" as const,hostname:f.context.hostname!,tunnelId:f.context.tunnelId!}};
const receipt=()=>({protocol:"hivra-remote-desktop-capability-v1",computerKind:"hivra-agent",computerId:f.op.agentId,
  capabilityGeneration:f.clock.bootId,observedRevision:REMOTE_DESKTOP_BUNDLE_REVISION,compositor:"x11",
  installedTransports:["selkies-websocket"],privateNetworkReachable:false,supportsInputTakeover:true,
  brokerOrigin:`https://${input.access.hostname}`,observedAt:new Date().toISOString()});
const wire=(value:unknown)=>`HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ${JSON.stringify(value)}\n`;
const workspaceInput = { ...input, controlOrigin: "https://canary.hermesos.cloud" };
it.each([
  ["2026.09.06.2", "9ace71d709cb9aabd27f188c3a6f6ca98fe906d619f156a1b47928fa22c54aee", "2e60747237245c7e71912851a11992b7768ef7c99986d2bb52f35360cf1c6711"],
  ["2026.09.06.3", "5ea99797e6a1f7b105d1af07c191585c386df5590bd65a3389f045a41466dbef", "19b21b088b11eef767673001117afb4987d2de28600a4c1fb7dffe3c44840a52"],
])("retains %s runtime and workspace evidence after the inventory correction", (version, bundle, worker) => {
  const identity = parseProviderDesktopWorkerIdentity({ ...f.identity, bundle: { ...f.identity.bundle,
    provisionerVersion: version, bundleSha256: bundle } });
  const retained = { ...workspaceInput, identity };
  const script = buildProviderWorkspaceRuntimeProbe(retained);
  expect(script).toContain(worker);
  const original = { ...receipt(), observedRevision: "a864b6827ded1f10ffce4129ded4a97fb83d7ea4379e02d99459726d8b7e99db" };
  expect(() => parseProviderDesktopRuntimeReceipt(wire(receipt()), retained)).toThrow();
  expect(() => parseProviderDesktopRuntimeReceipt(wire(original), retained)).not.toThrow();
  expect(() => parseProviderWorkspaceRuntimeReceipt(`HIVRA_PROVIDER_WORKSPACE_V1 ${JSON.stringify({ protocol: "hivra-workspace-v1",
    computerId: f.op.agentId, operationId: f.op.operationId, publicOrigin: `https://${input.access.hostname}`,
    controlOrigin: retained.controlOrigin, capabilityOutput: wire(original) })}\n`, retained)).not.toThrow();
});
it.each(["runtime", "power", "workspace"])("accepts .06.1's original exact receipt for retained %s, not another release", surface => {
  const identity = parseProviderDesktopWorkerIdentity({ ...f.identity, bundle: { ...f.identity.bundle,
    provisionerVersion: "2026.09.06.1", bundleSha256: "61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c" } });
  const retained = { ...workspaceInput, identity };
  const capability = { ...receipt(), observedRevision: "a3b299a308848f68063e4915219a1343bddf9550fabd80dc5be54384c3cd2f42" };
  const parse = (value: ReturnType<typeof receipt>) => {
    if (surface === "runtime") return parseProviderDesktopRuntimeReceipt(wire(value), retained);
    if (surface === "power") return parseProviderDesktopPowerReceipt(`HIVRA_PROVIDER_DESKTOP_POWER_V1 ${JSON.stringify({ bootId: f.op.operationId, capabilityOutput: wire(value) })}\n`, retained);
    return parseProviderWorkspaceRuntimeReceipt(`HIVRA_PROVIDER_WORKSPACE_V1 ${JSON.stringify({ protocol: "hivra-workspace-v1",
      computerId: f.op.agentId, operationId: f.op.operationId, publicOrigin: `https://${input.access.hostname}`,
      controlOrigin: retained.controlOrigin, capabilityOutput: wire(value) })}\n`, retained);
  };
  expect(() => parse(capability)).not.toThrow();
  expect(() => parse(receipt())).toThrow();
  expect(() => parseProviderDesktopRuntimeReceipt(wire(capability), input)).toThrow();
});
it("observes retained .05.9 workspace against its original manifest, never the new Node release", () => {
  const identity = parseProviderDesktopWorkerIdentity({ ...f.identity, bundle: { ...f.identity.bundle,
    provisionerVersion: "2026.09.05.9", bundleSha256: "89b5e64591d3cff0f2a4f28460ee9075221946ed37694ec5eb566c5a40af4127" } });
  const script = buildProviderWorkspaceRuntimeProbe({ ...workspaceInput, identity });
  expect(script).toContain("fc03785b18ddc8681a868c6cd7e6e1cda8b2fed97971af0909eb148c92db04d4");
  expect(script).not.toContain("b0838bdc61079929144590cc8f606f2ad22db35d4fa9062920548884d92f032c");
});
it("executes installed workspace observations and suppresses credentials across failures", () => {
  const script = buildProviderWorkspaceRuntimeProbe(workspaceInput);
  const manifest = JSON.parse(Buffer.from(script.match(/MANIFEST=json.loads\(base64.b64decode\("([A-Za-z0-9+/=]+)"/)![1], "base64").toString());
  const result = spawnSync("/usr/bin/python3", ["-I", "-B", "scripts/test-provider-desktop-runtime.py"], {
    encoding: "utf8", timeout: 15_000, input: JSON.stringify({ script, manifest, identity: f.identity, workspace: true,
      origin: `https://${input.access.hostname}`, workspaceFiles: Object.fromEntries(workspaceRelease.files
        .filter(file => file.path.startsWith("hivra-chat/")).map(file => [file.path.slice(11), readFileSync(`provisioner/${file.path}`).toString("base64")])),
      owner: readFileSync("provisioner/remote-desktop/provider-service-owner.py").toString("base64"),
      worker: readFileSync("provisioner/hivra-provider-worker.py").toString("base64") }),
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(result.stdout).toContain("30 generated-probe cases");
});
it.each(["clean", "protocol", "operation", "control", "extra", "duplicate", "desktop-only"])("binds workspace receipt: %s", fault => {
  const value: Record<string, unknown> = { protocol: "hivra-workspace-v1", computerId: f.op.agentId, operationId: f.op.operationId,
    publicOrigin: `https://${input.access.hostname}`, controlOrigin: workspaceInput.controlOrigin, capabilityOutput: wire(receipt()) };
  if (fault === "protocol") value.protocol = "unknown";
  if (fault === "operation") value.operationId = f.op.agentId;
  if (fault === "control") value.controlOrigin = "https://wrong.example.test";
  if (fault === "extra") value.token = "must-not-escape";
  const output = `HIVRA_PROVIDER_WORKSPACE_V1 ${JSON.stringify(value)}\n`;
  const parse = () => parseProviderWorkspaceRuntimeReceipt(fault === "desktop-only" ? wire(receipt()) : output + (fault === "duplicate" ? output : ""), workspaceInput);
  if (fault === "clean") expect(parse()).toMatchObject({ protocol: "hivra-workspace-v1", computerId: f.op.agentId,
    capability: { protocol: "hivra-remote-desktop-capability-v1", computerId: f.op.agentId } });
  else expect(parse).toThrow("Invalid provider workspace runtime receipt");
});
it.each([false,true])("executes the generated ownership probe with power=%s using real private files and substituted OS observations",captureBootId=>{
  const script=captureBootId?buildProviderDesktopPowerProbe(input):buildProviderDesktopRuntimeProbe(input);
  const manifest=JSON.parse(Buffer.from(script.match(/MANIFEST=json.loads\(base64.b64decode\("([A-Za-z0-9+/=]+)"/)![1],"base64").toString());
  const result=spawnSync("/usr/bin/python3",["-I","-B","scripts/test-provider-desktop-runtime.py"],{
    encoding:"utf8",timeout:15_000,input:JSON.stringify({script,manifest,identity:f.identity,captureBootId,origin:`https://${input.access.hostname}`,
      owner:readFileSync("provisioner/remote-desktop/provider-service-owner.py").toString("base64"),
      worker:readFileSync("provisioner/hivra-provider-worker.py").toString("base64")}),
  });
  expect({status:result.status,stderr:result.stderr}).toEqual({status:0,stderr:""});
  expect(result.stdout).toContain(`${captureBootId?17:15} generated-probe cases`);
});
it("accepts a kernel boot identity bound to the original desktop capability",()=>{
  const capability=receipt(),value={bootId:f.op.operationId,capabilityOutput:wire(capability)};
  expect(parseProviderDesktopPowerReceipt(`HIVRA_PROVIDER_DESKTOP_POWER_V1 ${JSON.stringify(value)}\n`,input))
    .toEqual({bootId:f.op.operationId,capability});
});
it.each(["boot","computer","origin","stale","extra","duplicate","prefix"])("rejects invalid power %s without an observation",fault=>{
  const capability=receipt(),value:Record<string,unknown>={bootId:f.op.operationId};
  if(fault==="boot")value.bootId="invalid";
  if(fault==="computer")capability.computerId=f.op.operationId;
  if(fault==="origin")capability.brokerOrigin="https://other.example.test";
  if(fault==="stale")capability.observedAt="2026-01-01T00:00:00Z";
  if(fault==="extra")value.token="forbidden";
  value.capabilityOutput=wire(capability);
  const output=`HIVRA_PROVIDER_DESKTOP_POWER_V1 ${JSON.stringify(value)}\n`;
  expect(()=>parseProviderDesktopPowerReceipt((fault==="prefix"?"log\n":"")+output+(fault==="duplicate"?output:""),input))
    .toThrow("Invalid provider desktop power receipt");
});
it("accepts only the original current desktop capability",()=>{
  const value=receipt();
  const parsed=parseProviderDesktopRuntimeReceipt(wire(value),input);
  expect(parsed).toEqual(value);
  expect(parsed.bootIdentitySha256).toBeUndefined();
});
it.each(["computer","origin","revision","stale","prefix","duplicate","extra"])("rejects invalid %s capability",fault=>{
  const value:Record<string,unknown>=receipt();
  if(fault==="computer")value.computerId=f.op.operationId;
  if(fault==="origin")value.brokerOrigin="https://other.example.test";
  if(fault==="revision")value.observedRevision="f".repeat(64);
  if(fault==="stale")value.observedAt="2026-01-01T00:00:00Z";
  if(fault==="extra")value.token="forbidden";
  const output=(fault==="prefix"?"log\n":"")+wire(value)+(fault==="duplicate"?wire(value):"");
  expect(()=>parseProviderDesktopRuntimeReceipt(output,input)).toThrow("Invalid provider desktop runtime receipt");
});
