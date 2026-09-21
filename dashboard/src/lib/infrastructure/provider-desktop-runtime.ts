import "server-only";
import { z } from "zod";

import currentRelease from "../../../provisioner-releases/2026.09.15.2.json";
import priorFifteenRelease from "../../../provisioner-releases/2026.09.15.1.json";
import handoffReductionRelease from "../../../provisioner-releases/2026.09.08.3.json";
import handoffLatencyRelease from "../../../provisioner-releases/2026.09.08.2.json";
import firstFrameRelease from "../../../provisioner-releases/2026.09.08.1.json";
import densityRelease from "../../../provisioner-releases/2026.09.07.1.json";
import scalingRelease from "../../../provisioner-releases/2026.09.06.4.json";
import transferRelease from "../../../provisioner-releases/2026.09.06.3.json";
import preparedRelease from "../../../provisioner-releases/2026.09.06.2.json";
import editorRelease from "../../../provisioner-releases/2026.09.06.1.json";
import ownershipRelease from "../../../provisioner-releases/2026.09.05.10.json";
import workspaceRelease from "../../../provisioner-releases/2026.09.05.9.json";
import coldStartRelease from "../../../provisioner-releases/2026.09.05.8.json";
import framingRelease from "../../../provisioner-releases/2026.09.05.7.json";
import priorRelease from "../../../provisioner-releases/2026.09.05.6.json";
import { parseProviderDesktopWorkerIdentity, type ProviderDesktopWorkerIdentity } from "./provider-desktop-worker";
import { parseProviderDesktopAccess, type ProviderDesktopAccess } from "./provider-desktop-launch-contract";
import { parseRemoteDesktopCapabilityReceipt, remoteDesktopGuestInspectionProgram, REMOTE_DESKTOP_BUNDLE_REVISION } from "@/lib/remote-computers/capability-inspection";

export type ProviderDesktopRuntimeProbe = {identity: ProviderDesktopWorkerIdentity; access: ProviderDesktopAccess};
export type ProviderWorkspaceRuntimeProbe = ProviderDesktopRuntimeProbe & { controlOrigin: string };
// A retained provider worker observes its own sealed installer, not whatever
// revision became current. Keep this exhaustive when adding a release; merely
// allowing any known predecessor would admit the wrong installation identity.
const desktopRevisionByVersion = {
  "2026.09.05.6": "a3b299a308848f68063e4915219a1343bddf9550fabd80dc5be54384c3cd2f42",
  "2026.09.05.7": "a3b299a308848f68063e4915219a1343bddf9550fabd80dc5be54384c3cd2f42",
  "2026.09.05.8": "a3b299a308848f68063e4915219a1343bddf9550fabd80dc5be54384c3cd2f42",
  "2026.09.05.9": "a3b299a308848f68063e4915219a1343bddf9550fabd80dc5be54384c3cd2f42",
  "2026.09.05.10": "a3b299a308848f68063e4915219a1343bddf9550fabd80dc5be54384c3cd2f42",
  "2026.09.06.1": "a3b299a308848f68063e4915219a1343bddf9550fabd80dc5be54384c3cd2f42",
  "2026.09.06.2": "a864b6827ded1f10ffce4129ded4a97fb83d7ea4379e02d99459726d8b7e99db",
  "2026.09.06.3": "a864b6827ded1f10ffce4129ded4a97fb83d7ea4379e02d99459726d8b7e99db",
  "2026.09.06.4": "83c169e7381627993d7602d4efbc4f295f6698a44de5fde4ee6969eddede964d",
  "2026.09.07.1": "5b93e47216889a8c0fcd580e15788133410c0ac2ed13dc73cacd48e57c9ee7d8",
  "2026.09.08.1": "fde5d4410a98645f52b9701d177998a81a55978ce6b7f73792166062b951adab",
  "2026.09.08.2": "2e6b817785d4788e6292087c89e091db6703095b7c196e19ba66a50379618251",
  "2026.09.08.3": REMOTE_DESKTOP_BUNDLE_REVISION,
  "2026.09.15.1": REMOTE_DESKTOP_BUNDLE_REVISION,
  "2026.09.15.2": REMOTE_DESKTOP_BUNDLE_REVISION,
} satisfies Record<ProviderDesktopWorkerIdentity["bundle"]["provisionerVersion"], string>;
const ControlOrigin = z.string().max(300).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; } catch { return false; }
});
function checked(input: ProviderDesktopRuntimeProbe) {
  return {identity: parseProviderDesktopWorkerIdentity(input.identity), access: parseProviderDesktopAccess(input.access)};
}

/** Private observational probe. The caller supplies original SQL/owner authority
 * and uses enrolled pinned SSH. Retained bytes only: never current bundle,
 * package installation, service activation, credential rotation or repair.
 * Acquiring the global install lock may recreate its empty /run file after
 * reboot. No journal or retained controller is created or repaired.
 * Captured capability output is released only after a second ownership check.
 */
export function buildProviderDesktopRuntimeProbe(input: ProviderDesktopRuntimeProbe): string {
  return buildProbe(input, false);
}
/** Restart verification needs an observed kernel boot identity, not the
 * persisted desktop capability generation or a provider acknowledgement. */
export function buildProviderDesktopPowerProbe(input: ProviderDesktopRuntimeProbe): string {
  return buildProbe(input, true);
}
/** Workspace grants require installed code and the running gateway's original
 * identity/configuration, not a release label or unauthenticated HTML alone. */
export function buildProviderWorkspaceRuntimeProbe(input: ProviderWorkspaceRuntimeProbe): string {
  if (!["2026.09.05.9", "2026.09.05.10", "2026.09.06.1", "2026.09.06.2", "2026.09.06.3", "2026.09.06.4", "2026.09.07.1", "2026.09.08.1", "2026.09.08.2", "2026.09.08.3", "2026.09.15.1", "2026.09.15.2"].includes(checked(input).identity.bundle.provisionerVersion)) throw new Error("Workspace protocol unavailable");
  return buildProbe(input, false, ControlOrigin.parse(input.controlOrigin));
}
function buildProbe(input: ProviderDesktopRuntimeProbe, captureBootId: boolean, workspaceControlOrigin?: string): string {
  try {
    const expected = checked(input);
    const release = expected.identity.bundle.provisionerVersion === "2026.09.15.2" ? currentRelease
    : expected.identity.bundle.provisionerVersion === "2026.09.15.1" ? priorFifteenRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.08.3" ? handoffReductionRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.08.2" ? handoffLatencyRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.08.1" ? firstFrameRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.07.1" ? densityRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.06.4" ? scalingRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.06.3" ? transferRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.06.2" ? preparedRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.06.1" ? editorRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.05.10" ? ownershipRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.05.9" ? workspaceRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.05.8" ? coldStartRelease
      : expected.identity.bundle.provisionerVersion === "2026.09.05.7" ? framingRelease : priorRelease;
    const owner = release.files.find(file => file.path === "remote-desktop/provider-service-owner.py")!;
    const worker = release.files.find(file => file.path === "hivra-provider-worker.py")!;
    const workspaceFiles = release.files.filter(file => file.path.startsWith("hivra-chat/") && !file.path.slice(11).includes("/"));
    const manifest = release.files.map(file => ({path: file.path, sha256: file.sha256, size: file.bytes,
      mode: file.path.endsWith(".sh") || ["hivra-browser-apply", "hivra-guest-ssh-known-hosts", "hivra-network-preflight", "hivra-tg-apply"].includes(file.path) ? 0o700 : 0o600}))
      .sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return `import base64, contextlib, fcntl, hashlib, io, json, os, pathlib, stat, sys, types, uuid
CAPTURE_BOOT_ID=${captureBootId ? "True" : "False"}
WORKSPACE_CONTROL=json.loads(base64.b64decode("${Buffer.from(JSON.stringify(workspaceControlOrigin ?? null)).toString("base64")}"))
WORKSPACE_FILES=json.loads(base64.b64decode("${Buffer.from(JSON.stringify(workspaceFiles)).toString("base64")}"))
EXPECTED=json.loads(base64.b64decode("${Buffer.from(JSON.stringify(expected)).toString("base64")}"))
MANIFEST=json.loads(base64.b64decode("${Buffer.from(JSON.stringify(manifest)).toString("base64")}"))
PROGRAM=base64.b64decode("${Buffer.from(remoteDesktopGuestInspectionProgram()).toString("base64")}").decode('utf-8')
ROOT=pathlib.Path('/var/lib/hivra/provider-install')
fds=[]
def reject(): raise ValueError('Desktop ownership unavailable')
def directory(path):
 for parent in reversed((path,*path.parents)):
  info=os.lstat(parent)
  if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022: reject()
def read(path,limit=131072,mode=0o600):
 directory(path.parent)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=mode or info.st_size>limit: reject()
  raw=os.read(fd,limit+1)
  if len(raw)>limit: reject()
  return raw
 finally: os.close(fd)
def unique(pairs):
 value={}
 for key,item in pairs:
  if key in value: reject()
  value[key]=item
 return value
def document(path): return json.loads(read(path),object_pairs_hook=unique)
def encode(value): return json.dumps(value,sort_keys=True,separators=(',',':')).encode('ascii')
def pinned(path,size,digest):
 raw=read(path,size)
 if len(raw)!=size or hashlib.sha256(raw).hexdigest()!=digest: reject()
 return raw
def lock(path,create=False):
 directory(path.parent)
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_CREAT if create else 0),0o600)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600: reject()
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BaseException:
  os.close(fd)
  raise
 fds.append(fd)
try:
 boot_id=None
 if CAPTURE_BOOT_ID:
  boot_id=str(uuid.UUID(pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()))
 if os.geteuid()!=0: reject()
 for path in (ROOT/'manager.lock',ROOT/'run.lock'): lock(path)
 # /run is cleared on reboot. Acquire the same shared lock as the installer;
 # never skip exclusion or recreate missing persistent ownership journals.
 lock(pathlib.Path('/run/hivra-agent-install.lock'),create=True)
 if document(ROOT/'manifest.json')!=MANIFEST: reject()
 pinned(ROOT/'controller.py',${worker.bytes},'${worker.sha256}')
 folder=ROOT/'desktop-cleanup'; directory(folder)
 if set(os.listdir(folder))!={'provider-service-owner.py'}: reject()
 source=pinned(folder/'provider-service-owner.py',${owner.bytes},'${owner.sha256}')
 owner=types.ModuleType('hivra_provider_desktop_owner')
 exec(compile(source,str(folder/'provider-service-owner.py'),'exec'),owner.__dict__)
 identity=EXPECTED['identity']; access=EXPECTED['access']; public_origin='https://'+access['hostname']
 ownership=owner.ownership(document(ROOT/'desktop-ownership.json'))
 if ownership['computerId']!=identity['agentId'] or ownership['operationId']!=identity['operationId']: reject()
 intent={'version':1,'computerId':identity['agentId'],'operationId':identity['operationId']}
 network=document(ROOT/'desktop-network.json')
 if set(network)!=set(intent)|{'networkId'} or any(network[k]!=v for k,v in intent.items()): reject()
 import re
 if not isinstance(network['networkId'],str) or not re.fullmatch('[a-f0-9]{64}',network['networkId']): reject()
 if document(ROOT/'desktop-network-intent.json')!=intent: reject()
 ready=document(ROOT/'desktop-ready.json'); preparation=document(ROOT/'desktop-preparation-intent.json')
 if set(preparation)!=set(intent)|{'controlOrigin','publicOrigin'} or any(preparation[k]!=v for k,v in intent.items()) or preparation['publicOrigin']!=public_origin: reject()
 if set(ready)!=set(preparation)|{'ownership','capabilitySha256'} or any(ready[k]!=v for k,v in preparation.items()) or ready['ownership']!=ownership: reject()
 workspace_process=[]
 def workspace_observe(services):
  if WORKSPACE_CONTROL is None: return
  if preparation['controlOrigin']!=WORKSPACE_CONTROL or len(WORKSPACE_FILES)!=${["2026.09.06.1", "2026.09.06.2", "2026.09.06.3", "2026.09.06.4", "2026.09.07.1", "2026.09.08.1", "2026.09.08.2", "2026.09.08.3", "2026.09.15.1", "2026.09.15.2"].includes(expected.identity.bundle.provisionerVersion) ? 11 : 10}: reject()
  for entry in WORKSPACE_FILES:
   raw=read(pathlib.Path('/opt/bux')/entry['path'],entry['bytes'],0o644)
   if len(raw)!=entry['bytes'] or hashlib.sha256(raw).hexdigest()!=entry['sha256']: reject()
  import pwd
  uid=pwd.getpwnam('bux').pw_uid
  if uid<=0: reject()
  pid=services['bux-hivra-chat.service']['MainPID']
  if not re.fullmatch('[1-9][0-9]{0,9}',pid): reject()
  process=pathlib.Path('/proc')/pid
  info=os.lstat(process)
  if not stat.S_ISDIR(info.st_mode) or info.st_uid!=uid or info.st_mode&0o022: reject()
  def process_read(name,limit):
   fd=os.open(process/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
   try:
    info=os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or info.st_nlink!=1 or info.st_mode&0o022: reject()
    raw=os.read(fd,limit+1)
    if len(raw)>limit: reject()
    return raw
   finally: os.close(fd)
  if process_read('cgroup',4096)!=b'0::/system.slice/bux-hivra-chat.service\\n': reject()
  argv=process_read('cmdline',4096).split(b'\\0')
  if len(argv)!=3 or argv[1:]!=[b'/opt/bux/hivra-chat/server.js',b''] or not argv[0].startswith(b'/'): reject()
  executable=pathlib.Path(os.path.realpath(argv[0].decode('utf-8')))
  directory(executable.parent)
  info=os.lstat(executable)
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or os.path.realpath(process/'exe')!=str(executable): reject()
  # Only fixed non-secret values are compared. No process environment, argv,
  # local API token or credential file content can enter the receipt/errors.
  raw=process_read('environ',65536)
  if not raw.endswith(b'\\0'): reject()
  pairs=[entry.split(b'=',1) for entry in raw[:-1].split(b'\\0')]
  if any(len(pair)!=2 for pair in pairs): reject()
  environment=unique(pairs)
  expected_env={'HIVRA_WORKSPACE_PROTOCOL':'hivra-workspace-v1','HIVRA_AGENT_KIND':'linux-desktop',
   'HIVRA_WORKSPACE_ROOT':'/home/bux/Hivra','HIVRA_CHAT_PORT':'8080','HOME':'/home/bux',
   'HIVRA_REMOTE_DESKTOP_COMPUTER_ID':identity['agentId'],'HIVRA_REMOTE_DESKTOP_PUBLIC_ORIGIN':public_origin,
   'HIVRA_REMOTE_DESKTOP_CONTROL_ORIGIN':WORKSPACE_CONTROL}
  if any(environment.get(k.encode())!=v.encode() for k,v in expected_env.items()): reject()
  if environment.get(b'NODE_OPTIONS',b'') or environment.get(b'NODE_PATH',b'') or any(k.startswith(b'LD_') and v for k,v in environment.items()): reject()
  # Detect restart/PID reuse during the two observations as well as changed
  # configuration. /proc stat field22 is the kernel start tick for this PID.
  raw_stat=process_read('stat',4096)
  tail=raw_stat.rsplit(b') ',1)
  if len(tail)!=2 or not tail[0].startswith(pid.encode()+b' ('): reject()
  fields=tail[1].split()
  if len(fields)<20 or not fields[19].isdigit(): reject()
  current=(pid,fields[19])
  if workspace_process and workspace_process[0]!=current: reject()
  workspace_process[:]=[current]
 def observe():
  if os.path.lexists(ROOT/'cancel.json') or document(ROOT/'identity.json')!=identity or document(ROOT/'started.json')!=identity: reject()
  result=document(ROOT/'result.json')
  if set(result)!={'identity','exitCode'} or result['identity']!=identity or type(result['exitCode']) is not int or result['exitCode']!=0: reject()
  if document(ROOT/'stopped-outcome.json')!={'identity':identity,'state':'succeeded'}: reject()
  if document(ROOT/'desktop-ownership.json')!=ownership or document(ROOT/'desktop-network.json')!=network or document(ROOT/'desktop-ready.json')!=ready: reject()
  capability=json.loads(read(pathlib.Path('/opt/hivra/remote-desktop/capability.json')),object_pairs_hook=unique)
  if hashlib.sha256(encode(capability)).hexdigest()!=ready['capabilitySha256']: reject()
  services,container=owner.observed(ownership)
  if any(s['LoadState']!='loaded' or s['ActiveState']!='active' or s['SubState']!='running' or s['MainPID']=='0' or s['ControlPID']!='0' or s['UnitFileState']!='enabled' for s in services.values()): reject()
  workspace_observe(services)
  if container is None or not container['Running'] or any(container[k] for k in ('Paused','Restarting','Dead')): reject()
  boundary=json.loads(owner.command(['/usr/bin/docker','container','inspect','--format','[{{json .Id}},{{json .HostConfig.NetworkMode}},{{json .NetworkSettings.Networks}},{{json .Mounts}}]',ownership['container']['id']]))
  if not isinstance(boundary,list) or len(boundary)!=4 or boundary[0]!=ownership['container']['id'] or boundary[1]!=network['networkId']: reject()
  endpoints=boundary[2]
  if not isinstance(endpoints,dict) or set(endpoints)!={'hivra-remote-desktop'} or endpoints['hivra-remote-desktop'].get('NetworkID')!=network['networkId']: reject()
  if boundary[3]!=[{'Type':'bind','Source':'/home/bux/Hivra','Destination':'/home/ubuntu/Hivra','Mode':'','RW':True,'Propagation':'rprivate'}]: reject()
  properties=('LoadState','ActiveState','SubState','MainPID','ControlPID','ControlGroup','Transient','Job')
  raw=owner.command(['/usr/bin/systemctl','show',*['--property='+p for p in properties],'hivra-provider-install.service'])
  pairs=[line.split('=',1) for line in raw.decode('ascii').splitlines()]
  if any(len(p)!=2 for p in pairs) or len(pairs)!=len(properties): reject()
  state=unique(pairs)
  if set(state)!=set(properties) or state['MainPID']!='0' or state['ControlPID']!='0' or state['Job'] not in ('','0') or state['ControlGroup'] not in ('','/system.slice/hivra-provider-install.service'): reject()
  if state['LoadState']!='not-found' and state['Transient']!='yes': reject()
  if state['ActiveState'] not in ('inactive','failed') and not (state['ActiveState']=='active' and state['SubState']=='exited'): reject()
  group=pathlib.Path('/sys/fs/cgroup/system.slice/hivra-provider-install.service')
  if os.path.lexists(group):
   events=dict(line.split() for line in owner.read_regular(group/'cgroup.events',4096).decode('ascii').splitlines())
   if events.get('populated')!='0': reject()
  actual=json.loads(owner.command(['/usr/bin/docker','network','inspect',network['networkId']]))
  if not isinstance(actual,list) or len(actual)!=1: reject()
  actual=actual[0]
  expected_network={'Id':network['networkId'],'Name':'hivra-remote-desktop','Driver':'bridge','Scope':'local','Internal':False,'Attachable':False,'Ingress':False,'EnableIPv6':False,'ConfigOnly':False,'ConfigFrom':{'Network':''},'Options':{}}
  if any(type(actual.get(k)) is not type(v) or actual[k]!=v for k,v in expected_network.items()): reject()
  labels=actual.get('Labels',{})
  if labels.get('io.hivra.computer-id')!=identity['agentId'] or labels.get('io.hivra.operation-id')!=identity['operationId'] or labels.get('io.hivra.desktop-network-intent')!=hashlib.sha256(encode(intent)).hexdigest(): reject()
 observe()
 provider={'computerId':identity['agentId'],'publicOrigin':public_origin,'containerId':ownership['container']['id'],'networkId':network['networkId'],'runtimeImageId':ownership['container']['imageId']}
 output=io.StringIO()
 with contextlib.redirect_stdout(output):
  exec(compile(PROGRAM,'hivra-desktop-inspection','exec'),{'HIVRA_PROVIDER_DESKTOP_INSPECTION':provider})
 observe()
 result=output.getvalue()
 if len(result.encode('utf-8'))>4096: reject()
 if WORKSPACE_CONTROL is not None:
  sys.stdout.write('HIVRA_PROVIDER_WORKSPACE_V1 '+json.dumps({'protocol':'hivra-workspace-v1','computerId':identity['agentId'],
   'operationId':identity['operationId'],'publicOrigin':public_origin,'controlOrigin':WORKSPACE_CONTROL,'capabilityOutput':result},separators=(',',':'))+'\\n')
 elif CAPTURE_BOOT_ID:
  if str(uuid.UUID(pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()))!=boot_id: reject()
  sys.stdout.write('HIVRA_PROVIDER_DESKTOP_POWER_V1 '+json.dumps({'bootId':boot_id,'capabilityOutput':result},separators=(',',':'))+'\\n')
 else: sys.stdout.write(result)
except BaseException:
 print('Provider desktop runtime could not be verified',file=sys.stderr)
 sys.exit(1)
finally:
 for fd in reversed(fds): os.close(fd)
`;
  } catch { throw new Error("Invalid provider desktop runtime probe"); }
}

export function parseProviderDesktopRuntimeReceipt(output: string, input: ProviderDesktopRuntimeProbe) {
  try {
    const expected=checked(input), marker="HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ";
    if (Buffer.byteLength(output)>4096 || !output.startsWith(marker) || !output.endsWith("\n")
      || output.indexOf("\n")!==output.length-1 || output.includes("\r")) throw new Error();
    const receipt=parseRemoteDesktopCapabilityReceipt(output, {
      allowKnownPredecessor: true,
      // Provider receipts predate trusted guest boot evidence. Keep them on the
      // v1 persistence path so they can never release a controller lease.
      allowMissingBootIdentity: true,
    });
    if (!receipt || receipt.observedRevision !== desktopRevisionByVersion[expected.identity.bundle.provisionerVersion]
      || receipt.computerId!==expected.identity.agentId || receipt.brokerOrigin!==`https://${expected.access.hostname}`) throw new Error();
    return receipt;
  } catch { throw new Error("Invalid provider desktop runtime receipt"); }
}

export function parseProviderDesktopPowerReceipt(output: string, input: ProviderDesktopRuntimeProbe) {
  try {
    const marker = "HIVRA_PROVIDER_DESKTOP_POWER_V1 ";
    if (Buffer.byteLength(output) > 8192 || !output.startsWith(marker) || !output.endsWith("\n")
      || output.indexOf("\n") !== output.length - 1 || output.includes("\r")) throw new Error();
    const value = z.object({ bootId: z.string().uuid(), capabilityOutput: z.string().max(4096) }).strict()
      .parse(JSON.parse(output.slice(marker.length)));
    return { bootId: value.bootId, capability: parseProviderDesktopRuntimeReceipt(value.capabilityOutput, input) };
  } catch { throw new Error("Invalid provider desktop power receipt"); }
}

export function parseProviderWorkspaceRuntimeReceipt(output: string, input: ProviderWorkspaceRuntimeProbe) {
  try {
    const expected = checked(input), controlOrigin = ControlOrigin.parse(input.controlOrigin), marker = "HIVRA_PROVIDER_WORKSPACE_V1 ";
    if (!["2026.09.05.9", "2026.09.05.10", "2026.09.06.1", "2026.09.06.2", "2026.09.06.3", "2026.09.06.4", "2026.09.07.1", "2026.09.08.1", "2026.09.08.2", "2026.09.08.3", "2026.09.15.1", "2026.09.15.2"].includes(expected.identity.bundle.provisionerVersion) || Buffer.byteLength(output) > 8192
      || !output.startsWith(marker) || !output.endsWith("\n") || output.indexOf("\n") !== output.length - 1 || output.includes("\r")) throw new Error();
    const value = z.object({ protocol: z.literal("hivra-workspace-v1"), computerId: z.string().uuid(), operationId: z.string().uuid(),
      publicOrigin: z.string(), controlOrigin: z.string(), capabilityOutput: z.string().max(4096) }).strict().parse(JSON.parse(output.slice(marker.length)));
    if (value.computerId !== expected.identity.agentId || value.operationId !== expected.identity.operationId
      || value.publicOrigin !== `https://${expected.access.hostname}` || value.controlOrigin !== controlOrigin) throw new Error();
    return { protocol: value.protocol, computerId: value.computerId, operationId: value.operationId, publicOrigin: value.publicOrigin,
      controlOrigin, capability: parseProviderDesktopRuntimeReceipt(value.capabilityOutput, input) };
  } catch { throw new Error("Invalid provider workspace runtime receipt"); }
}
