import "server-only";

import { Buffer } from "node:buffer";

import {
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import {
  recordRemoteDesktopCapability,
  type RemoteDesktopCapabilityReceipt,
} from "@/lib/remote-computers/session-broker";
import {
  buildPreparedOmarchyNativeCapabilityInspectionScript,
  OMARCHY_DESKTOP_SESSION_REVISION,
  OMARCHY_WEB_BROKER_ORIGIN,
  OMARCHY_NATIVE_PREPARED_MARKER,
  parsePreparedOmarchyNativeCapability,
  type PreparedOmarchyNativeDescriptor,
} from "@/lib/remote-computers/omarchy-native-capability";
import {
  buildPreparedWindowsRdpCapabilityInspectionScript,
  parsePreparedWindowsRdpCapability,
  parseWindowsRdpInspectionFailure,
  WINDOWS_RDP_PREPARED_MARKER,
  type PreparedWindowsRdpDescriptor,
} from "@/lib/remote-computers/windows-rdp-capability";
import { resolveRemoteDesktopInspectionRuntime } from "@/lib/remote-computers/profile-runtime";
import { supabaseAdmin } from "@/lib/supabase";
import {
  runProxmoxHostScript,
  type HostScriptResult,
} from "@/lib/services/proxmox-instance-service";

const MARKER = "HIVRA_REMOTE_DESKTOP_CAPABILITY_V1 ";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^[a-f0-9]{64}$/;
const INSPECTION_TIMEOUT_MS = 45_000;
/** Owner-bound capability ledger TTL after a successful inspection/refresh. */
export const REMOTE_DESKTOP_CAPABILITY_TTL_MS = 8 * 60_000;
const SELKIES_IMAGE = "ghcr.io/selkies-project/selkies-egl-desktop@sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa";
export const REMOTE_DESKTOP_BUNDLE_REVISION = "98926697837c764e9e87901a0e1b6dce3ac5ba59827948068d68c78838b8401a";
// Session compatibility is narrower than installation compatibility. Retain
// only the sealed session-binding release; pre-binding brokers stay rejected.
// New installer-only releases must prove identical broker/server assets before
// joining this list, rather than interrupting already-secure active desktops.
export const REMOTE_DESKTOP_SESSION_REVISIONS: readonly string[] = [...new Set([
  "2e6b817785d4788e6292087c89e091db6703095b7c196e19ba66a50379618251",
  // Installer-only density policy change; sealed broker/server bytes unchanged.
  "e97280bea96549d42fc4e25d8b9880d7fcad2722da950c53fd7810c0c866fb56",
  // Omarchy-only opt-in cursor policy leaves this Ubuntu broker behavior intact.
  "9beeb61195795feb78f86196f5a9b059d1b6828adcbd81f1c00d409642b68cfe",
  // The prior release used the same session protocol; only Omarchy opted into
  // the removed fixed-arrow browser override.
  "dd070b13194107a5621905e5a8e386977cd8b85a6051af4bd3bc152a948866ca",
  // Previous sealed brokers remain session-safe during an explicit runtime update.
  "f2707c137c8363f3dfcc539a1f2eade116378c032ef51779c36bc8097b697d46",
  "78be6f62955aceea5e33345e8187efcc4f16fb886c203e54f9ce3ec3b775146e",
  // Bundle revision admitted before 2026.09.21.1; retained so no guest loses sessions.
  "6e66475cc695c033c9b2ed568e5ce0cecd3a3b7cbcb75682eb40e59f3020e96d",
  REMOTE_DESKTOP_BUNDLE_REVISION,
  OMARCHY_DESKTOP_SESSION_REVISION,
])];
// Explicit sealed releases only. Predecessors remain readable for truthful
// update guidance, while session issuance separately requires the exact
// current broker protocol revision.
export const REMOTE_DESKTOP_COMPATIBILITY = {
  "720c3959e260eeb394e07011164e9e0cf5095c8adb0b48316024aebac5ff6e94": { version: "2026.09.05.1", recipe: "identity-v1" },
  "feaeef4ff02c4e465afb289262bb99ecb2b0d72303513240fdbf15853d775c25": { version: "2026.09.05.2", recipe: "special-modes-v2" },
  "fea9cca814b4a1db98585a15c9fc2b589a53f88cb1f3edfd72877879990c6cab": { version: "2026.09.05.3", recipe: "symlinks-v3" },
  "e20870f72b22c95b83f83cee05ecd40be1460a23f5849c3b905b48354ba5745e": { version: "2026.09.05.4", recipe: "symlinks-v3" },
  "23cdd4556859116021241cfb0349634f7eabc30de15503f295e586d639d5628c": { version: "2026.09.05.5", recipe: "symlinks-v3" },
  "a3b299a308848f68063e4915219a1343bddf9550fabd80dc5be54384c3cd2f42": { version: "2026.09.05.6", recipe: "symlinks-v3" },
  "a864b6827ded1f10ffce4129ded4a97fb83d7ea4379e02d99459726d8b7e99db": { version: "2026.09.06.2", recipe: "symlinks-v3" },
  "83c169e7381627993d7602d4efbc4f295f6698a44de5fde4ee6969eddede964d": { version: "2026.09.06.4", recipe: "symlinks-v3" },
  "5b93e47216889a8c0fcd580e15788133410c0ac2ed13dc73cacd48e57c9ee7d8": { version: "2026.09.07.1", recipe: "symlinks-v3" },
  "fde5d4410a98645f52b9701d177998a81a55978ce6b7f73792166062b951adab": { version: "2026.09.08.1", recipe: "symlinks-v3" },
  "2e6b817785d4788e6292087c89e091db6703095b7c196e19ba66a50379618251": { version: "2026.09.08.2", recipe: "symlinks-v3" },
  "6aa8d88e09cbe4064dd80ec44b0dfbdc03c5fd5f87115eb2e1f9dcdf85276cb1": { version: "2026.09.08.3", recipe: "symlinks-v3" },
  "0144eaecdf167d7620d971a3e9d112d6d32375f945ae2398587492cf2564ec5c": { version: "2026.09.08.3", recipe: "symlinks-v3" },
  "8bc933b88594073475ac54dba45abdf25ed9ff4e1acb816217905a2713f76d8c": { version: "2026.09.08.3", recipe: "symlinks-v3" },
  "e97280bea96549d42fc4e25d8b9880d7fcad2722da950c53fd7810c0c866fb56": { version: "2026.09.08.3", recipe: "symlinks-v3" },
  "9beeb61195795feb78f86196f5a9b059d1b6828adcbd81f1c00d409642b68cfe": { version: "2026.09.08.3", recipe: "symlinks-v3" },
  "dd070b13194107a5621905e5a8e386977cd8b85a6051af4bd3bc152a948866ca": { version: "2026.09.15.2", recipe: "symlinks-v3" },
  [REMOTE_DESKTOP_BUNDLE_REVISION]: { version: "2026.09.21.1", recipe: "symlinks-v3" },
} as const;
const LEGACY_DESKTOP_REVISION = "5a24955abe099ddbabaa66e01da0dc9cb395254d7b9ebcbb268539abcf2db38d";
const DESKTOP_UPGRADE_MESSAGE = "This desktop needs an update to establish its shared-folder identity. This check did not install or change anything.";

function knownDesktopRevision(value: string): value is keyof typeof REMOTE_DESKTOP_COMPATIBILITY {
  return Object.prototype.hasOwnProperty.call(REMOTE_DESKTOP_COMPATIBILITY, value);
}

type AgentRow = {
  id: string;
  user_id: string;
  type?: unknown;
  computer_profile?: unknown;
  status: string | null;
  desired_state: string | null;
  operation_id: string | null;
  operation_kind: string | null;
  vmid: number | null;
  ip: string | null;
  chat_url: string | null;
  computer_substrate?: unknown;
  provider_capacity_order_id?: unknown;
  provider_enrollment_attempt_id?: unknown;
  provider_server_id?: unknown;
  deployment_mode?: unknown;
  proxmox_host?: unknown;
  infrastructure_connection_id?: unknown;
  deployment_target_id?: unknown;
  infrastructure_connection_revision?: unknown;
  infrastructure_binding_token_hash?: unknown;
  infrastructure_binding_token_enforced?: unknown;
  managed_provisioner_channel?: unknown;
};

export type RemoteDesktopCapabilityInspectionResult = {
  ok: boolean;
  agentId: string;
  targetId: string | null;
  vmid: number | null;
  receipt?: RemoteDesktopCapabilityReceipt;
  nativeDescriptor?: PreparedOmarchyNativeDescriptor;
  windowsDescriptor?: PreparedWindowsRdpDescriptor;
  error?: string;
  code?: "desktop_upgrade_required";
  runtimeVersion?: string;
  upgradeAvailable?: boolean;
};

type Dependencies = {
  inspectProvider: typeof import("@/lib/hivra/provider-desktop-capability").inspectProviderDesktopCapability;
  loadAgent: (agentId: string) => Promise<AgentRow | null>;
  resolveContext: (userId: string, agent: AgentRow) => Promise<HivraAgentExecutionContext>;
  runHostScript: typeof runProxmoxHostScript;
  recordCapability: typeof recordRemoteDesktopCapability;
};

async function loadAgent(agentId: string): Promise<AgentRow | null> {
  if (!supabaseAdmin) throw new Error("Remote desktop database client is unavailable.");
  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select([
      "id", "user_id", "type", "computer_profile", "status", "desired_state", "operation_id", "operation_kind",
      "vmid", "ip", "chat_url", "computer_substrate", "provider_capacity_order_id",
      "provider_enrollment_attempt_id", "provider_server_id", "deployment_mode",
      "proxmox_host", "infrastructure_connection_id", "deployment_target_id",
      "infrastructure_connection_revision", "infrastructure_binding_token_hash",
      "infrastructure_binding_token_enforced", "managed_provisioner_channel",
    ].join(","))
    .eq("id", agentId)
    .maybeSingle();
  if (error) throw new Error("Remote desktop agent lookup failed.");
  return (data as AgentRow | null) ?? null;
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  inspectProvider: async input => (await import("@/lib/hivra/provider-desktop-capability")).inspectProviderDesktopCapability(input),
  loadAgent,
  resolveContext: resolveHivraAgentExecutionContext,
  runHostScript: runProxmoxHostScript,
  recordCapability: recordRemoteDesktopCapability,
};

function validIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every(part => {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}

function privateIpv4(value: string): boolean {
  if (!validIpv4(value)) return false;
  const octets = value.split(".").map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

const SPECIAL_MODE_VALIDATOR = String.raw`import os,stat,sys
root=os.path.realpath(sys.argv[1]); old_uid=int(sys.argv[2]); old_gid=int(sys.argv[3]); remap_uid=sys.argv[4]=='1'; remap_gid=sys.argv[5]=='1'
expected={'/usr/local/share/fonts':('directory',0o2775,old_uid,old_gid),'/opt/google/chrome/chrome-sandbox':('regular',0o4755,old_uid,old_gid)}
actual={}; root_dev=os.lstat(root).st_dev
def kind(info):
 return 'directory' if stat.S_ISDIR(info.st_mode) else 'regular' if stat.S_ISREG(info.st_mode) else 'other'
def selected(info):
 return (remap_uid and info.st_uid==old_uid) or (remap_gid and info.st_gid==old_gid)
def inspect(path):
 info=os.lstat(path)
 if selected(info) and stat.S_IMODE(info.st_mode)&0o6000:
  relative='/' + os.path.relpath(path,root)
  actual[relative]=(kind(info),stat.S_IMODE(info.st_mode),info.st_uid,info.st_gid)
 return info
def walk_error(error): raise error
inspect(root)
for parent,directories,files in os.walk(root,topdown=True,followlinks=False,onerror=walk_error):
 retained=[]
 for name in directories:
  info=inspect(os.path.join(parent,name))
  if info.st_dev==root_dev and not stat.S_ISLNK(info.st_mode): retained.append(name)
 directories[:]=retained
 for name in files: inspect(os.path.join(parent,name))
raise SystemExit(0 if actual==expected else 1)`;

const SYMLINK_IDENTITY_REWRITER = String.raw`import os,stat,sys
root=os.path.realpath(sys.argv[1]); old_uid=int(sys.argv[2]); old_gid=int(sys.argv[3]); new_uid=int(sys.argv[4]); new_gid=int(sys.argv[5]); remap_uid=sys.argv[6]=='1'; remap_gid=sys.argv[7]=='1'
required=('listxattr','getxattr','setxattr','lchown','utime','replace','symlink','readlink')
if any(not callable(getattr(os,name,None)) for name in required): raise SystemExit(1)
blocked_xattrs=('trusted.overlay.','user.overlay.')
root_dev=os.lstat(root).st_dev; links=[]
def selected(info):
 return (remap_uid and info.st_uid==old_uid) or (remap_gid and info.st_gid==old_gid)
def metadata(path,info):
 target=os.readlink(path)
 names=tuple(sorted(os.listxattr(path,follow_symlinks=False)))
 if len(names)!=len(set(names)) or len(names)>64 or any(not isinstance(name,str) or not name or name.startswith(blocked_xattrs) for name in names): raise RuntimeError('unsupported xattrs')
 attrs=tuple((name,os.getxattr(path,name,follow_symlinks=False)) for name in names)
 if sum(len(value) for _,value in attrs)>1048576: raise RuntimeError('unsupported xattrs')
 return (target,info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),info.st_atime_ns,info.st_mtime_ns,attrs)
def stable(value):
 target,uid,gid,mode,atime_ns,mtime_ns,attrs=value
 return (target,uid,gid,mode,mtime_ns,attrs)
def inspect(path):
 info=os.lstat(path)
 if stat.S_ISLNK(info.st_mode) and selected(info):
  if info.st_nlink!=1: raise RuntimeError('linked symlink')
  links.append((path,metadata(path,info)))
 return info
def walk_error(error): raise error
inspect(root)
for parent,directories,files in os.walk(root,topdown=True,followlinks=False,onerror=walk_error):
 retained=[]
 for name in directories:
  info=inspect(os.path.join(parent,name))
  if info.st_dev==root_dev and not stat.S_ISLNK(info.st_mode): retained.append(name)
 directories[:]=retained
 for name in files: inspect(os.path.join(parent,name))
for index,(path,before) in enumerate(sorted(links)):
 current=os.lstat(path)
 identity=(current.st_dev,current.st_ino)
 if not stat.S_ISLNK(current.st_mode) or current.st_nlink!=1 or stable(metadata(path,current))!=stable(before): raise RuntimeError('symlink changed')
 target,uid,gid,mode,atime_ns,mtime_ns,attrs=before
 mapped_uid=new_uid if remap_uid and uid==old_uid else uid; mapped_gid=new_gid if remap_gid and gid==old_gid else gid
 temporary=os.path.join(os.path.dirname(path),'.'+os.path.basename(path)+f'.hivra-identity-{os.getpid()}-{index}')
 if os.path.lexists(temporary): raise RuntimeError('temporary symlink exists')
 try:
  os.symlink(target,temporary)
  os.lchown(temporary,mapped_uid,mapped_gid)
  if os.readlink(temporary)!=target: raise RuntimeError('symlink target mismatch')
  for name,value in attrs: os.setxattr(temporary,name,value,follow_symlinks=False)
  names=tuple(sorted(os.listxattr(temporary,follow_symlinks=False)))
  if names!=tuple(name for name,_ in attrs) or any(os.getxattr(temporary,name,follow_symlinks=False)!=value for name,value in attrs): raise RuntimeError('symlink xattr mismatch')
  os.utime(temporary,ns=(atime_ns,mtime_ns),follow_symlinks=False)
  candidate=os.lstat(temporary)
  actual=(candidate.st_uid,candidate.st_gid,stat.S_IMODE(candidate.st_mode),candidate.st_atime_ns,candidate.st_mtime_ns)
  if not stat.S_ISLNK(candidate.st_mode) or candidate.st_nlink!=1 or actual!=(mapped_uid,mapped_gid,mode,atime_ns,mtime_ns): raise RuntimeError('temporary symlink mismatch')
  current=os.lstat(path)
  if (current.st_dev,current.st_ino)!=identity or current.st_nlink!=1 or stable(metadata(path,current))!=stable(before): raise RuntimeError('symlink changed')
  os.replace(temporary,path)
  if os.path.lexists(temporary) or os.readlink(path)!=target: raise RuntimeError('symlink replace mismatch')
  names=tuple(sorted(os.listxattr(path,follow_symlinks=False)))
  if names!=tuple(name for name,_ in attrs) or any(os.getxattr(path,name,follow_symlinks=False)!=value for name,value in attrs): raise RuntimeError('symlink xattr mismatch')
  os.utime(path,ns=(atime_ns,mtime_ns),follow_symlinks=False)
  after=os.lstat(path)
  actual=(after.st_uid,after.st_gid,stat.S_IMODE(after.st_mode),after.st_atime_ns,after.st_mtime_ns)
  if not stat.S_ISLNK(after.st_mode) or after.st_nlink!=1 or actual!=(mapped_uid,mapped_gid,mode,atime_ns,mtime_ns): raise RuntimeError('symlink rewrite mismatch')
 except BaseException:
  try:
   if os.path.lexists(temporary): os.unlink(temporary)
  finally: raise`;

const GUEST_PROGRAM = String.raw`import datetime,hashlib,json,os,pathlib,re,shlex,stat,subprocess,sys,urllib.parse,uuid
provider=globals().get('HIVRA_PROVIDER_DESKTOP_INSPECTION')
def fail(code):
    print('HIVRA_CAPABILITY_FAILURE '+code,file=sys.stderr)
    raise SystemExit(1)
def boot_capability_identity(installed_generation):
    try: boot_id=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text(encoding='ascii').strip()
    except (OSError,UnicodeError): fail('guest_boot_id_unavailable')
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',boot_id,re.I): fail('guest_boot_id_invalid')
    canonical=str(uuid.UUID(boot_id))
    return (str(uuid.uuid5(uuid.UUID(installed_generation),'hivra-remote-desktop-boot-v1:'+canonical)),hashlib.sha256(canonical.encode('ascii')).hexdigest())
def run(command,stage,capture=False,timeout=10):
    try:
        result=subprocess.run(command,check=False,stdout=subprocess.PIPE if capture else subprocess.DEVNULL,stderr=subprocess.DEVNULL,text=True,timeout=timeout,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
    except subprocess.TimeoutExpired:
        fail(stage+'_timeout')
    if result.returncode!=0:
        fail(stage+'_failed')
    return result
SPECIAL_MODE_VALIDATOR=${JSON.stringify(SPECIAL_MODE_VALIDATOR)}
SYMLINK_IDENTITY_REWRITER=${JSON.stringify(SYMLINK_IDENTITY_REWRITER)}
COMPATIBLE_RELEASES=${JSON.stringify(REMOTE_DESKTOP_COMPATIBILITY)}
def capability_recipe_variant(document):
 if not isinstance(document,dict): fail('capability_shape_mismatch')
 revision=document.get('observedRevision')
 if revision=='${LEGACY_DESKTOP_REVISION}': fail('desktop_upgrade_required')
 if not isinstance(revision,str) or revision not in COMPATIBLE_RELEASES: fail('capability_pin_mismatch')
 identity_fields={'baseImage','baseImageIndexDigest','baseImageId','runtimeImageId','identityRecipeSha256','desktopUser','desktopUid','desktopGid','inputIsolation'}
 if not identity_fields.issubset(document): fail('desktop_upgrade_required')
 return COMPATIBLE_RELEASES[revision]['recipe']
def identity_recipe(uid,gid,variant='symlinks-v3'):
 if variant not in ('identity-v1','special-modes-v2','symlinks-v3'): fail('capability_recipe_mismatch')
 remap_uid=uid!=1000
 remap_gid=gid!=1000
 steps=["set -eu",'[ "$(/usr/bin/id -u ubuntu)" = "1000" ]','[ "$(/usr/bin/id -g ubuntu)" = "1000" ]','passwd_rows="$(/usr/bin/getent passwd)"',"printf '%s\\n' \"$passwd_rows\" | /usr/bin/awk -F: '($1==\"ubuntu\" || $3==\"1000\") { seen+=1; if (NF==7 && $1==\"ubuntu\" && $3==\"1000\" && $4==\"1000\" && $6==\"/home/ubuntu\") valid+=1 } END { exit !(seen==1 && valid==1) }'",'group_rows="$(/usr/bin/getent group)"',"printf '%s\\n' \"$group_rows\" | /usr/bin/awk -F: '($1==\"ubuntu\" || $3==\"1000\") { seen+=1; if (NF==4 && $1==\"ubuntu\" && $3==\"1000\") valid+=1 } END { exit !(seen==1 && valid==1) }'"]
 if remap_uid: steps.extend(["set +e",f'target_passwd="$(/usr/bin/getent passwd {uid} 2>/dev/null)"',"target_passwd_status=$?","set -e",'[ "$target_passwd_status" = "2" ]','[ -z "$target_passwd" ]',f'target_uid_inode="$(/usr/bin/find / -xdev -uid {uid} -print -quit 2>/dev/null)"','[ -z "$target_uid_inode" ]'])
 if remap_gid: steps.extend(["set +e",f'target_group="$(/usr/bin/getent group {gid} 2>/dev/null)"',"target_group_status=$?","set -e",'[ "$target_group_status" = "2" ]','[ -z "$target_group" ]',f'target_gid_inode="$(/usr/bin/find / -xdev -gid {gid} -print -quit 2>/dev/null)"','[ -z "$target_gid_inode" ]'])
 if remap_uid or remap_gid:
  if variant=='identity-v1':
   selector=r'\( -uid 1000 -o -gid 1000 \)' if remap_uid and remap_gid else '-uid 1000' if remap_uid else '-gid 1000'
   steps.extend([f'unsafe="$(/usr/bin/find / -xdev {selector} -perm /6000 -print -quit 2>/dev/null)"','[ -z "$unsafe" ]'])
  else:
   steps.extend(["identity_fail() { printf 'HIVRA_DESKTOP_IDENTITY_BUILD_FAILURE %s\\n' \"$1\" >&2; exit 1; }",f"/usr/bin/python3 -c {shlex.quote('exec('+repr(SPECIAL_MODE_VALIDATOR)+')')} / 1000 1000 {int(remap_uid)} {int(remap_gid)} || identity_fail special_mode_contract"])
 if remap_gid: steps.append(f"/usr/sbin/groupmod -g {gid} ubuntu")
 usermod=[]
 if remap_uid: usermod.extend(["-u",str(uid)])
 if remap_gid: usermod.extend(["-g",str(gid)])
 if usermod: steps.append("/usr/sbin/usermod "+" ".join(usermod)+" ubuntu")
 if (remap_uid or remap_gid) and variant=='symlinks-v3': steps.append(f"/usr/bin/python3 -c {shlex.quote('exec('+repr(SYMLINK_IDENTITY_REWRITER)+')')} / 1000 1000 {uid} {gid} {int(remap_uid)} {int(remap_gid)} || identity_fail symlink_identity_rewrite")
 if remap_uid: steps.extend([f"/usr/bin/find / -xdev -uid 1000 -exec /usr/bin/chown -h {uid} {{}} +",'remaining_uid="$(/usr/bin/find / -xdev -uid 1000 -print -quit 2>/dev/null)"','[ -z "$remaining_uid" ]'])
 if remap_gid: steps.extend([f"/usr/bin/find / -xdev -gid 1000 -exec /usr/bin/chgrp -h {gid} {{}} +",'remaining_gid="$(/usr/bin/find / -xdev -gid 1000 -print -quit 2>/dev/null)"','[ -z "$remaining_gid" ]'])
 if (remap_uid or remap_gid) and variant!='identity-v1':
  steps.extend(["/usr/bin/chmod 2775 /usr/local/share/fonts || identity_fail special_mode_restore","/usr/bin/chmod 4755 /opt/google/chrome/chrome-sandbox || identity_fail special_mode_restore",f'[ ! -L /usr/local/share/fonts ] && [ -d /usr/local/share/fonts ] && [ "$(/usr/bin/stat -Lc \'%a:%u:%g\' /usr/local/share/fonts)" = "2775:{uid}:{gid}" ] || identity_fail special_mode_restore',f'[ ! -L /opt/google/chrome/chrome-sandbox ] && [ -f /opt/google/chrome/chrome-sandbox ] && [ "$(/usr/bin/stat -Lc \'%a:%u:%g\' /opt/google/chrome/chrome-sandbox)" = "4755:{uid}:{gid}" ] || identity_fail special_mode_restore'])
 steps.extend([f'[ "$(/usr/bin/id -u ubuntu)" = "{uid}" ]',f'[ "$(/usr/bin/id -g ubuntu)" = "{gid}" ]'])
 return 'FROM ${SELKIES_IMAGE}\nUSER 0\nRUN '+'; \\\n    '.join(steps)+'\nUSER ubuntu\n'
def validate_identity_recipe(value,uid,gid,variant='symlinks-v3'):
 expected=hashlib.sha256(identity_recipe(uid,gid,variant).encode('utf-8')).hexdigest()
 if value!=expected: fail('capability_recipe_mismatch')
root=pathlib.Path('/opt/hivra/remote-desktop')
capability=root/'capability.json'
isolation=root/'input-isolation'
workspace=pathlib.Path('/home/bux/Hivra')
for label,parent in (('opt',pathlib.Path('/opt')),('hivra',pathlib.Path('/opt/hivra'))):
 try: parent_info=os.lstat(parent)
 except FileNotFoundError: fail('immutable_parent_'+label+'_missing')
 except OSError: fail('immutable_parent_'+label+'_unreadable')
 if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid!=0 or parent_info.st_mode&0o022: fail('immutable_parent_'+label+'_unsafe')
try: root_info=os.lstat(root)
except OSError: fail('immutable_root_missing')
if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid!=0 or stat.S_IMODE(root_info.st_mode)!=0o755: fail('immutable_root_unsafe')
bux_uid=int(run(['/usr/bin/id','-u','bux'],'bux_uid',capture=True,timeout=5).stdout.strip())
bux_gid=int(run(['/usr/bin/id','-g','bux'],'bux_gid',capture=True,timeout=5).stdout.strip())
try: workspace_info=os.lstat(workspace)
except OSError: fail('workspace_missing')
if not stat.S_ISDIR(workspace_info.st_mode) or workspace_info.st_uid!=bux_uid or workspace_info.st_gid!=bux_gid or stat.S_IMODE(workspace_info.st_mode)!=0o700: fail('workspace_boundary_mismatch')
for candidate,mode,label in ((capability,0o600,'capability'),(isolation,0o640,'isolation')):
    if not candidate.exists(): fail(label+'_missing')
    try: info=os.lstat(candidate)
    except OSError: fail(label+'_read_failed')
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=mode: fail(label+'_unsafe')
try: d=json.loads(capability.read_text(encoding='utf-8'))
except (OSError,ValueError,TypeError): fail('capability_json_invalid')
recipe_variant=capability_recipe_variant(d)
expected={'protocol','computerKind','computerId','capabilityGeneration','observedRevision','compositor','installedTransports','privateNetworkReachable','supportsInputTakeover','brokerOrigin','baseImage','baseImageIndexDigest','baseImageId','runtimeImageId','identityRecipeSha256','desktopUser','desktopUid','desktopGid','inputIsolation'}
if not isinstance(d,dict) or set(d)!=expected: fail('capability_shape_mismatch')
if provider is not None and (d['computerId']!=provider['computerId'] or d['brokerOrigin']!=provider['publicOrigin'] or d['runtimeImageId']!=provider['runtimeImageId']): fail('provider_capability_identity_mismatch')
if d['protocol']!='hivra-remote-desktop-installed-v1' or d['computerKind']!='hivra-agent' or d['compositor']!='x11' or d['installedTransports']!=['selkies-websocket'] or d['privateNetworkReachable'] is not False or d['supportsInputTakeover'] is not True: fail('capability_contract_mismatch')
if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',d['computerId'],re.I) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',d['capabilityGeneration'],re.I) or not re.fullmatch(r'[a-f0-9]{64}',d['observedRevision']): fail('capability_identity_mismatch')
if d['baseImage']!='${SELKIES_IMAGE}' or d['baseImageIndexDigest']!='sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa' or d['desktopUser']!='ubuntu' or d['inputIsolation']!='selkies-container-no-agent-input-v1' or isolation.read_text(encoding='utf-8')!='selkies-container-no-agent-input-v1\n': fail('capability_pin_mismatch')
for key in ('baseImageId','runtimeImageId'):
 if not isinstance(d[key],str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',d[key]): fail('capability_image_identity_mismatch')
if not isinstance(d['identityRecipeSha256'],str) or not re.fullmatch(r'[a-f0-9]{64}',d['identityRecipeSha256']): fail('capability_recipe_mismatch')
for key in ('desktopUid','desktopGid'):
 if isinstance(d[key],bool) or not isinstance(d[key],int) or d[key]<1000 or d[key]>60000: fail('capability_desktop_identity_mismatch')
if d['desktopUid']!=bux_uid or d['desktopGid']!=bux_gid: fail('capability_desktop_identity_mismatch')
validate_identity_recipe(d['identityRecipeSha256'],bux_uid,bux_gid,recipe_variant)
origin=urllib.parse.urlsplit(d['brokerOrigin'])
if origin.scheme!='https' or not origin.hostname or origin.path or origin.query or origin.fragment or d['brokerOrigin']!='https://'+origin.netloc: fail('broker_origin_mismatch')
for unit in ('hivra-selkies-desktop.service','hivra-remote-desktop-broker.service','bux-hivra-chat.service'):
    run(['/usr/bin/systemctl','is-active','--quiet',unit],'service_active_'+unit.split('.')[0].replace('-','_'))
container_id='hivra-selkies-desktop' if provider is None else provider['containerId']
try: container=json.loads(run(['/usr/bin/docker','inspect',container_id],'docker_inspect',capture=True).stdout)[0]
except (ValueError,TypeError,IndexError): fail('docker_inspect_invalid')
try:
 base_image=json.loads(run(['/usr/bin/docker','image','inspect',d['baseImage']],'docker_base_image_inspect',capture=True).stdout)[0]
 runtime_image=json.loads(run(['/usr/bin/docker','image','inspect',d['runtimeImageId']],'docker_runtime_image_inspect',capture=True).stdout)[0]
except (ValueError,TypeError,IndexError): fail('docker_image_inspect_invalid')
def image_config(document,user,stage):
 config=document.get('Config',{})
 if document.get('Os')!='linux' or document.get('Architecture')!='amd64' or config.get('User')!=user or config.get('Entrypoint')!=['/etc/container-entrypoint.sh'] or config.get('Cmd') is not None or config.get('WorkingDir')!='/home/ubuntu' or config.get('Volumes') is not None: fail(stage+'_config_mismatch')
 return config
base_config=image_config(base_image,'1000','base_image')
runtime_config=image_config(runtime_image,'ubuntu','runtime_image')
if base_image.get('Id')!=d['baseImageId'] or d['baseImage'] not in base_image.get('RepoDigests',[]): fail('base_image_identity_mismatch')
labels=runtime_config.get('Labels',{})
expected_labels={'io.hivra.remote-desktop.base-index-digest':d['baseImageIndexDigest'],'io.hivra.remote-desktop.base-image-id':d['baseImageId'],'io.hivra.remote-desktop.identity-recipe-sha256':d['identityRecipeSha256'],'io.hivra.remote-desktop.desktop-user':'ubuntu','io.hivra.remote-desktop.desktop-uid':str(d['desktopUid']),'io.hivra.remote-desktop.desktop-gid':str(d['desktopGid'])}
base_labels=base_config.get('Labels') or {}
if not isinstance(base_labels,dict): fail('base_image_labels_mismatch')
expected_labels={**base_labels,**expected_labels}
base_unchanged={key:value for key,value in base_config.items() if key not in ('User','Labels')}
runtime_unchanged={key:value for key,value in runtime_config.items() if key not in ('User','Labels')}
def image_layers(document,stage):
 rootfs=document.get('RootFS',{})
 layers=rootfs.get('Layers') if isinstance(rootfs,dict) and rootfs.get('Type')=='layers' else None
 if not isinstance(layers,list) or not layers or any(not isinstance(layer,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',layer) for layer in layers): fail(stage+'_layers_mismatch')
 return layers
base_layers=image_layers(base_image,'base_image')
runtime_layers=image_layers(runtime_image,'runtime_image')
expected_layer_counts={len(base_layers)+1}
if bux_uid==1000 and bux_gid==1000: expected_layer_counts.add(len(base_layers))
if runtime_image.get('Id')!=d['runtimeImageId'] or not isinstance(labels,dict) or labels!=expected_labels or runtime_unchanged!=base_unchanged or runtime_layers[:len(base_layers)]!=base_layers or len(runtime_layers) not in expected_layer_counts: fail('runtime_image_identity_mismatch')
binding=container.get('NetworkSettings',{}).get('Ports',{}).get('8080/tcp')
mounts=container.get('Mounts',[])
expected_network='hivra-remote-desktop' if provider is None else provider['networkId']
if container.get('Image')!=d['runtimeImageId'] or container.get('Config',{}).get('Image')!=d['runtimeImageId'] or container.get('Config',{}).get('User')!='ubuntu' or container.get('State',{}).get('Running') is not True or container.get('HostConfig',{}).get('Privileged') is not False or container.get('HostConfig',{}).get('NetworkMode')!=expected_network or binding!=[{'HostIp':'127.0.0.1','HostPort':'8088'}]: fail('container_boundary_mismatch')
if provider is not None and (container.get('Id')!=container_id or container.get('Name')!='/hivra-selkies-desktop' or container.get('NetworkSettings',{}).get('Networks',{}).get('hivra-remote-desktop',{}).get('NetworkID')!=expected_network): fail('provider_container_identity_mismatch')
if len(mounts)!=1 or mounts[0].get('Type')!='bind' or mounts[0].get('Source')!='/home/bux/Hivra' or mounts[0].get('Destination')!='/home/ubuntu/Hivra' or mounts[0].get('RW') is not True or any(m.get('Destination')=='/var/run/docker.sock' for m in mounts): fail('container_mount_mismatch')
def container_value(command,stage):
 return run(['/usr/bin/docker','exec',container_id]+command,stage,capture=True,timeout=5).stdout.strip()
if container_value(['/usr/bin/id','-u'],'desktop_effective_uid')!=str(bux_uid) or container_value(['/usr/bin/id','-g'],'desktop_effective_gid')!=str(bux_gid) or container_value(['/usr/bin/id','-un'],'desktop_effective_user')!='ubuntu' or container_value(['/usr/bin/id','-u','ubuntu'],'desktop_named_uid')!=str(bux_uid) or container_value(['/usr/bin/id','-g','ubuntu'],'desktop_named_gid')!=str(bux_gid): fail('container_desktop_identity_mismatch')
if container_value(['/usr/bin/stat','-Lc','%u:%g:%F:%a','/home/ubuntu/Hivra'],'desktop_workspace')!=f'{bux_uid}:{bux_gid}:directory:700': fail('container_workspace_identity_mismatch')
for user in ('bux','hivra-desktop-broker'):
    groups=run(['/usr/bin/id','-nG',user],'groups_'+user.replace('-','_'),capture=True,timeout=5).stdout.split()
    if 'docker' in groups: fail('docker_authority_mismatch')
host=origin.netloc
health=run(['/usr/bin/curl','--silent','--show-error','--max-time','5','--output','/dev/null','--write-out','%{http_code}','-H','Host: '+host,'http://127.0.0.1:8090/healthz'],'broker_health',capture=True).stdout
handoff=run(['/usr/bin/curl','--silent','--show-error','--max-time','5','--output','/dev/null','--write-out','%{http_code}','-H','Host: '+host,'http://127.0.0.1:8080/desktop/handoff'],'handoff_reachability',capture=True).stdout
unauth=run(['/usr/bin/curl','--silent','--max-time','5','--output','/dev/null','--write-out','%{http_code}','http://127.0.0.1:8088/'],'selkies_unauthorized_probe',capture=True).stdout
if health!='200' or handoff!='200' or unauth!='401': fail('desktop_reachability_mismatch')
now=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
# Normal Proxmox guests retain the installation UUID across boots. Bind their
# observed capability to this proven boot; provider admission remains unchanged.
boot_identity=None if provider is not None else boot_capability_identity(d['capabilityGeneration'])
capability_generation=d['capabilityGeneration'] if provider is not None else boot_identity[0]
receipt={'protocol':'hivra-remote-desktop-capability-v1','computerKind':d['computerKind'],'computerId':d['computerId'],'capabilityGeneration':capability_generation,'observedRevision':d['observedRevision'],'compositor':d['compositor'],'installedTransports':d['installedTransports'],'privateNetworkReachable':d['privateNetworkReachable'],'supportsInputTakeover':d['supportsInputTakeover'],'brokerOrigin':d['brokerOrigin'],'observedAt':now}
if boot_identity is not None: receipt['bootIdentitySha256']=boot_identity[1]
print('${MARKER}'+json.dumps(receipt,sort_keys=True,separators=(',',':'))) `;

/** Private composition hook. Provider callers must validate original ownership
 * before injecting HIVRA_PROVIDER_DESKTOP_INSPECTION and capture output until
 * their final ownership/liveness check succeeds. This is not an SSH authority. */
export function remoteDesktopGuestInspectionProgram(): string { return GUEST_PROGRAM; }

export function buildRemoteDesktopCapabilityInspectionScript(input: {
  vmid: number;
  guestIp: string;
  infrastructureBindingTag: string;
}): string {
  const program = Buffer.from(GUEST_PROGRAM, "utf8").toString("base64");
  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
VMID=${input.vmid}
GUEST_IP=${shellQuote(input.guestIp)}
EXPECTED_BINDING_TAG=${shellQuote(input.infrastructureBindingTag)}
[[ "$VMID" =~ ^[0-9]+$ ]] && [ "$VMID" -ge 100 ]
[ -n "$EXPECTED_BINDING_TAG" ]
[ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = 'running' ]
VM_CONFIG="$(qm config "$VMID")"
TAGS="$(printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestExecPrelude()}
run_vmid_bound_guest_exec /bin/bash -c 'printf "%s" "$1" | /usr/bin/base64 --decode | /usr/bin/python3 -I -B -' hivra ${shellQuote(program)}
`;
}

export function parseRemoteDesktopCapabilityReceipt(
  stdout: string,
  options: { allowKnownPredecessor?: boolean; allowMissingBootIdentity?: boolean } = {},
): RemoteDesktopCapabilityReceipt | null {
  const lines = stdout.split("\n").filter(line => line.startsWith(MARKER));
  if (lines.length !== 1) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(lines[0].slice(MARKER.length)) as Record<string, unknown>; }
  catch { return null; }
  const required = new Set([
    "protocol", "computerKind", "computerId", "capabilityGeneration", "observedRevision",
    "compositor", "installedTransports", "privateNetworkReachable", "supportsInputTakeover",
    "brokerOrigin", "observedAt",
  ]);
  const allowed = new Set([...required, "bootIdentitySha256"]);
  if (Object.keys(value).some(key => !allowed.has(key))) return null;
  Object.keys(value).forEach(key => required.delete(key));
  if (required.size !== 0) return null;
  const validBootIdentity = typeof value.bootIdentitySha256 === "string" && REVISION.test(value.bootIdentitySha256);
  if (!validBootIdentity && !(options.allowMissingBootIdentity === true && value.bootIdentitySha256 === undefined)) return null;
  if (
    value.protocol !== "hivra-remote-desktop-capability-v1"
    || value.computerKind !== "hivra-agent" || typeof value.computerId !== "string" || !UUID.test(value.computerId)
    || typeof value.capabilityGeneration !== "string" || !UUID.test(value.capabilityGeneration)
    || typeof value.observedRevision !== "string" || !REVISION.test(value.observedRevision)
    || !knownDesktopRevision(value.observedRevision)
    || (options.allowKnownPredecessor !== true && value.observedRevision !== REMOTE_DESKTOP_BUNDLE_REVISION)
    || value.compositor !== "x11"
    || !Array.isArray(value.installedTransports) || value.installedTransports.length !== 1
    || value.installedTransports[0] !== "selkies-websocket"
    || value.privateNetworkReachable !== false || value.supportsInputTakeover !== true
    || typeof value.brokerOrigin !== "string" || typeof value.observedAt !== "string"
  ) return null;
  try {
    const broker = new URL(value.brokerOrigin);
    if (broker.protocol !== "https:" || broker.origin !== value.brokerOrigin) return null;
  } catch { return null; }
  const observedAt = Date.parse(value.observedAt);
  if (!Number.isFinite(observedAt) || Math.abs(Date.now() - observedAt) > 2 * 60_000) return null;
  return value as unknown as RemoteDesktopCapabilityReceipt;
}

function safeCapabilityFailureCode(result: HostScriptResult, marker = MARKER): string {
  if (marker === WINDOWS_RDP_PREPARED_MARKER) {
    const windowsFailure = parseWindowsRdpInspectionFailure(result.stderr);
    if (windowsFailure) return windowsFailure;
  }
  const guestFailure = marker !== WINDOWS_RDP_PREPARED_MARKER ? result.stderr.match(
    /(?:^|\n)HIVRA_CAPABILITY_FAILURE ([a-z0-9_]+)(?:\r?\n|$)/,
  )?.[1] : undefined;
  if (guestFailure) return "guest_" + guestFailure;
  const runnerError = result.error ?? "";
  if (/timed out/i.test(runnerError)) return "host_timeout";
  if (/output exceeded/i.test(runnerError)) return "host_output_limit";
  if (/SSH connection failed|SSH exec failed|SSH connect threw/i.test(runnerError)) return "host_ssh";
  if (marker === WINDOWS_RDP_PREPARED_MARKER) {
    const remoteExit = runnerError.match(/^Remote bash exited with code (undefined|[0-9]{1,3})$/)?.[1];
    if (remoteExit && (remoteExit === "undefined" || Number(remoteExit) <= 255)) return `host_remote_exit_${remoteExit}`;
  }
  if (!result.ok) return "guest_remote_exit";
  const markerCount = result.stdout.split("\n").filter(line => line.startsWith(marker)).length;
  if (markerCount === 0) return "capability_marker_absent";
  if (markerCount > 1) return "capability_marker_duplicate";
  return "capability_marker_invalid";
}

// Owner-facing outcomes of lifecycle readiness. Each stays under the 300
// characters release_hivra_agent_operation keeps, and names a next step.
export const DESKTOP_START_UNVERIFIED_MESSAGE = "This computer turned on, but Hivra couldn’t confirm its desktop is safe to open, so it isn’t ready. Nothing on it was changed. Choose Restart in Manage to try again, and contact support if it happens again.";
export const DESKTOP_START_OUTDATED_MESSAGE = "This computer turned on, but its desktop was set up by a version of Hivra too old to open safely. Nothing on it was changed. Stop it in Manage and contact support so we can update it for you.";
export const DESKTOP_PROVISION_UNVERIFIED_MESSAGE = "Your new computer turned on, but its desktop didn’t finish setting up. Delete it in Manage and launch a new one, and contact support if it happens again.";

export type DesktopReadinessVerdict =
  | { ok: true; receipt: RemoteDesktopCapabilityReceipt }
  | { ok: false; failureCode: string; observedRevision: string | null; ownerMessage: string };

function markerRevision(stdout: string): string | null {
  const line = stdout.split("\n").find(candidate => candidate.startsWith(MARKER));
  if (!line) return null;
  try {
    const revision = (JSON.parse(line.slice(MARKER.length)) as { observedRevision?: unknown }).observedRevision;
    return typeof revision === "string" && REVISION.test(revision) ? revision : null;
  } catch { return null; }
}

/**
 * Decides whether an Ubuntu Desktop lifecycle operation (provision, start,
 * restart, resize) may converge to `running`.
 *
 * A fresh provision just installed the current release, so it must prove that
 * exact release. Start, restart and resize install nothing: they must prove the
 * same sealed, pinned, identity-bound runtime the Desktop tab's own inspection
 * accepts (any release Hivra still recognises), with a fresh boot-bound
 * receipt for this exact computer and broker. Whether that release may carry a
 * session is decided separately at session issuance, which sends an older
 * release to the Desktop tab's "Update desktop" flow. Requiring the newest
 * release here instead turned every desktop made before it into an error on
 * its next Start, with no way to reach that update.
 */
export function verifyDesktopReadinessReceipt(
  result: HostScriptResult,
  expected: { computerId: string; brokerOrigin: string; operationKind: string },
): DesktopReadinessVerdict {
  const normalized = { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  const freshInstall = expected.operationKind === "provision";
  const observedRevision = markerRevision(normalized.stdout);
  const receipt = normalized.ok
    ? parseRemoteDesktopCapabilityReceipt(normalized.stdout, { allowKnownPredecessor: !freshInstall })
    : null;
  if (receipt && receipt.computerId === expected.computerId && receipt.brokerOrigin === expected.brokerOrigin) {
    return { ok: true, receipt };
  }
  const failureCode = receipt ? "identity_mismatch"
    : freshInstall && observedRevision && observedRevision !== REMOTE_DESKTOP_BUNDLE_REVISION && knownDesktopRevision(observedRevision)
      ? "desktop_release_not_current"
      : safeCapabilityFailureCode(normalized);
  const ownerMessage = freshInstall ? DESKTOP_PROVISION_UNVERIFIED_MESSAGE
    : failureCode === "guest_desktop_upgrade_required" ? DESKTOP_START_OUTDATED_MESSAGE
      : DESKTOP_START_UNVERIFIED_MESSAGE;
  return { ok: false, failureCode, observedRevision, ownerMessage };
}

export async function inspectRemoteDesktopCapability(
  agentId: string,
  dependencies: Partial<Dependencies> = {},
  options: { preparationOperationId?: string; persistReceipt?: boolean } = {},
): Promise<RemoteDesktopCapabilityInspectionResult> {
  if (!UUID.test(agentId)) return { ok: false, agentId, targetId: null, vmid: null, error: "Agent id is invalid." };
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const agent = await deps.loadAgent(agentId);
  if (!agent) return { ok: false, agentId, targetId: null, vmid: null, error: "Agent not found." };
  const profileRuntime = resolveRemoteDesktopInspectionRuntime(agent);
  if (!profileRuntime.ok) {
    return { ok: false, agentId, targetId: null, vmid: null, error: profileRuntime.message };
  }
  if (agent.computer_substrate === "provider-vm") {
    if (agent.type !== "linux-desktop" || agent.computer_profile !== "ubuntu-desktop" || options.preparationOperationId !== undefined) {
      return { ok: false, agentId, targetId: null, vmid: null, error: "Provider desktop inspection requires an already provisioned Ubuntu computer." };
    }
    return deps.inspectProvider({ userId: agent.user_id, agentId: agent.id });
  }
  const vmid = Number(agent.vmid);
  const ip = typeof agent.ip === "string" ? agent.ip.trim() : "";
  const profile = profileRuntime.runtime.profile;
  const omarchy = profile === "omarchy";
  const windows = profile === "windows";
  let brokerOrigin = "";
  try { brokerOrigin = new URL(agent.chat_url ?? "").origin; } catch {}
  const exactPreparation = typeof options.preparationOperationId === "string"
    && UUID.test(options.preparationOperationId) && agent.operation_id === options.preparationOperationId
    && agent.operation_kind === "desktop_prepare";
  if (
    agent.status !== "running" || agent.desired_state !== "running"
    || (!exactPreparation && (agent.operation_id != null || agent.operation_kind != null))
    || (options.preparationOperationId !== undefined && !exactPreparation)
    || !Number.isSafeInteger(vmid) || vmid < 100 || !validIpv4(ip)
    || ((omarchy || windows) && !privateIpv4(ip))
    || agent.infrastructure_binding_token_enforced !== true
    || (!omarchy && !windows && !brokerOrigin.startsWith("https://"))
  ) return { ok: false, agentId, targetId: null, vmid: Number.isSafeInteger(vmid) ? vmid : null, error: "Agent is not in a stable, identity-bound running state." };

  const context = await deps.resolveContext(agent.user_id, agent);
  if (!context.infrastructureBindingTagEnforced) {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop inspection authority is unavailable." };
  }
  let result: HostScriptResult;
  const marker = omarchy ? OMARCHY_NATIVE_PREPARED_MARKER
    : windows ? WINDOWS_RDP_PREPARED_MARKER : MARKER;
  try {
    const script = omarchy
      ? buildPreparedOmarchyNativeCapabilityInspectionScript({
        computerId: agent.id,
        vmid,
        guestIp: ip,
        publicIpv4: context.env.PROXMOX_PUBLIC_IP?.trim() ?? "",
        infrastructureBindingTag: context.infrastructureBindingTag,
      })
      : windows
        ? buildPreparedWindowsRdpCapabilityInspectionScript({
          computerId: agent.id,
          vmid,
          guestIp: ip,
          infrastructureBindingTag: context.infrastructureBindingTag,
        })
      : buildRemoteDesktopCapabilityInspectionScript({
        vmid,
        guestIp: ip,
        infrastructureBindingTag: context.infrastructureBindingTag,
      });
    result = await deps.runHostScript(script, context.env, {
      timeoutMs: INSPECTION_TIMEOUT_MS,
      maxOutputBytes: 16 * 1024,
      // Prepared descriptors are emitted as one JSON line. Finishing as soon
      // as the marker prefix arrives can return a partially received line and
      // make a valid prepared guest look unverified. Wait for channel close so
      // the parser always receives the complete descriptor.
      ...(!windows && !omarchy ? { earlyFinishMarker: marker } : {}),
    });
  } catch {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop inspection failed." };
  }
  if (!result.ok) {
    const upgradeRequired = !omarchy && safeCapabilityFailureCode(result, marker) === "guest_desktop_upgrade_required";
    return {
      ok: false,
      agentId,
      targetId: context.host,
      vmid,
      ...(upgradeRequired ? { code: "desktop_upgrade_required" as const } : {}),
      error: upgradeRequired ? DESKTOP_UPGRADE_MESSAGE
        : "Remote desktop capability could not be verified (" + safeCapabilityFailureCode(result, marker) + ").",
    };
  }
  const prepared = omarchy
    ? parsePreparedOmarchyNativeCapability(result.stdout, { computerId: agent.id, vmid, guestIp: ip })
    : null;
  const windowsDescriptor = windows
    ? parsePreparedWindowsRdpCapability(result.stdout, { computerId: agent.id, vmid, guestIp: ip })
    : null;
  const receipt = prepared?.receipt ?? (omarchy || windows ? null : parseRemoteDesktopCapabilityReceipt(result.stdout, {
    allowKnownPredecessor: !exactPreparation,
  }));
  if (!receipt && !windowsDescriptor) {
    return {
      ok: false,
      agentId,
      targetId: context.host,
      vmid,
      error: "Remote desktop capability could not be verified (" + safeCapabilityFailureCode(result, marker) + ").",
    };
  }
  const expectedBrokerOrigin = omarchy && prepared ? OMARCHY_WEB_BROKER_ORIGIN : brokerOrigin;
  if (receipt && (receipt.computerId !== agent.id || receipt.brokerOrigin !== expectedBrokerOrigin)) {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop capability could not be verified (identity_mismatch)." };
  }
  // Compatibility preserves read-only access; an explicit new installation
  // must still prove the current release before it can claim readiness.
  if (exactPreparation && !omarchy && !windows && receipt?.observedRevision !== REMOTE_DESKTOP_BUNDLE_REVISION) {
    return { ok: false, agentId, targetId: context.host, vmid, error: "The completed installer did not establish the current desktop release." };
  }
  if (receipt && options.persistReceipt !== false) {
    const recorded = await deps.recordCapability({
      userId: agent.user_id,
      receipt,
      // The ledger fences lifetime relative to the proven observation, not
      // the time SSH/recording finishes. Anchoring to now exceeds its ten-
      // minute maximum even when the same nominal TTL is configured here.
      expiresAt: new Date(Date.parse(receipt.observedAt) + REMOTE_DESKTOP_CAPABILITY_TTL_MS).toISOString(),
    });
    if (!recorded.ok) {
      return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop capability could not be recorded." };
    }
  }
  return {
    ok: true,
    agentId,
    targetId: context.host,
    vmid,
    ...(receipt ? { receipt } : {}),
    ...(!omarchy && !windows && receipt && knownDesktopRevision(receipt.observedRevision) ? {
      runtimeVersion: REMOTE_DESKTOP_COMPATIBILITY[receipt.observedRevision].version,
      upgradeAvailable: receipt.observedRevision !== REMOTE_DESKTOP_BUNDLE_REVISION,
    } : {}),
    ...(prepared ? { nativeDescriptor: prepared.descriptor } : {}),
    ...(windowsDescriptor ? { windowsDescriptor } : {}),
  };
}
