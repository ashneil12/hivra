import "server-only";

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";

import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import type { RemoteDesktopCapabilityReceipt } from "@/lib/remote-computers/session-broker";

export const OMARCHY_NATIVE_PREPARED_MARKER = "HIVRA_OMARCHY_NATIVE_PREPARED_V1 ";

// The pinned v4.0.2 lab installer requests the package-backed Omarchy release.
// Keep the observed package version explicit: legacy Git checkouts are not
// equivalent evidence and must not be admitted by this inspector.
const EXPECTED_OMARCHY_PACKAGE_VERSION = "4.0.2-1";
const EXPECTED_SUNSHINE_VERSION = "2026.516.143833-4";
const EXPECTED_SUNSHINE_UNIT = "app-dev.lizardbyte.app.Sunshine.service";
const EXPECTED_TCP_PORTS = [47984, 47989, 48010] as const;
const EXPECTED_UDP_PORTS = [5353, 47998, 47999, 48000, 48002, 48010] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IPV4 = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/;
const IPV4_SOURCE_CIDR = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;
const SHA256 = /^[a-f0-9]{64}$/;
export const OMARCHY_NATIVE_GUARDIAN_SHA256 = "48c453debfb0fc703e180aaddbae5e4b1ac89a1a23db1a35bb3a9b3a03f614ca";
export const OMARCHY_NATIVE_PREVIOUS_GUARDIAN_SHA256 = "24a89a6d4368971048d9f8d180b2fdb05531f1ae5ba9b574fd8eeaea0925791f";
export const OMARCHY_NATIVE_OWNERSHIP_SHA256 = "0f988ab03729e381531c923e835f0eaca80d23a77339cb1d13f234780b27f950";
export const OMARCHY_WEB_INSTALLER_SHA256 = "ff899b97ad3f02b5af9cfc7f3e9429acf894a2d087738d33f5c5fe03b346c3a0";
export const OMARCHY_WEB_BROKER_SHA256 = "7f71dbd64f725cf0fc688337f62bba919f8b8d0b83152f69d5f8b95fd478419f";
export const OMARCHY_WEB_ADAPTER_SHA256 = "9272e47af4146a593120d1fea711563449843a0ed8367661b03f54f72ca8c4d1";
export const OMARCHY_WEB_SERVER_SHA256 = "c91a4a189eaf56cf5734735b4a11f5d6563d837b1bb96c09996d6488bf4df89e";
export const OMARCHY_WEB_BROKER_ORIGIN = "https://omarchy-canary.hermesos.cloud";

export const LEGACY_OMARCHY_NATIVE_INSPECTION_PROGRAM = String.raw`import datetime,hashlib,http.client,ipaddress,json,os,pathlib,pwd,re,socket,ssl,stat,subprocess,sys
def fail(code):
 print('HIVRA_CAPABILITY_FAILURE '+code,file=sys.stderr); raise SystemExit(1)
def unique(pairs):
 out={}
 for key,value in pairs:
  if key in out: fail('json_duplicate_key')
  out[key]=value
 return out
def run(command,stage,timeout=10):
 try: result=subprocess.run(command,check=False,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,timeout=timeout,env={'PATH':'/usr/bin:/bin','LC_ALL':'C'})
 except subprocess.TimeoutExpired: fail(stage+'_timeout')
 if result.returncode!=0: fail(stage+'_failed')
 if len(result.stdout)>262144: fail(stage+'_output_large')
 return result.stdout
def read_regular(path,uid,stage,limit):
 try:
  descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 except OSError: fail(stage+'_missing')
 try:
  info=os.fstat(descriptor)
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or info.st_nlink!=1 or info.st_mode&0o022 or info.st_size>limit: fail(stage+'_unsafe')
  chunks=[]; remaining=info.st_size
  while remaining:
   chunk=os.read(descriptor,min(remaining,65536))
   if not chunk: fail(stage+'_short')
   chunks.append(chunk); remaining-=len(chunk)
  raw=b''.join(chunks)
  final=os.fstat(descriptor)
  if (final.st_dev,final.st_ino,final.st_mode,final.st_uid,final.st_nlink,final.st_size,final.st_mtime_ns)!=(info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_nlink,info.st_size,info.st_mtime_ns): fail(stage+'_changed')
 finally: os.close(descriptor)
 if len(raw)!=info.st_size or len(raw)>limit: fail(stage+'_large')
 return raw
def read_optional_regular(path,uid,stage,limit):
 try: os.lstat(path)
 except FileNotFoundError: return None
 except OSError: fail(stage+'_unreadable')
 return read_regular(path,uid,stage,limit)
def package(name,stage):
 parts=run(['/usr/bin/pacman','-Q',name],stage,5).strip().split()
 if len(parts)!=2 or parts[0]!=name: fail(stage+'_shape')
 return parts[1]
def private_source(value):
 try: network=ipaddress.ip_network(value if '/' in value else value+'/32',strict=True)
 except ValueError: fail('firewall_source_invalid')
 if network.version!=4: fail('firewall_source_invalid')
 private_ranges=[ipaddress.ip_network('10.0.0.0/8'),ipaddress.ip_network('172.16.0.0/12'),ipaddress.ip_network('192.168.0.0/16')]
 if network.prefixlen!=32 and not any(network.subnet_of(candidate) for candidate in private_ranges): fail('firewall_source_public')
 return str(network)
def validate_sunshine_paths(raw):
 if raw is None: return
 try: text=raw.decode('utf-8')
 except UnicodeDecodeError: fail('sunshine_config_invalid')
 defaults={'file_apps':'apps.json','credentials_file':'sunshine_state.json','file_state':'sunshine_state.json','pkey':'credentials/cakey.pem','cert':'credentials/cacert.pem'}
 seen=set()
 for raw_line in text.splitlines():
  line=raw_line.split('#',1)[0].strip()
  if not line or '=' not in line: continue
  name,value=line.split('=',1); name=name.strip(); value=value.strip()
  if name not in defaults: continue
  if name in seen: fail('sunshine_config_path_duplicate')
  seen.add(name)
  if value!=defaults[name]: fail('sunshine_config_path_override')
try: expected=json.loads(__import__('base64').b64decode(sys.argv[1],validate=True),object_pairs_hook=unique)
except Exception: fail('inspection_input_invalid')
if not isinstance(expected,dict) or set(expected)!={'computerId','vmid','guestPrivateIpv4','inspectionRevision'}: fail('inspection_input_shape')
if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',str(expected['computerId']),re.I): fail('computer_identity_invalid')
if not isinstance(expected['vmid'],int) or expected['vmid']<100: fail('vm_identity_invalid')
try:
 expected_ip=ipaddress.ip_address(expected['guestPrivateIpv4'])
except ValueError: fail('guest_ip_invalid')
private_ranges=[ipaddress.ip_network('10.0.0.0/8'),ipaddress.ip_network('172.16.0.0/12'),ipaddress.ip_network('192.168.0.0/16')]
if expected_ip.version!=4 or not any(expected_ip in candidate for candidate in private_ranges): fail('guest_ip_not_private')
addresses=json.loads(run(['/usr/bin/ip','-j','-4','address','show','up','scope','global'],'guest_ip',5),object_pairs_hook=unique)
observed_ips=[]
for interface in addresses:
 for address in interface.get('addr_info',[]):
  if address.get('family')=='inet' and address.get('scope')=='global': observed_ips.append(address.get('local'))
if observed_ips.count(str(expected_ip))!=1: fail('guest_ip_mismatch')
omarchy_package_version=package('omarchy','omarchy_package')
sunshine_version=package('sunshine','sunshine_package')
if omarchy_package_version!='${EXPECTED_OMARCHY_PACKAGE_VERSION}' or sunshine_version!='${EXPECTED_SUNSHINE_VERSION}': fail('package_pin_mismatch')
pids=[]
for candidate in pathlib.Path('/proc').iterdir():
 if not candidate.name.isdigit(): continue
 try:
  if (candidate/'comm').read_text(encoding='utf-8').strip()=='sunshine': pids.append(int(candidate.name))
 except OSError: pass
if len(pids)!=1: fail('sunshine_process_count')
pid=pids[0]; proc=pathlib.Path('/proc')/str(pid)
try: executable=os.readlink(proc/'exe')
except OSError: fail('sunshine_executable_unreadable')
if executable!='/usr/bin/sunshine': fail('sunshine_executable_mismatch')
try: command=[part for part in (proc/'cmdline').read_bytes().split(b'\0') if part]
except OSError: fail('sunshine_command_unreadable')
if command!=[b'/usr/bin/sunshine']: fail('sunshine_command_mismatch')
try: status=(proc/'status').read_text(encoding='utf-8')
except OSError: fail('sunshine_status_unreadable')
uid_match=re.search(r'^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$',status,re.M)
if not uid_match or len(set(uid_match.groups()))!=1: fail('sunshine_uid_mismatch')
uid=int(uid_match.group(1))
if uid<1000: fail('sunshine_owner_unsafe')
try: owner=pwd.getpwuid(uid)
except KeyError: fail('sunshine_owner_missing')
home=pathlib.Path(owner.pw_dir)
if home.parent!=pathlib.Path('/home') or home.name!=owner.pw_name: fail('sunshine_home_unsafe')
try: cgroup=(proc/'cgroup').read_text(encoding='utf-8')
except OSError: fail('sunshine_cgroup_unreadable')
escaped_unit='${EXPECTED_SUNSHINE_UNIT}'.replace('-',r'\x2d')
if not any(line.endswith('/${EXPECTED_SUNSHINE_UNIT}') or line.endswith('/'+escaped_unit) for line in cgroup.splitlines()): fail('sunshine_unit_mismatch')
try: environment=dict(item.split(b'=',1) for item in (proc/'environ').read_bytes().split(b'\0') if b'=' in item)
except OSError: fail('sunshine_environment_unreadable')
if environment.get(b'XDG_SESSION_TYPE')!=b'wayland' or not environment.get(b'WAYLAND_DISPLAY'): fail('wayland_session_mismatch')
if environment.get(b'HOME')!=str(home).encode() or environment.get(b'XDG_CONFIG_HOME',str(home/'.config').encode())!=str(home/'.config').encode(): fail('sunshine_config_home_mismatch')
hyprland=[]
for candidate in pathlib.Path('/proc').iterdir():
 if not candidate.name.isdigit(): continue
 try:
  if (candidate/'comm').read_text(encoding='utf-8').strip()!='Hyprland': continue
  candidate_status=(candidate/'status').read_text(encoding='utf-8')
  candidate_uid=re.search(r'^Uid:\s+([0-9]+)',candidate_status,re.M)
  if candidate_uid and int(candidate_uid.group(1))==uid: hyprland.append(candidate.name)
 except OSError: pass
if len(hyprland)!=1: fail('hyprland_process_mismatch')
config=home/'.config'/'sunshine'
for candidate,stage in ((home,'home'),(home/'.config','config_parent'),(config,'sunshine_config'),(config/'credentials','sunshine_credentials')):
 try: info=os.lstat(candidate)
 except OSError: fail(stage+'_missing')
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=uid or info.st_mode&0o022: fail(stage+'_unsafe')
sunshine_config_path=config/'sunshine.conf'
sunshine_config_raw=read_optional_regular(sunshine_config_path,uid,'sunshine_config_file',262144)
validate_sunshine_paths(sunshine_config_raw)
cert_path=config/'credentials'/'cacert.pem'
cert_raw=read_regular(cert_path,uid,'sunshine_certificate',65536)
try:
 cert_der=ssl.PEM_cert_to_DER_cert(cert_raw.decode('ascii'))
except Exception: fail('sunshine_certificate_invalid')
certificate_sha256=hashlib.sha256(cert_der).hexdigest()
context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); context.check_hostname=False; context.verify_mode=ssl.CERT_NONE
try:
 with socket.create_connection(('127.0.0.1',47984),timeout=3) as connection:
  with context.wrap_socket(connection,server_hostname='localhost') as secured: served_der=secured.getpeercert(binary_form=True)
except Exception: fail('sunshine_tls_unreachable')
if not served_der or hashlib.sha256(served_der).hexdigest()!=certificate_sha256: fail('sunshine_certificate_mismatch')
apps_raw=read_regular(config/'apps.json',uid,'sunshine_apps',262144)
try: apps_document=json.loads(apps_raw,object_pairs_hook=unique)
except Exception: fail('sunshine_apps_invalid')
if not isinstance(apps_document,dict) or not isinstance(apps_document.get('apps'),list): fail('sunshine_apps_shape')
desktop=[app for app in apps_document['apps'] if isinstance(app,dict) and app.get('name')=='Desktop']
if len(desktop)!=1: fail('sunshine_desktop_missing')
desktop_app=desktop[0]
for key in ('cmd','detached'):
 if key in desktop_app and desktop_app[key] not in ('',None): fail('sunshine_desktop_commanded')
if desktop_app.get('prep-cmd') not in (None,[]): fail('sunshine_desktop_commanded')
apps_sha256=hashlib.sha256(apps_raw).hexdigest()
state_path=config/'sunshine_state.json'
paired_count=0
if state_path.exists():
 state_raw=read_regular(state_path,uid,'sunshine_state',1048576)
 try: state=json.loads(state_raw,object_pairs_hook=unique)
 except Exception: fail('sunshine_state_invalid')
 if not isinstance(state,dict): fail('sunshine_state_shape')
 state_root=state.get('root',{})
 if not isinstance(state_root,dict): fail('sunshine_state_shape')
 for key in ('devices','named_devices'):
  entries=state_root.get(key,[])
  if entries is None: entries=[]
  if not isinstance(entries,list): fail('sunshine_state_shape')
  paired_count+=len(entries)
if paired_count!=0: fail('sunshine_clients_already_paired')
if read_optional_regular(sunshine_config_path,uid,'sunshine_config_file',262144)!=sunshine_config_raw: fail('sunshine_config_changed')
firewall_verbose=run(['/usr/bin/ufw','status','verbose'],'firewall_status',5)
if 'Status: active' not in firewall_verbose.splitlines() or not re.search(r'^Default: deny \(incoming\)(,|$)',firewall_verbose,re.M): fail('firewall_default_mismatch')
firewall_numbered=run(['/usr/bin/ufw','status','numbered'],'firewall_rules',5)
expected_tcp=${JSON.stringify(EXPECTED_TCP_PORTS)}; expected_udp=${JSON.stringify(EXPECTED_UDP_PORTS)}
protected={(port,'tcp') for port in expected_tcp}|{(port,'udp') for port in expected_udp}
routes={key:set() for key in protected}
for raw_line in firewall_numbered.splitlines():
 if 'ALLOW IN' not in raw_line: continue
 line=re.sub(r'^\[[^]]+\]\s*','',raw_line).strip()
 left,right=line.split('ALLOW IN',1)
 left=left.strip()
 v6=left.endswith(' (v6)')
 if v6: left=left[:-5].strip()
 match=re.fullmatch(r'([0-9]+)/(tcp|udp)',left)
 if not match:
  mentioned={int(port) for port in re.findall(r'(?<![0-9])([0-9]{1,5})(?![0-9])',left)}
  if mentioned&({47984,47989,47990,48010,5353,47998,47999,48000,48002}): fail('firewall_destination_ambiguous')
  continue
 key=(int(match.group(1)),match.group(2))
 if key==(47990,'tcp'): fail('sunshine_admin_exposed')
 if key not in protected: continue
 if v6 or 'hivra-sunshine' not in right: fail('sunshine_firewall_unscoped')
 source=right.strip().split()[0] if right.strip() else ''
 routes[key].add(private_source(source))
source_sets=[routes[(port,'tcp')] for port in expected_tcp]+[routes[(port,'udp')] for port in expected_udp]
if any(not values for values in source_sets) or any(values!=source_sets[0] for values in source_sets[1:]): fail('sunshine_firewall_incomplete')
source_cidrs=sorted(source_sets[0])
try:
 connection=http.client.HTTPSConnection('127.0.0.1',47990,context=context,timeout=3); connection.request('GET','/'); response=connection.getresponse(); status_code=response.status; response.read(1024); connection.close()
except Exception: fail('sunshine_admin_unreachable')
if status_code not in (200,307): fail('sunshine_admin_unready')
journal=run(['/usr/bin/journalctl','-b','_PID='+str(pid),'_COMM=sunshine','--no-pager','-o','cat'],'sunshine_journal',10)
encoders=re.findall(r'Found H\.264 encoder:\s*([^\r\n]+)',journal)
if not encoders: fail('sunshine_encoder_missing')
encoder=encoders[-1].strip()
if not re.fullmatch(r'[ -~]{1,160}',encoder): fail('sunshine_encoder_invalid')
now=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
descriptor={'protocol':'hivra-omarchy-native-prepared-v1','computerId':expected['computerId'],'vmid':expected['vmid'],'profile':'omarchy','guestPrivateIpv4':str(expected_ip),'inspectionRevision':expected['inspectionRevision'],'omarchyPackageVersion':omarchy_package_version,'sunshineVersion':sunshine_version,'serviceUnit':'${EXPECTED_SUNSHINE_UNIT}','serviceOwnerUid':uid,'compositor':'wayland-hyprland','encoder':encoder,'certificateSha256':certificate_sha256,'applicationName':desktop_app['name'],'applicationConfigSha256':apps_sha256,'pairedClientCount':paired_count,'route':{'status':'configured-not-proven','tcpPorts':expected_tcp,'udpPorts':expected_udp,'sourceCidrs':source_cidrs},'privateNetworkReachable':False,'supportsInputTakeover':False,'observedAt':now}
print('${OMARCHY_NATIVE_PREPARED_MARKER}'+json.dumps(descriptor,sort_keys=True,separators=(',',':'))) `;

const GUEST_PROGRAM = String.raw`import datetime,hashlib,ipaddress,json,os,pathlib,re,stat,subprocess,sys,time
def fail(code):
 print('HIVRA_CAPABILITY_FAILURE '+code,file=sys.stderr); raise SystemExit(1)
def unique(pairs):
 out={}
 for key,value in pairs:
  if key in out: fail('json_duplicate_key')
  out[key]=value
 return out
def run(command,stage,input_data=None,timeout=10):
 try: result=subprocess.run(command,input=input_data,check=False,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LC_ALL':'C'})
 except subprocess.TimeoutExpired: fail(stage+'_timeout')
 if result.returncode!=0: fail(stage+'_failed')
 if len(result.stdout)>262144: fail(stage+'_output_large')
 return result.stdout
def read_regular(path,uid,stage,limit,executable=False):
 try: descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 except OSError: fail(stage+'_missing')
 try:
  info=os.fstat(descriptor)
  if (not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or info.st_nlink!=1
      or info.st_mode&0o022 or info.st_size>limit or (executable and not info.st_mode&0o111)): fail(stage+'_unsafe')
  chunks=[]; remaining=info.st_size
  while remaining:
   chunk=os.read(descriptor,min(remaining,65536))
   if not chunk: fail(stage+'_short')
   chunks.append(chunk); remaining-=len(chunk)
  raw=b''.join(chunks); final=os.fstat(descriptor)
  if (final.st_dev,final.st_ino,final.st_mode,final.st_uid,final.st_nlink,final.st_size,final.st_mtime_ns)!=(info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_nlink,info.st_size,info.st_mtime_ns): fail(stage+'_changed')
 finally: os.close(descriptor)
 return raw
def package(name,stage):
 parts=run(['/usr/bin/pacman','-Q',name],stage,timeout=5).decode('utf-8').strip().split()
 if len(parts)!=2 or parts[0]!=name: fail(stage+'_shape')
 return parts[1]
def private_source(value):
 try: network=ipaddress.ip_network(value if '/' in value else value+'/32',strict=True)
 except ValueError: fail('firewall_source_invalid')
 if network.version!=4: fail('firewall_source_invalid')
 private_ranges=[ipaddress.ip_network('10.0.0.0/8'),ipaddress.ip_network('172.16.0.0/12'),ipaddress.ip_network('192.168.0.0/16')]
 if network.prefixlen!=32 and not any(network.subnet_of(candidate) for candidate in private_ranges): fail('firewall_source_public')
 return str(network)
try: expected=json.loads(__import__('base64').b64decode(sys.argv[1],validate=True),object_pairs_hook=unique)
except Exception: fail('inspection_input_invalid')
if not isinstance(expected,dict) or set(expected)!={'computerId','vmid','guestPrivateIpv4','publicIpv4','inspectionRevision'}: fail('inspection_input_shape')
uuid=r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
if not re.fullmatch(uuid,str(expected['computerId']),re.I): fail('computer_identity_invalid')
if not isinstance(expected['vmid'],int) or expected['vmid']<100: fail('vm_identity_invalid')
try: expected_ip=ipaddress.ip_address(expected['guestPrivateIpv4'])
except ValueError: fail('guest_ip_invalid')
private_ranges=[ipaddress.ip_network('10.0.0.0/8'),ipaddress.ip_network('172.16.0.0/12'),ipaddress.ip_network('192.168.0.0/16')]
if expected_ip.version!=4 or not any(expected_ip in candidate for candidate in private_ranges): fail('guest_ip_not_private')
try: public_ip=ipaddress.ip_address(expected['publicIpv4'])
except ValueError: fail('public_ip_invalid')
if public_ip.version!=4 or public_ip.is_private or public_ip.is_loopback or public_ip.is_link_local or public_ip.is_multicast or public_ip.is_unspecified: fail('public_ip_invalid')
addresses=json.loads(run(['/usr/bin/ip','-j','-4','address','show','up','scope','global'],'guest_ip',timeout=5),object_pairs_hook=unique)
observed_ips=[]
for interface in addresses:
 for address in interface.get('addr_info',[]):
  if address.get('family')=='inet' and address.get('scope')=='global': observed_ips.append(address.get('local'))
if observed_ips.count(str(expected_ip))!=1: fail('guest_ip_mismatch')
guardian=pathlib.Path('/usr/local/libexec/hivra/omarchy-native-supervisor.py')
ownership=pathlib.Path('/usr/local/libexec/hivra/omarchy-sunshine-ownership.py')
guardian_raw=read_regular(guardian,0,'guardian_source',1048576,True)
ownership_raw=read_regular(ownership,0,'ownership_source',1048576)
guardian_sha=hashlib.sha256(guardian_raw).hexdigest(); ownership_sha=hashlib.sha256(ownership_raw).hexdigest()
if guardian_sha!='${OMARCHY_NATIVE_GUARDIAN_SHA256}' or ownership_sha!='${OMARCHY_NATIVE_OWNERSHIP_SHA256}': fail('guardian_source_mismatch')
for parent in (pathlib.Path('/usr/local/libexec'),pathlib.Path('/usr/local/libexec/hivra')):
 try: info=os.lstat(parent)
 except OSError: fail('guardian_parent_missing')
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022: fail('guardian_parent_unsafe')
prepared_path=pathlib.Path('/var/lib/hivra/omarchy-native-v3')/expected['computerId']/'prepared.json'
prepared_raw=read_regular(prepared_path,0,'guardian_prepared',1048576)
prepared_sha=hashlib.sha256(prepared_raw).hexdigest()
try: prepared=json.loads(prepared_raw,object_pairs_hook=unique)
except Exception: fail('guardian_prepared_invalid')
if not isinstance(prepared,dict) or set(prepared)!={'intent','files','directories'}: fail('guardian_prepared_shape')
intent=prepared['intent']
if (not isinstance(intent,dict) or set(intent)!={'protocol','binding','sunshineSource','activation'}
    or intent.get('protocol')!='hivra-omarchy-native-guardian-preparation-v3'
    or intent.get('sunshineSource')!='14ffa6fdaa53f7b51512be2b3d24f3939695403c'
    or intent.get('activation')!='forbidden'): fail('guardian_intent_mismatch')
binding=intent.get('binding')
if (not isinstance(binding,dict) or set(binding)!={'computerId','operationId','vmid','ownerUid','guestPrivateIpv4','waylandDisplay'}
    or binding.get('computerId')!=expected['computerId'] or binding.get('vmid')!=expected['vmid']
    or binding.get('guestPrivateIpv4')!=str(expected_ip) or not re.fullmatch(uuid,str(binding.get('operationId','')),re.I)
    or type(binding.get('ownerUid')) is not int or binding['ownerUid']<1000
    or not re.fullmatch(r'wayland-[0-9]{1,3}',str(binding.get('waylandDisplay','')))): fail('guardian_binding_mismatch')
observation=run(['/usr/bin/python3','-I','-B',str(guardian),'observe'],'guardian_observe',json.dumps(binding,separators=(',',':')).encode(),10)
try: observed=json.loads(observation,object_pairs_hook=unique)
except Exception: fail('guardian_observation_invalid')
if observed!={'protocol':'hivra-omarchy-native-guardian-preparation-v3','binding':binding,'administrationPrepared':True,'activation':'forbidden','desktopReady':False}: fail('guardian_observation_mismatch')
pids=[]
for candidate in pathlib.Path('/proc').iterdir():
 if not candidate.name.isdigit(): continue
 try:
  if (candidate/'comm').read_text(encoding='utf-8').strip()=='sunshine': pids.append(candidate.name)
 except OSError: pass
if pids: fail('sunshine_process_conflict')
protected_tcp={47984,47989,47990,48010}; protected_udp={47998,47999,48000,48002,48010}
for protocol,ports in (('tcp',protected_tcp),('udp',protected_udp)):
 for suffix in ('','6'):
  lines=(pathlib.Path('/proc/net')/(protocol+suffix)).read_text().splitlines()
  if not lines or 'local_address' not in lines[0]: fail('socket_observation_invalid')
  for line in lines[1:]:
   parts=line.split()
   if len(parts)<10 or not re.fullmatch(r'[0-9A-Fa-f]+:[0-9A-Fa-f]{4}',parts[1]): fail('socket_observation_invalid')
   if int(parts[1].rsplit(':',1)[1],16) in ports and (protocol=='udp' or parts[3]!='06'): fail('sunshine_listener_conflict')
active=pathlib.Path('/var/lib/hivra/omarchy-native-v3-leases')/expected['computerId']/'active.json'
if os.path.lexists(active): fail('guardian_active_lease_conflict')
omarchy_version=package('omarchy','omarchy_package'); sunshine_version=package('sunshine','sunshine_package')
if omarchy_version!='${EXPECTED_OMARCHY_PACKAGE_VERSION}' or sunshine_version!='${EXPECTED_SUNSHINE_VERSION}': fail('package_pin_mismatch')
sunshine_raw=read_regular(pathlib.Path('/usr/bin/sunshine'),0,'sunshine_binary',268435456,True)
sunshine_sha=hashlib.sha256(sunshine_raw).hexdigest()
firewall_verbose=run(['/usr/bin/ufw','status','verbose'],'firewall_status',timeout=5).decode()
if 'Status: active' not in firewall_verbose.splitlines() or not re.search(r'^Default: deny \(incoming\)(,|$)',firewall_verbose,re.M): fail('firewall_default_mismatch')
firewall_numbered=run(['/usr/bin/ufw','status','numbered'],'firewall_rules',timeout=5).decode()
expected_tcp=${JSON.stringify(EXPECTED_TCP_PORTS)}; expected_udp=${JSON.stringify(EXPECTED_UDP_PORTS)}
protected={(port,'tcp') for port in expected_tcp}|{(port,'udp') for port in expected_udp}; routes={key:set() for key in protected}
for raw_line in firewall_numbered.splitlines():
 if 'ALLOW IN' not in raw_line: continue
 line=re.sub(r'^\[[^]]+\]\s*','',raw_line).strip(); left,right=line.split('ALLOW IN',1); left=left.strip(); v6=left.endswith(' (v6)')
 if v6: left=left[:-5].strip()
 match=re.fullmatch(r'([0-9]+)/(tcp|udp)',left)
 if not match:
  mentioned={int(port) for port in re.findall(r'(?<![0-9])([0-9]{1,5})(?![0-9])',left)}
  if mentioned&({47984,47989,47990,48010,5353,47998,47999,48000,48002}): fail('firewall_destination_ambiguous')
  continue
 key=(int(match.group(1)),match.group(2))
 if key==(47990,'tcp'): fail('sunshine_admin_exposed')
 if key not in protected: continue
 if v6 or 'hivra-sunshine' not in right: fail('sunshine_firewall_unscoped')
 source=right.strip().split()[0] if right.strip() else ''; routes[key].add(private_source(source))
source_sets=[routes[(port,'tcp')] for port in expected_tcp]+[routes[(port,'udp')] for port in expected_udp]
if any(not values for values in source_sets) or any(values!=source_sets[0] for values in source_sets[1:]): fail('sunshine_firewall_incomplete')
web_root=pathlib.Path('/usr/local/libexec/hivra')
for name,expected_sha in (('install-omarchy-web.py','${OMARCHY_WEB_INSTALLER_SHA256}'),('broker.cjs','${OMARCHY_WEB_BROKER_SHA256}'),('omarchy-web-broker.cjs','${OMARCHY_WEB_ADAPTER_SHA256}'),('omarchy-web-server.cjs','${OMARCHY_WEB_SERVER_SHA256}')):
 raw=read_regular(web_root/name,0,'web_'+name.replace('.','_'),1048576,name.endswith('.py'))
 if hashlib.sha256(raw).hexdigest()!=expected_sha: fail('web_source_mismatch')
import ast
installer_ast=ast.parse(read_regular(web_root/'install-omarchy-web.py',0,'web_installer_policy',1048576,True))
derived={node.targets[0].id:ast.literal_eval(node.value) for node in installer_ast.body if isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and node.targets[0].id in ('LAYOUT_SERVICE','LAYOUT_ADAPTER','LAYOUT_BOOT')}
for key,path in (('LAYOUT_SERVICE','/opt/hivra/omarchy-web/layout-service.py'),('LAYOUT_ADAPTER','/opt/hivra/omarchy-web/python-policy/hivra_layout_policy.py'),('LAYOUT_BOOT','/opt/hivra/omarchy-web/python-policy/sitecustomize.py')):
 if key not in derived or hashlib.sha256(read_regular(pathlib.Path(path),0,'web_layout_policy',1048576,False)).hexdigest()!=hashlib.sha256(derived[key].encode()).hexdigest(): fail('web_layout_policy_mismatch')
for unit in ('hivra-omarchy-layout.service','hivra-omarchy-web.service','hivra-omarchy-web-broker.service'):
 if run(['/usr/bin/systemctl','is-active',unit],'web_service',timeout=5).strip()!=b'active': fail('web_service_inactive')
selkies_image='ghcr.io/selkies-project/selkies/desktop@sha256:395336daf8a8552949da12a969e0d7a0893309a01e65c81fb75bb0cbab3e3756'
node_image='node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
for name,image in (('hivra-omarchy-web',selkies_image),('hivra-omarchy-web-broker',node_image)):
 raw=run(['/usr/bin/docker','inspect',name],'web_container',timeout=5)
 try: rows=json.loads(raw,object_pairs_hook=unique)
 except Exception: fail('web_container_invalid')
 if len(rows)!=1 or rows[0].get('State',{}).get('Running') is not True or rows[0].get('Config',{}).get('Image')!=image: fail('web_container_mismatch')
 if name=='hivra-omarchy-web':
  config=rows[0].get('Config',{}); env=config.get('Env',[])
  if any(value not in env for value in ('SELKIES_USE_CSS_SCALING=true|locked','SELKIES_SCALING_DPI=96','PYTHONPATH=/opt/hivra-python-policy')): fail('web_layout_boot_mismatch')
  for destination,source in (('/opt/hivra-layout','/opt/hivra/omarchy-web/layout-runtime'),('/opt/hivra-python-policy','/opt/hivra/omarchy-web/python-policy')):
   matches=[m for m in rows[0].get('Mounts',[]) if m.get('Destination')==destination]
   if len(matches)!=1 or matches[0].get('Type')!='bind' or matches[0].get('Source')!=source or matches[0].get('RW') is not False: fail('web_layout_mount_mismatch')
try:
 connection=__import__('http.client').client.HTTPConnection(str(expected_ip),8090,timeout=3); connection.request('GET','/desktop/handoff',headers={'Host':'omarchy-canary.hermesos.cloud'}); response=connection.getresponse(); web_status=response.status; response.read(1024); connection.close()
except Exception: fail('web_broker_unreachable')
if web_status!=200: fail('web_broker_unready')
boot_id=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
if not re.fullmatch(uuid,boot_id,re.I): fail('guest_boot_invalid')
boottime_ns=time.clock_gettime_ns(time.CLOCK_BOOTTIME)
now=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
descriptor={'protocol':'hivra-omarchy-native-prepared-v2','computerId':expected['computerId'],'vmid':expected['vmid'],'profile':'omarchy','guestPrivateIpv4':str(expected_ip),'inspectionRevision':expected['inspectionRevision'],'preparationOperationId':binding['operationId'],'serviceOwnerUid':binding['ownerUid'],'waylandDisplay':binding['waylandDisplay'],'omarchyPackageVersion':omarchy_version,'sunshineVersion':sunshine_version,'guardianSha256':guardian_sha,'ownershipSha256':ownership_sha,'sunshineSha256':sunshine_sha,'preparedSha256':prepared_sha,'guestBootId':boot_id,'observedBoottimeNs':str(boottime_ns),'compositor':'wayland-hyprland','webBrokerOrigin':'${OMARCHY_WEB_BROKER_ORIGIN}','webSelkiesImage':selkies_image,'webNodeImage':node_image,'route':{'status':'configured-proven','publicIpv4':str(public_ip),'tcpPorts':expected_tcp,'udpPorts':expected_udp,'sourceCidrs':sorted(source_sets[0])},'privateNetworkReachable':True,'supportsInputTakeover':True,'observedAt':now}
print('${OMARCHY_NATIVE_PREPARED_MARKER}'+json.dumps(descriptor,sort_keys=True,separators=(',',':'))) `;

export const OMARCHY_NATIVE_INSPECTION_REVISION = createHash("sha256")
  .update(GUEST_PROGRAM)
  .digest("hex");

export const OMARCHY_NATIVE_SESSION_REVISION = createHash("sha256")
  .update([
    "hivra-omarchy-native-session-v2",
    OMARCHY_NATIVE_INSPECTION_REVISION,
    OMARCHY_NATIVE_GUARDIAN_SHA256,
    OMARCHY_NATIVE_OWNERSHIP_SHA256,
  ].join("\n"))
  .digest("hex");

export const OMARCHY_DESKTOP_SESSION_REVISION = createHash("sha256")
  .update([
    "hivra-omarchy-desktop-session-v1",
    OMARCHY_NATIVE_SESSION_REVISION,
    OMARCHY_WEB_INSTALLER_SHA256,
    OMARCHY_WEB_BROKER_SHA256,
    OMARCHY_WEB_ADAPTER_SHA256,
    OMARCHY_WEB_SERVER_SHA256,
  ].join("\n"))
  .digest("hex");

const Route = z.object({
  status: z.literal("configured-proven"),
  publicIpv4: z.string().regex(IPV4).refine(publicIpv4),
  tcpPorts: z.tuple([z.literal(47984), z.literal(47989), z.literal(48010)]),
  udpPorts: z.tuple([
    z.literal(5353), z.literal(47998), z.literal(47999),
    z.literal(48000), z.literal(48002), z.literal(48010),
  ]),
  sourceCidrs: z.array(z.string().regex(IPV4_SOURCE_CIDR).refine(safeSourceCidr))
    .min(1).max(32)
    .refine(values => values.every((value, index) => index === 0 || values[index - 1] < value)),
}).strict();

const Descriptor = z.object({
  protocol: z.literal("hivra-omarchy-native-prepared-v2"),
  computerId: z.string().uuid(),
  vmid: z.number().int().min(100),
  profile: z.literal("omarchy"),
  guestPrivateIpv4: z.string().regex(IPV4),
  inspectionRevision: z.literal(OMARCHY_NATIVE_INSPECTION_REVISION),
  preparationOperationId: z.string().uuid(),
  serviceOwnerUid: z.number().int().min(1000),
  waylandDisplay: z.string().regex(/^wayland-[0-9]{1,3}$/),
  omarchyPackageVersion: z.literal(EXPECTED_OMARCHY_PACKAGE_VERSION),
  sunshineVersion: z.literal(EXPECTED_SUNSHINE_VERSION),
  guardianSha256: z.literal(OMARCHY_NATIVE_GUARDIAN_SHA256),
  ownershipSha256: z.literal(OMARCHY_NATIVE_OWNERSHIP_SHA256),
  sunshineSha256: z.string().regex(SHA256),
  preparedSha256: z.string().regex(SHA256),
  guestBootId: z.string().uuid(),
  observedBoottimeNs: z.string().regex(/^[1-9][0-9]{0,18}$/),
  compositor: z.literal("wayland-hyprland"),
  webBrokerOrigin: z.literal(OMARCHY_WEB_BROKER_ORIGIN),
  webSelkiesImage: z.literal("ghcr.io/selkies-project/selkies/desktop@sha256:395336daf8a8552949da12a969e0d7a0893309a01e65c81fb75bb0cbab3e3756"),
  webNodeImage: z.literal("node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32"),
  route: Route,
  privateNetworkReachable: z.literal(true),
  supportsInputTakeover: z.literal(true),
  observedAt: z.string().datetime({ offset: true }),
}).strict();

export type PreparedOmarchyNativeDescriptor = z.infer<typeof Descriptor>;

function privateIpv4(value: string): boolean {
  if (!IPV4.test(value)) return false;
  const octets = value.split(".").map(Number);
  if (octets.some(octet => octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function publicIpv4(value: string): boolean {
  if (!IPV4.test(value)) return false;
  const octets = value.split(".").map(Number);
  return octets.every(octet => octet >= 0 && octet <= 255)
    && !privateIpv4(value) && octets[0] !== 0 && octets[0] !== 127
    && octets[0] < 224 && value !== "255.255.255.255";
}

function safeSourceCidr(value: string): boolean {
  if (!IPV4_SOURCE_CIDR.test(value)) return false;
  const [address, rawPrefix] = value.split("/");
  const octets = address.split(".").map(Number);
  if (octets.some(octet => octet < 0 || octet > 255)) return false;
  const prefix = Number(rawPrefix);
  const ip = octets.reduce((result, octet) => ((result << 8) | octet) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  if (((ip & mask) >>> 0) !== ip) return false;
  if (prefix === 32) return true;
  if (!privateIpv4(address)) return false;
  if (octets[0] === 10) return prefix >= 8;
  if (octets[0] === 172) return prefix >= 12;
  return prefix >= 16;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function descriptorRevision(descriptor: PreparedOmarchyNativeDescriptor): string {
  const identity = Object.fromEntries(
    Object.entries(descriptor).filter(([key]) => key !== "observedAt" && key !== "observedBoottimeNs"),
  );
  return createHash("sha256").update(stableJson(identity)).digest("hex");
}

function generationFromRevision(revision: string): string {
  const bytes = Buffer.from(revision.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildPreparedOmarchyNativeCapabilityInspectionScript(input: {
  computerId: string;
  vmid: number;
  guestIp: string;
  publicIpv4: string;
  infrastructureBindingTag: string;
}): string {
  if (!UUID.test(input.computerId) || !Number.isSafeInteger(input.vmid) || input.vmid < 100
    || !privateIpv4(input.guestIp) || !publicIpv4(input.publicIpv4)
    || !/^hivra-bind-[a-f0-9]{32}$/.test(input.infrastructureBindingTag)) {
    throw new Error("Invalid prepared Omarchy inspection binding.");
  }
  const program = Buffer.from(GUEST_PROGRAM, "utf8").toString("base64");
  const expected = Buffer.from(JSON.stringify({
    computerId: input.computerId,
    vmid: input.vmid,
    guestPrivateIpv4: input.guestIp,
    publicIpv4: input.publicIpv4,
    inspectionRevision: OMARCHY_NATIVE_INSPECTION_REVISION,
  }), "utf8").toString("base64");
  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
VMID=${input.vmid}
GUEST_IP=${shellQuote(input.guestIp)}
PUBLIC_IP=${shellQuote(input.publicIpv4)}
EXPECTED_BINDING_TAG=${shellQuote(input.infrastructureBindingTag)}
[[ "$VMID" =~ ^[0-9]+$ ]] && [ "$VMID" -ge 100 ]
[ -n "$EXPECTED_BINDING_TAG" ]
[ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = 'running' ]
VM_CONFIG="$(qm config "$VMID")"
TAGS="$(printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' | grep -Fxq "ip=$GUEST_IP/24"
NFT_RULESET="$(nft list ruleset)"
printf '%s\n' "$NFT_RULESET" | grep -Fq "ip daddr $PUBLIC_IP tcp dport { 47984, 47989, 48010 } dnat to $GUEST_IP"
printf '%s\n' "$NFT_RULESET" | grep -Fq "ip daddr $PUBLIC_IP udp dport { 47998, 47999, 48000, 48002, 48010 } dnat to $GUEST_IP"
printf '%s\n' "$NFT_RULESET" | grep -Fq "ip daddr $GUEST_IP tcp dport { 47984, 47989, 48010 } accept"
printf '%s\n' "$NFT_RULESET" | grep -Fq "ip daddr $GUEST_IP udp dport { 47998, 47999, 48000, 48002, 48010 } accept"
! printf '%s\n' "$NFT_RULESET" | grep -Eq 'dport([^0-9]|.*[^0-9])47990([^0-9]|$).*accept|dport([^0-9]|.*[^0-9])47990([^0-9]|$).*dnat'
${buildVmidBoundGuestExecPrelude()}
run_vmid_bound_guest_exec /bin/bash -c 'printf "%s" "$1" | /usr/bin/base64 --decode | /usr/bin/python3 -I -B - "$2"' hivra ${shellQuote(program)} ${shellQuote(expected)}
`;
}

export function parsePreparedOmarchyNativeCapability(
  stdout: string,
  expected: { computerId: string; vmid: number; guestIp: string },
): { descriptor: PreparedOmarchyNativeDescriptor; receipt: RemoteDesktopCapabilityReceipt } | null {
  const lines = stdout.split("\n").filter(line => line.startsWith(OMARCHY_NATIVE_PREPARED_MARKER));
  if (lines.length !== 1) return null;
  let raw: unknown;
  try { raw = JSON.parse(lines[0].slice(OMARCHY_NATIVE_PREPARED_MARKER.length)); }
  catch { return null; }
  const parsed = Descriptor.safeParse(raw);
  if (!parsed.success) return null;
  const descriptor = parsed.data;
  if (descriptor.computerId !== expected.computerId || descriptor.vmid !== expected.vmid
    || descriptor.guestPrivateIpv4 !== expected.guestIp || !privateIpv4(descriptor.guestPrivateIpv4)) return null;
  const observedAt = Date.parse(descriptor.observedAt);
  if (!Number.isFinite(observedAt) || Math.abs(Date.now() - observedAt) > 2 * 60_000) return null;
  const capabilityGeneration = generationFromRevision(descriptorRevision(descriptor));
  return {
    descriptor,
    receipt: {
      protocol: "hivra-remote-desktop-capability-v1",
      computerKind: "hivra-agent",
      computerId: descriptor.computerId,
      capabilityGeneration,
      bootIdentitySha256: createHash("sha256").update(descriptor.guestBootId.toLowerCase()).digest("hex"),
      observedRevision: OMARCHY_DESKTOP_SESSION_REVISION,
      compositor: "wayland",
      installedTransports: ["sunshine-moonlight", "selkies-websocket"],
      privateNetworkReachable: true,
      supportsInputTakeover: true,
      brokerOrigin: OMARCHY_WEB_BROKER_ORIGIN,
      observedAt: descriptor.observedAt,
    },
  };
}
