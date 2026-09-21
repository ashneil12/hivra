import "server-only";

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import {
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import {
  OMARCHY_NATIVE_GUARDIAN_SHA256,
  OMARCHY_NATIVE_OWNERSHIP_SHA256,
  OMARCHY_NATIVE_PREVIOUS_GUARDIAN_SHA256,
  OMARCHY_WEB_BROKER_SHA256,
  OMARCHY_WEB_ADAPTER_SHA256,
  OMARCHY_WEB_INSTALLER_SHA256,
  OMARCHY_WEB_SERVER_SHA256,
} from "@/lib/remote-computers/omarchy-native-capability";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKER = "HIVRA_OMARCHY_NATIVE_PREPARATION_V1 ";
const MAX_SOURCE_BYTES = 1_048_576;
const HOST_TIMEOUT_MS = 90_000;

export type OmarchyNativePreparationBinding = {
  computerId: string;
  operationId: string;
  vmid: number;
  ownerUid: number;
  guestPrivateIpv4: string;
  waylandDisplay: string;
};

export type OmarchyNativePreparationRequest = Pick<OmarchyNativePreparationBinding,
  "computerId" | "operationId" | "vmid" | "guestPrivateIpv4">;

export type OmarchyNativeGuardianBundle = {
  guardian: Buffer;
  ownership: Buffer;
  webInstaller: Buffer;
  broker: Buffer;
  webBroker: Buffer;
  webServer: Buffer;
};

type Dependencies = {
  loadBundle: typeof loadOmarchyNativeGuardianBundle;
  resolveContext: (userId: string, agent: RemoteDesktopAgentRow) => Promise<HivraAgentExecutionContext>;
  runHostScript: typeof runProxmoxHostScript;
};

type Result =
  | { ok: true; targetId: string; vmid: number; binding: OmarchyNativePreparationBinding }
  | { ok: false; code: "invalid_target" | "bundle_unavailable" | "authority_unavailable" | "transport_failed" | "invalid_result"; reason?: string };

function safeTransportReason(result: { stderr: string; error?: string }): string {
  const guest = result.stderr.match(/(?:^|\n)HIVRA_PREPARATION_FAILURE ([a-z0-9_]+)(?:\r?\n|$)/)?.[1];
  if (guest) return `guest_${guest}`;
  // A guest that refused a runtime file also reports that file's observed
  // shape, so the reason names which file and why instead of only failing.
  const observed = result.stderr.match(/(?:^|\n)HIVRA_PREPARATION_OBSERVED ([A-Za-z0-9._-]+) sha256=([a-f0-9]{64})/);
  if (observed) return `guest_observed_${observed[1]}_${observed[2].slice(0, 12)}`;
  const error = result.error ?? "";
  if (/timed out/i.test(error)) return "host_timeout";
  if (/output exceeded/i.test(error)) return "host_output_limit";
  if (/SSH connection failed|SSH exec failed|SSH connect threw/i.test(error)) return "host_ssh";
  if (/not configured|Failed to read PROXMOX_SSH_KEY_PATH/i.test(error)) return "host_configuration";
  return "guest_remote_exit";
}

function privateIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9][0-9]{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some(part => part > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function validRequest(value: OmarchyNativePreparationRequest): boolean {
  return UUID.test(value.computerId) && UUID.test(value.operationId)
    && Number.isSafeInteger(value.vmid) && value.vmid >= 100
    && privateIpv4(value.guestPrivateIpv4);
}

function validBinding(value: OmarchyNativePreparationBinding): boolean {
  return validRequest(value) && Number.isSafeInteger(value.ownerUid) && value.ownerUid >= 1000
    && /^wayland-[0-9]{1,3}$/.test(value.waylandDisplay);
}

function sourceHash(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

export async function loadOmarchyNativeGuardianBundle(
  root = path.join(process.cwd(), "provisioner", "remote-desktop"),
): Promise<OmarchyNativeGuardianBundle> {
  const canonicalRoot = await realpath(root);
  const load = async (name: string, expected: string) => {
    const candidate = path.join(canonicalRoot, name);
    const canonical = await realpath(candidate);
    const info = await lstat(candidate);
    if (!canonical.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("Guardian bundle escaped its root.");
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Guardian bundle asset is unsafe.");
    const source = await readFile(candidate);
    if (source.length === 0 || source.length > MAX_SOURCE_BYTES || sourceHash(source) !== expected) {
      throw new Error("Guardian bundle identity mismatch.");
    }
    return source;
  };
  return {
    guardian: await load("omarchy-native-supervisor.py", OMARCHY_NATIVE_GUARDIAN_SHA256),
    ownership: await load("omarchy-sunshine-ownership.py", OMARCHY_NATIVE_OWNERSHIP_SHA256),
    webInstaller: await load("install-omarchy-web.py", OMARCHY_WEB_INSTALLER_SHA256),
    broker: await load("broker.cjs", OMARCHY_WEB_BROKER_SHA256),
    webBroker: await load("omarchy-web-broker.cjs", OMARCHY_WEB_ADAPTER_SHA256),
    webServer: await load("omarchy-web-server.cjs", OMARCHY_WEB_SERVER_SHA256),
  };
}

export const OMARCHY_NATIVE_INSTALL_PROGRAM = String.raw`import base64,hashlib,ipaddress,json,os,pathlib,pwd,re,stat,subprocess,sys
def fail(code):
 print('HIVRA_PREPARATION_FAILURE '+code,file=sys.stderr); raise SystemExit(1)
def unique(pairs):
 out={}
 for key,value in pairs:
  if key in out: fail('json_duplicate_key')
  out[key]=value
 return out
try: request=json.loads(sys.stdin.buffer.read(2_200_000),object_pairs_hook=unique)
except Exception: fail('input_invalid')
if not isinstance(request,dict) or set(request)!={'request','guardian','ownership','webInstaller','broker','webBroker','webServer'}: fail('input_shape')
expected=request['request']; uuid=r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
if (not isinstance(expected,dict) or set(expected)!={'computerId','operationId','vmid','guestPrivateIpv4'}
    or not re.fullmatch(uuid,str(expected.get('computerId','')),re.I) or not re.fullmatch(uuid,str(expected.get('operationId','')),re.I)
    or type(expected.get('vmid')) is not int or expected['vmid']<100): fail('binding_invalid')
try: guest_ip=ipaddress.ip_address(expected.get('guestPrivateIpv4',''))
except ValueError: fail('binding_invalid')
if guest_ip.version!=4 or not (guest_ip.is_private and not guest_ip.is_loopback and not guest_ip.is_link_local): fail('binding_invalid')
sessions=[]
for candidate in pathlib.Path('/proc').iterdir():
 if not candidate.name.isdigit(): continue
 try:
  if (candidate/'comm').read_text(encoding='utf-8').strip()!='Hyprland': continue
  status=(candidate/'status').read_text(encoding='utf-8'); match=re.search(r'^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$',status,re.M)
  if not match or len(set(match.groups()))!=1: continue
  uid=int(match.group(1)); environment=dict(item.split(b'=',1) for item in (candidate/'environ').read_bytes().split(b'\0') if b'=' in item)
  owner=pwd.getpwuid(uid); home=pathlib.Path(owner.pw_dir); runtime=pathlib.Path('/run/user')/str(uid)
  if (uid<1000 or environment.get(b'XDG_SESSION_TYPE')!=b'wayland'
      or home.parent!=pathlib.Path('/home') or home.name!=owner.pw_name or environment.get(b'HOME')!=str(home).encode()
      or environment.get(b'XDG_RUNTIME_DIR')!=str(runtime).encode()): continue
  displays=[]
  try: declared=environment.get(b'WAYLAND_DISPLAY',b'').decode('ascii')
  except UnicodeError: declared=''
  candidates=[runtime/declared] if re.fullmatch(r'wayland-[0-9]{1,3}',declared) else runtime.iterdir()
  for socket_path in candidates:
   if not re.fullmatch(r'wayland-[0-9]{1,3}',socket_path.name): continue
   try: info=os.lstat(socket_path)
   except OSError: continue
   if stat.S_ISSOCK(info.st_mode) and info.st_uid==uid and info.st_gid==owner.pw_gid and not info.st_mode&0o002: displays.append(socket_path.name)
  if len(displays)==1: sessions.append((uid,displays[0]))
 except (OSError,KeyError,UnicodeError): pass
if len(sessions)!=1: fail('wayland_session_ambiguous')
binding={**expected,'ownerUid':sessions[0][0],'waylandDisplay':sessions[0][1]}
try:
 guardian=base64.b64decode(request['guardian'],validate=True); ownership=base64.b64decode(request['ownership'],validate=True)
 web_installer=base64.b64decode(request['webInstaller'],validate=True); broker=base64.b64decode(request['broker'],validate=True); web_broker=base64.b64decode(request['webBroker'],validate=True); web_server=base64.b64decode(request['webServer'],validate=True)
except Exception: fail('source_invalid')
if (not 0<len(guardian)<=1048576 or not 0<len(ownership)<=1048576
    or hashlib.sha256(guardian).hexdigest()!=sys.argv[1]
    or hashlib.sha256(ownership).hexdigest()!=sys.argv[2]
    or hashlib.sha256(web_installer).hexdigest()!=sys.argv[4]
    or hashlib.sha256(broker).hexdigest()!=sys.argv[5]
    or hashlib.sha256(web_broker).hexdigest()!=sys.argv[6]
    or hashlib.sha256(web_server).hexdigest()!=sys.argv[7]): fail('source_identity_mismatch')
def sync_directory(path):
 descriptor=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
 try: os.fsync(descriptor)
 finally: os.close(descriptor)
def safe_directory(path,create=False):
 try: info=os.lstat(path)
 except FileNotFoundError:
  if not create: fail('directory_missing')
  os.mkdir(path,0o755); info=os.lstat(path); sync_directory(path.parent)
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or info.st_mode&0o022: fail('directory_unsafe')
def observe(path,info,existing):
 # Report what is actually on the guest when a guard rejects it, so a stuck
 # preparation names its own cause instead of only failing. These are hashes and
 # modes of Hivra's own runtime files, never credentials or session material.
 print('HIVRA_PREPARATION_OBSERVED '+path.name+' sha256='+hashlib.sha256(existing).hexdigest()
   +' mode='+oct(stat.S_IMODE(info.st_mode))+' uid='+str(info.st_uid)+' gid='+str(info.st_gid)
   +' nlink='+str(info.st_nlink),file=sys.stderr)
def install(path,data,mode,replace_hashes=(),converge=False):
 try: descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 except FileExistsError:
  descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
  try: info=os.fstat(descriptor); existing=os.read(descriptor,1048577)
  finally: os.close(descriptor)
  if (not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_gid!=0 or info.st_nlink!=1):
   observe(path,info,existing); fail('installed_source_conflict')
  if existing==data and stat.S_IMODE(info.st_mode)==mode: return
  # Preparing converges a guest onto the pinned release. Requiring the existing
  # bytes to be a named predecessor instead makes any local edit permanent:
  # inspection fails on the same mismatch, so neither refresh nor prepare can
  # clear it. The regular-file, root-owned, single-link shape stays mandatory
  # above; converge additionally normalises content and mode onto the pin.
  if not converge and (stat.S_IMODE(info.st_mode)!=mode
      or hashlib.sha256(existing).hexdigest() not in replace_hashes):
   observe(path,info,existing); fail('installed_source_conflict')
  print('HIVRA_PREPARATION_REPLACED '+path.name+' '+hashlib.sha256(existing).hexdigest())
  replacement=path.with_name(path.name+'.'+expected['operationId']+'.new')
  try: descriptor=os.open(replacement,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
  except FileExistsError: fail('replacement_source_conflict')
  try:
   offset=0
   while offset<len(data): offset+=os.write(descriptor,data[offset:])
   os.fsync(descriptor)
  finally: os.close(descriptor)
  os.replace(replacement,path); sync_directory(path.parent); return
 try:
  offset=0
  while offset<len(data): offset+=os.write(descriptor,data[offset:])
  os.fsync(descriptor)
 finally: os.close(descriptor)
 sync_directory(path.parent)
safe_directory(pathlib.Path('/usr/local')); safe_directory(pathlib.Path('/usr/local/libexec'),True)
root=pathlib.Path('/usr/local/libexec/hivra'); safe_directory(root,True)
guardian_path=root/'omarchy-native-supervisor.py'; ownership_path=root/'omarchy-sunshine-ownership.py'
install(ownership_path,ownership,0o600,converge=True)
install(guardian_path,guardian,0o700,{sys.argv[3]},converge=True)
web_installer_path=root/'install-omarchy-web.py'
install(web_installer_path,web_installer,0o700,converge=True)
install(root/'broker.cjs',broker,0o644,converge=True)
install(root/'omarchy-web-broker.cjs',web_broker,0o644,converge=True)
install(root/'omarchy-web-server.cjs',web_server,0o644,converge=True)
result=subprocess.run(['/usr/bin/python3','-I','-B',str(guardian_path),'prepare'],input=json.dumps(binding,separators=(',',':')).encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=30,check=False,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
if result.returncode!=0 or len(result.stdout)>32768: fail('guardian_prepare_failed')
try: observed=json.loads(result.stdout,object_pairs_hook=unique)
except Exception: fail('guardian_result_invalid')
expected={'protocol':'hivra-omarchy-native-guardian-preparation-v3','binding':binding,'administrationPrepared':True,'activation':'forbidden','desktopReady':False}
if observed!=expected: fail('guardian_result_mismatch')
# The web installer has a deliberately exact request shape. The guardian
# binding also carries operation/VM identity for the preparation receipt, but
# those fields are not installer input and must not cross this boundary.
web_request={
 'computerId':binding['computerId'],'guestPrivateIpv4':binding['guestPrivateIpv4'],
 'ownerUid':binding['ownerUid'],'waylandDisplay':binding['waylandDisplay'],
 'controlOrigin':'https://canary.hermesos.cloud','publicOrigin':'https://omarchy-canary.hermesos.cloud'}
web_result=subprocess.run(['/usr/bin/python3','-I','-B',str(web_installer_path)],input=json.dumps(web_request,separators=(',',':')).encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=600,check=False,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
if web_result.returncode!=0 or len(web_result.stdout)>32768: fail('web_prepare_failed')
try: web_observed=json.loads(web_result.stdout,object_pairs_hook=unique)
except Exception: fail('web_result_invalid')
if web_observed.get('protocol')!='hivra-omarchy-web-prepared-v1' or web_observed.get('browserReady') is not True or web_observed.get('brokerOrigin')!='https://omarchy-canary.hermesos.cloud': fail('web_result_mismatch')
print('${MARKER}'+json.dumps(observed,sort_keys=True,separators=(',',':'))) `;

export function buildOmarchyNativePreparationHostScript(
  request: OmarchyNativePreparationRequest,
  infrastructureBindingTag: string,
  bundle: OmarchyNativeGuardianBundle,
): string {
  if (!validRequest(request) || !/^hivra-bind-[a-f0-9]{32}$/.test(infrastructureBindingTag)
      || sourceHash(bundle.guardian) !== OMARCHY_NATIVE_GUARDIAN_SHA256
      || sourceHash(bundle.ownership) !== OMARCHY_NATIVE_OWNERSHIP_SHA256
      || sourceHash(bundle.webInstaller) !== OMARCHY_WEB_INSTALLER_SHA256
      || sourceHash(bundle.broker) !== OMARCHY_WEB_BROKER_SHA256
      || sourceHash(bundle.webBroker) !== OMARCHY_WEB_ADAPTER_SHA256
      || sourceHash(bundle.webServer) !== OMARCHY_WEB_SERVER_SHA256) {
    throw new Error("Invalid Omarchy native preparation.");
  }
  const payload = JSON.stringify({
    request,
    guardian: bundle.guardian.toString("base64"),
    ownership: bundle.ownership.toString("base64"),
    webInstaller: bundle.webInstaller.toString("base64"),
    broker: bundle.broker.toString("base64"),
    webBroker: bundle.webBroker.toString("base64"),
    webServer: bundle.webServer.toString("base64"),
  });
  return `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 077
VMID=${request.vmid}
GUEST_IP=${shellQuote(request.guestPrivateIpv4)}
EXPECTED_BINDING_TAG=${shellQuote(infrastructureBindingTag)}
qm() { command timeout --kill-after=5 20 qm "$@"; }
[ "$(qm status "$VMID" | awk '{print $2}')" = running ]
VM_CONFIG="$(qm config "$VMID")"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestExecPrelude()}
qm() { command timeout --kill-after=5 50 qm "$@"; }
printf '%s' ${shellQuote(payload)} | run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -S -c ${shellQuote(OMARCHY_NATIVE_INSTALL_PROGRAM)} ${shellQuote(OMARCHY_NATIVE_GUARDIAN_SHA256)} ${shellQuote(OMARCHY_NATIVE_OWNERSHIP_SHA256)} ${shellQuote(OMARCHY_NATIVE_PREVIOUS_GUARDIAN_SHA256)} ${shellQuote(OMARCHY_WEB_INSTALLER_SHA256)} ${shellQuote(OMARCHY_WEB_BROKER_SHA256)} ${shellQuote(OMARCHY_WEB_ADAPTER_SHA256)} ${shellQuote(OMARCHY_WEB_SERVER_SHA256)}
`;
}

function parseResult(
  stdout: string,
  request: OmarchyNativePreparationRequest,
): OmarchyNativePreparationBinding | null {
  const lines = stdout.split("\n").filter(line => line.startsWith(MARKER));
  if (lines.length !== 1) return null;
  let value: unknown;
  try { value = JSON.parse(lines[0].slice(MARKER.length)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const binding = row.binding as OmarchyNativePreparationBinding;
  return Object.keys(row).length === 5
    && row.protocol === "hivra-omarchy-native-guardian-preparation-v3"
    && validBinding(binding)
    && binding.computerId === request.computerId && binding.operationId === request.operationId
    && binding.vmid === request.vmid && binding.guestPrivateIpv4 === request.guestPrivateIpv4
    && row.administrationPrepared === true && row.activation === "forbidden" && row.desktopReady === false
    ? binding : null;
}

export async function prepareOmarchyNativeGuardian(
  userId: string,
  rawAgent: RemoteDesktopAgentRow,
  request: OmarchyNativePreparationRequest,
  dependencies: Partial<Dependencies> = {},
): Promise<Result> {
  const agent = structuredClone(rawAgent);
  const requested = structuredClone(request);
  if (!validRequest(requested) || !userId || agent.user_id !== userId || agent.id !== requested.computerId
      || agent.type !== "linux-desktop" || agent.computer_profile !== "omarchy"
      || agent.status !== "running" || agent.desired_state !== "running"
      || agent.operation_id !== requested.operationId || agent.operation_kind !== "desktop_prepare"
      || agent.vmid !== requested.vmid || agent.ip !== requested.guestPrivateIpv4
      || agent.infrastructure_binding_token_enforced !== true
      || typeof agent.infrastructure_binding_token_hash !== "string"
      || !/^[a-f0-9]{64}$/.test(agent.infrastructure_binding_token_hash)) {
    return { ok: false, code: "invalid_target" };
  }
  const deps = {
    loadBundle: loadOmarchyNativeGuardianBundle,
    resolveContext: resolveHivraAgentExecutionContext,
    runHostScript: runProxmoxHostScript,
    ...dependencies,
  };
  let bundle: OmarchyNativeGuardianBundle;
  try { bundle = await deps.loadBundle(); }
  catch { return { ok: false, code: "bundle_unavailable" }; }
  let context: HivraAgentExecutionContext;
  try { context = await deps.resolveContext(userId, agent); }
  catch { return { ok: false, code: "authority_unavailable" }; }
  const expectedTag = "hivra-bind-" + agent.infrastructure_binding_token_hash.slice(0, 32);
  if (!context.infrastructureBindingTagEnforced || context.infrastructureBindingTag !== expectedTag) {
    return { ok: false, code: "authority_unavailable" };
  }
  let script: string;
  try { script = buildOmarchyNativePreparationHostScript(requested, expectedTag, bundle); }
  catch { return { ok: false, code: "bundle_unavailable" }; }
  try {
    const response = await deps.runHostScript(script, { ...context.env }, {
      timeoutMs: HOST_TIMEOUT_MS, maxOutputBytes: 32_768, earlyFinishMarker: MARKER,
    });
    if (!response.ok) return { ok: false, code: "transport_failed", reason: safeTransportReason(response) };
    const binding = parseResult(response.stdout, requested);
    return binding ? { ok: true, targetId: context.host, vmid: requested.vmid, binding }
      : { ok: false, code: "invalid_result" };
  } catch {
    return { ok: false, code: "transport_failed", reason: "host_exception" };
  }
}
