import { createHash } from "node:crypto";
import { shellQuote } from "./proxmox-target";
import { OmarchyRefreshRequestSchema, type OmarchyRefreshRequest } from "./prepared-omarchy-refresh-contract";

// The guest owns an operation-specific systemd unit. Native package helpers use
// their existing narrow sudo grants; migrations retain the desktop user's HOME.
export const OMARCHY_REFRESH_GUEST_STAGE = String.raw`import datetime,gzip,hashlib,json,os,pathlib,pwd,re,shlex,stat,subprocess,sys,time
base=pathlib.Path(sys.argv[1]);request=json.loads((base/'request.json').read_text())
def run(args,timeout=120):
 return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT,timeout=timeout)
def publish(name,value):
 p=base/(name+'.tmp');p.write_text(json.dumps(value));os.chmod(p,0o600);os.replace(p,base/name)
def owner():
 owners=set()
 for p in pathlib.Path('/proc').iterdir():
  if not p.name.isdigit():continue
  try:
   if (p/'comm').read_text().strip()!='Hyprland':continue
   m=re.search(r'^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$',(p/'status').read_text(),re.M)
   if m and len(set(m.groups()))==1 and int(m[1])>=1000:owners.add(int(m[1]))
  except (OSError,KeyError):pass
 if not owners:return None
 assert len(owners)==1,'desktop_owner_ambiguous'
 user=pwd.getpwuid(next(iter(owners)));assert pathlib.Path(user.pw_dir).parent==pathlib.Path('/home')
 return user
def version():
 text=run(['/usr/bin/pacman','-Q','omarchy']).strip();m=re.fullmatch(r'omarchy ([0-9]+\.[0-9]+\.[0-9]+-[0-9]+(?:\.[0-9]+)?)',text)
 assert m,'package_version_unavailable'
 values={}
 for line in pathlib.Path('/etc/os-release').read_text().splitlines():
  if line.startswith('VERSION_ID='):values['osVersion']=shlex.split(line.split('=',1)[1])[0]
 assert values.get('osVersion')==m[1].split('-')[0],'package_os_mismatch'
 return {'packageVersion':m[1],**values}
try:
 assert os.geteuid()==0
 if (base/'cancel').exists():raise RuntimeError('cancelled_before_update')
 user=None
 for attempt in range(30):
  user=owner()
  if user is not None:break
  time.sleep(3)
 assert user is not None,'desktop_owner_unavailable'
 runtime='/run/user/'+str(user.pw_uid)
 addresses=json.loads(run(['/usr/bin/ip','-j','-4','addr','show']))
 assert any(a.get('local')==request['slot']['ip'] for item in addresses for a in item.get('addr_info',[])),'guest_ip_mismatch'
 prefix=['/usr/bin/runuser','-u',user.pw_name,'--','env','OMARCHY_UPDATE_UNATTENDED=1','OMARCHY_PATH=/usr/share/omarchy',
  'OMARCHY_MIGRATION_STATE='+str(pathlib.Path(user.pw_dir)/'.local/state/omarchy/migrations'),'XDG_RUNTIME_DIR='+runtime,'DBUS_SESSION_BUS_ADDRESS=unix:path='+runtime+'/bus','PATH=/usr/local/bin:/usr/bin:/bin']
 run(prefix+['sudo','-n','-l','/usr/bin/omarchy-update-system-pkgs'])
 servers=run(['/usr/bin/pacman-conf','--repo','omarchy','Server']).splitlines()
 assert servers and all(re.fullmatch(r'https://pkgs\.omarchy\.org/stable/(?:x86_64|\$arch)',x.strip()) for x in servers),'unstable_package_channel'
 assert int(run(['/usr/bin/df','-Pm','/']).splitlines()[1].split()[3])>4096,'insufficient_update_space'
 backup=base/'backup';backup.mkdir(mode=0o700,exist_ok=True)
 (backup/'boot-id.before').write_text(pathlib.Path('/proc/sys/kernel/random/boot_id').read_text())
 (backup/'root-snapshot.number').write_text(run(['/usr/bin/snapper','-c','root','create','--print-number','--description','Hivra prepared refresh '+request['operationId']]))
 run(['/usr/bin/btrfs','subvolume','snapshot','-r','/home',str(backup/'home.snapshot')])
 captured=False
 def boot_manifest():
  return sorted((str(p.relative_to('/boot')),p.stat().st_size,p.stat().st_mtime_ns) for p in pathlib.Path('/boot').rglob('*') if p.is_file())
 # Snapper's Limine integration can still be publishing history. Only retry this
 # read-only backup when its before/after file manifest actually changed.
 for attempt in range(3):
  before=boot_manifest();p=subprocess.run(['/usr/bin/tar','-C','/boot','-cf',str(backup/'boot.tar.tmp'),'.'],capture_output=True,text=True,timeout=120)
  if p.returncode==0 and before==boot_manifest():
   os.replace(backup/'boot.tar.tmp',backup/'boot.tar');captured=True;break
  if p.returncode not in (0,1):raise RuntimeError('boot_backup_failed')
  time.sleep(5)
 assert captured,'boot_backup_unstable'
 run(['/usr/bin/tar','-C','/etc','-cf',str(backup/'etc.tar'),'.'])
 (backup/'packages.before').write_text(run(['/usr/bin/pacman','-Q']))
 publish('phase.json',{'phase':'updating'})
 command='sudo -n /usr/bin/omarchy-update-keyring; sudo -n /usr/bin/omarchy-update-system-pkgs'
 with (base/'update.log').open('w') as log:
  subprocess.run(prefix+['/usr/bin/omarchy-update-lock','run','/bin/bash','-euo','pipefail','-c',command],stdout=log,stderr=subprocess.STDOUT,check=True)
 # Only these six reviewed system migrations may run as root. A changed
 # migration must pass both this reviewed digest and installed-package MTREE.
 reviewed={
  '1788662350':'6c40ba5ec6c0a90c583d6067a733ad315c7a6e0e3ba302c39396eb3e829fe965',
  '1789325478':'34f5374c4d92eb0f943a1272b58294c9d7265ca3d91a6b3609a44278f8480955',
  '1789444024':'774584d820d0e4ac2940fb4d465b84ac4facf0a296438c9f2681b9efccc6f11e',
  '1791403252':'fb380a285eca3a1f7e38cf3cc88c523f2cf93c6559486ec8bb17302f923aa0e6',
  '1791581004':'18066ee208c7db676b78353dd9caca25640bf44fa7663371cea3f1a814fd3eb8',
  '1791621765':'c0510b53de9daf42f0b82846d309442df53635f1b9695b90d1a3d9f4c0342b3d'}
 package_version=version()['packageVersion'];state=pathlib.Path(user.pw_dir)/'.local/state/omarchy/migrations'
 mtree_path=pathlib.Path('/var/lib/pacman/local')/('omarchy-'+package_version)/'mtree'
 for migration,digest in reviewed.items():
  name=migration+'.sh';source=pathlib.Path('/usr/share/omarchy/migrations')/name
  if (state/name).exists() or not source.exists():continue
  for target in [source,mtree_path]:
   for ancestor in [target,*target.parents]:
    info=ancestor.lstat();assert info.st_uid==0 and not info.st_mode&0o022 and not stat.S_ISLNK(info.st_mode),'migration_path_not_root_controlled'
  info=source.stat();assert stat.S_ISREG(info.st_mode),'migration_not_regular'
  assert hashlib.sha256(source.read_bytes()).hexdigest()==digest,'system_migration_needs_review'
  manifest=gzip.open(mtree_path,'rt').read()
  entry=next((x for x in manifest.splitlines() if x.startswith('./usr/share/omarchy/migrations/'+name+' ')),None)
  assert entry and re.search(r'sha256digest='+digest+r'(?: |$)',entry),'migration_package_digest_mismatch'
  env={**os.environ,'HOME':'/root','OMARCHY_PATH':'/usr/share/omarchy','OMARCHY_UPDATE_UNATTENDED':'1','PATH':'/usr/local/bin:/usr/bin:/bin'}
  env.pop('OMARCHY_MIGRATION_STATE',None)
  with (base/'system-migrations.log').open('a') as log:
   subprocess.run(['/bin/bash','-euo','pipefail',str(source)],env=env,stdout=log,stderr=subprocess.STDOUT,check=True)
  run(['/usr/bin/runuser','-u',user.pw_name,'--','mkdir','-p',str(state)])
  run(['/usr/bin/runuser','-u',user.pw_name,'--','touch',str(state/name)])
  if migration=='1789325478':run(prefix+['/usr/bin/omarchy-state','set','reboot-required'])
 with (base/'user-migrations.log').open('w') as log:
  subprocess.run(prefix+['/bin/bash','-euo','pipefail','-c','omarchy-migrate; omarchy-hook post-update'],stdout=log,stderr=subprocess.STDOUT,check=True)
 pending=subprocess.run(prefix+['/usr/bin/omarchy-migrate','--pending'],capture_output=True,text=True,timeout=30)
 assert pending.returncode==1 and not pending.stdout.strip() and not pending.stderr.strip(),'omarchy_migrations_pending'
 observed=version();assert observed['osVersion']==request['release']['release'][1:],'requested_release_not_installed'
 kernel_package=run(['/usr/bin/pacman','-Q','linux-omarchy']).strip().split()
 assert len(kernel_package)==2 and re.fullmatch(r'[0-9A-Za-z._+-]+',kernel_package[1]),'kernel_package_unavailable'
 selected=kernel_package[1]+'-omarchy'
 config=pathlib.Path('/boot/limine.conf').read_text()
 assert re.search(r'^default_entry:\s*2\s*$',config,re.M),'boot_selection_unverified'
 entries=list(re.finditer(r'^  //[^\n]+\n',config,re.M))
 assert entries and entries[0].group()=='  //linux-omarchy\n','selected_kernel_mismatch'
 a=entries[0].start();end=entries[1].start() if len(entries)>1 else len(config);entry=config[a:end]
 assert 'Kernel version: '+selected in entry,'selected_kernel_mismatch'
 m=re.search(r'path: boot\(\):([^#\n]+)#([0-9a-f]+)',entry);assert m,'boot_uki_unavailable'
 uki=pathlib.Path('/boot'+m[1]);assert uki.is_file() and uki.resolve().is_relative_to(pathlib.Path('/boot').resolve()),'boot_uki_unsafe'
 digest=hashlib.blake2b()
 with uki.open('rb') as stream:
  for chunk in iter(lambda:stream.read(1048576),b''):digest.update(chunk)
 assert digest.hexdigest()==m[2],'boot_uki_digest_mismatch'
 publish('result.json',{**observed,'selectedKernel':selected,'bootIdBefore':(backup/'boot-id.before').read_text().strip(),'ownerUid':user.pw_uid,'ownerName':user.pw_name})
 (base/'update.exit').write_text('0\n')
except BaseException as error:
 publish('failure.json',{'errorCode':str(error) if re.fullmatch(r'[a-z][a-z0-9_]{0,63}',str(error)) else 'native_update_failed'})
 (base/'update.exit').write_text('1\n')
 raise
`;

// A short, guest-side dispatch fence serializes bootstrap with cancellation. A
// late QGA bootstrap cannot start an updater after cancellation is proven.
export const OMARCHY_REFRESH_GUEST_CONTROL = String.raw`import base64,fcntl,json,os,pathlib,re,subprocess,sys
mode=sys.argv[1];request=json.loads(base64.b64decode(sys.argv[2]));source=base64.b64decode(sys.argv[3])
operation=request['operationId'];assert re.fullmatch(r'[a-f0-9-]{36}',operation)
base=pathlib.Path('/var/lib/hivra/prepared-omarchy-refresh')/operation;base.mkdir(parents=True,exist_ok=True,mode=0o700)
lock=(base/'dispatch.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX)
manifest=json.dumps(request,sort_keys=True,separators=(',',':'))
if (base/'request.json').exists():assert (base/'request.json').read_text()==manifest,'guest_operation_identity_mismatch'
else:
 (base/'request.json').write_text(manifest);os.chmod(base/'request.json',0o600)
unit='hivra-prepared-omarchy-'+operation+'.service'
def active():
 p=subprocess.run(['systemctl','show',unit,'--property=ActiveState','--value'],capture_output=True,text=True)
 return p.returncode==0 and p.stdout.strip() in ('activating','active','deactivating','reloading')
if mode=='cancel':(base/'cancel').touch(mode=0o600)
if mode=='start' and not (base/'cancel').exists() and not (base/'update.exit').exists():
 if not (base/'stage.py').exists():
  (base/'stage.py').write_bytes(source);os.chmod(base/'stage.py',0o600)
  (base/'dispatch.intent').touch(mode=0o600)
  subprocess.run(['systemd-run','--quiet','--collect','--unit='+unit,'--property=Type=exec','--property=KillMode=control-group','--property=RuntimeMaxSec=1500','--property=TimeoutStopSec=30',
   '/usr/bin/python3',str(base/'stage.py'),str(base)],check=True,capture_output=True,text=True,timeout=15)
 elif not active():raise RuntimeError('guest_update_dispatch_unconfirmed')
state={'active':active(),'cancelled':(base/'cancel').exists()}
if (base/'update.exit').exists():
 state['exitCode']=int((base/'update.exit').read_text().strip())
 if (base/'result.json').exists():state['result']=json.loads((base/'result.json').read_text())
 if (base/'failure.json').exists():state['failure']=json.loads((base/'failure.json').read_text())
print(json.dumps(state))
`;

export const OMARCHY_REFRESH_GUEST_ACCEPTANCE = String.raw`import datetime,json,pathlib,pwd,re,shlex,subprocess,sys
expected=json.loads(sys.argv[1]);uid=expected['ownerUid'];user=pwd.getpwuid(uid);assert user.pw_name==expected['ownerName']
def run(args):return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT,timeout=8).strip()
package=run(['/usr/bin/pacman','-Q','omarchy']).split();assert len(package)==2
os_version=None
for line in pathlib.Path('/etc/os-release').read_text().splitlines():
 if line.startswith('VERSION_ID='):os_version=shlex.split(line.split('=',1)[1])[0]
assert os_version==package[1].split('-')[0]==expected['osVersion'],'package_os_mismatch'
kernel=run(['uname','-r']);assert kernel==expected['selectedKernel'],'running_kernel_mismatch'
boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip();assert boot!=expected['bootIdBefore'],'boot_not_changed'
for name in ['Hyprland','pipewire','wireplumber']:
 assert run(['pgrep','-u',str(uid),'-xc',name])=='1','desktop_process_unavailable'
for name in ['hivra-omarchy-layout.service','hivra-omarchy-web-broker.service','hivra-omarchy-web.service']:
 assert run(['systemctl','is-active',name])=='active','desktop_service_unavailable'
audio=run(['runuser','-u',user.pw_name,'--','env','XDG_RUNTIME_DIR=/run/user/'+str(uid),'pactl','info'])
assert re.search(r'^Default Sink:\s*\S+',audio,re.M) and re.search(r'^Default Source:\s*\S+',audio,re.M),'desktop_audio_unavailable'
pending=subprocess.run(['runuser','-u',user.pw_name,'--','env','OMARCHY_PATH=/usr/share/omarchy','OMARCHY_MIGRATION_STATE='+str(pathlib.Path(user.pw_dir)/'.local/state/omarchy/migrations'),'/usr/bin/omarchy-migrate','--pending'],capture_output=True,text=True,timeout=15)
assert pending.returncode==1 and not pending.stdout.strip() and not pending.stderr.strip(),'omarchy_migrations_pending'
print(json.dumps({'packageVersion':package[1],'osVersion':os_version,'kernelRelease':kernel,'selectedKernel':expected['selectedKernel'],
 'bootIdBefore':expected['bootIdBefore'],'bootIdAfter':boot,'desktopReady':True,'migrationsComplete':True,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')}))
`;

export const OMARCHY_REFRESH_HOST_RUNNER = String.raw`import base64,fcntl,json,os,pathlib,re,socket,subprocess,sys,time
base=pathlib.Path(sys.argv[1]);request=json.loads((base/'request.json').read_text());vmid=str(request['slot']['vmid'])
root=base.parent;operation=request['operationId'];unit='hivra-prepared-omarchy-'+operation+'.service'
guest_source=(base/'guest-stage.py').read_bytes();guest_control=(base/'guest-control.py').read_text();acceptance=(base/'guest-acceptance.py').read_text()
def atomic(name,value):
 p=base/(name+'.tmp');p.write_text(json.dumps(value));os.chmod(p,0o600);os.replace(p,base/name)
def phase(value):atomic('phase.json',{'phase':value})
def run(args,timeout=30):return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT,timeout=timeout)
def identity(allow_absent=False):
 assert socket.gethostname().split('.')[0]==request['slot']['node'],'host_identity_mismatch'
 config=run(['qm','config',vmid]);slot=request['slot'];name=slot.get('name','hivra-omarchy-canary')
 assert re.search(r'^name:\s*'+re.escape(name)+r'\s*$',config,re.M),'vm_name_mismatch'
 assert 'hivra-omarchy-operation:'+slot['claim'] in config or 'hivra-omarchy-operation%3A'+slot['claim'] in config,'vm_claim_mismatch'
 tags=next((line.split(':',1)[1].strip().split(';') for line in config.splitlines() if line.startswith('tags:')),[])
 owned=request['bindingTag'];others=[x for x in tags if re.fullmatch(r'hivra-bind-[a-f0-9]{32}',x) and x!=owned]
 assert not others,'vm_binding_mismatch'
 assert owned in tags or allow_absent,'vm_binding_missing'
 return tags
encoded=base64.b64encode(json.dumps(request).encode()).decode();source=base64.b64encode(guest_source).decode()
def guest(code,args=[],timeout=30):
 identity(allow_absent=cancelled())
 value=json.loads(run(['qm','guest','exec',vmid,'--timeout','15','--synchronous','1','--','python3','-c',code,*args],timeout))
 assert type(value.get('exited')) in (bool,int) and value['exited']==1,'guest_command_unconfirmed'
 if value.get('exitcode')!=0:raise RuntimeError('guest_command_failed')
 return json.loads(value.get('out-data',''))
def control(mode):return guest(guest_control,[mode,encoded,source])
def cancelled():return (base/'cancel').exists()
def receipt(state,**extra):
 return {'version':1,'operationId':operation,'computerId':request['computerId'],'vmid':int(vmid),'bindingTag':request['bindingTag'],
  'requestedRelease':request['release'],'guestUpdaterStopped':True,'state':state,**extra}
def release_binding():
 tags=identity(allow_absent=True);tags=[x for x in tags if x!=request['bindingTag']]
 if tags:run(['qm','set',vmid,'--tags',';'.join(tags)])
 else:run(['qm','set',vmid,'--delete','tags'])
 assert request['bindingTag'] not in identity(allow_absent=True)
lock=pathlib.Path('/run/lock/hivra-prepared-'+vmid+'.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX)
try:
 identity(allow_absent=cancelled())
 deadline=time.monotonic()+1700
 existing=json.loads((base/'phase.json').read_text()).get('phase') if (base/'phase.json').exists() else 'queued'
 if existing not in ('rebooting','verifying'):
  if run(['qm','status',vmid]).strip().endswith('stopped'):
   if cancelled():
    release_binding();atomic('cancel-receipt.json',receipt('cancelled',bindingReleased=True));sys.exit(0)
   run(['qm','start',vmid],timeout=60)
  phase('updating')
  state=None
  while time.monotonic()<deadline:
   try:
    state=control('cancel' if cancelled() else 'start')
    if not state['active'] and (cancelled() or 'exitCode' in state):break
   except (subprocess.SubprocessError,AssertionError,ValueError):
    # QGA can be temporarily unavailable just after the prepared guest starts.
    # This only observes/re-dispatches the same fenced operation, not an update.
    pass
   time.sleep(3)
  else:raise RuntimeError('guest_update_unconfirmed')
  if cancelled():
   assert state is not None and not state['active'];release_binding();atomic('cancel-receipt.json',receipt('cancelled',bindingReleased=True));sys.exit(0)
  assert state is not None and state.get('exitCode')==0,'native_update_failed'
  expected=state['result'];atomic('expected.json',expected);phase('rebooting')
 else:expected=json.loads((base/'expected.json').read_text())
 if cancelled():
  state=control('cancel');assert not state['active'];release_binding();atomic('cancel-receipt.json',receipt('cancelled',bindingReleased=True));sys.exit(0)
 # A resumed host worker observes a new boot before deciding whether another
 # reboot is needed. A timeout never blindly repeats a completed reboot.
 status=run(['qm','status',vmid]).strip();current_boot=None
 if status.endswith('running'):
  try:current_boot=guest("import json,pathlib;print(json.dumps(pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()))")
  except (subprocess.SubprocessError,AssertionError,ValueError):pass
 if current_boot==expected['bootIdBefore']:
  phase('rebooting');run(['qm','shutdown',vmid,'--timeout','90','--forceStop','0'],timeout=105)
  assert run(['qm','status',vmid]).strip().endswith('stopped'),'graceful_shutdown_unconfirmed'
  run(['qm','start',vmid],timeout=60)
 elif status.endswith('stopped'):run(['qm','start',vmid],timeout=60)
 phase('verifying');observed=None;verify_deadline=min(deadline,time.monotonic()+180)
 while time.monotonic()<verify_deadline:
  try:
   observed=guest(acceptance,[json.dumps(expected)])
   if observed:break
  except (subprocess.SubprocessError,AssertionError,ValueError,RuntimeError):pass
  time.sleep(3)
 assert observed is not None,'desktop_recovery_unconfirmed'
 state=control('cancel' if cancelled() else 'observe');assert not state['active'],'guest_updater_still_active'
 if cancelled():release_binding();atomic('cancel-receipt.json',receipt('cancelled',bindingReleased=True))
 else:atomic('receipt.json',receipt('complete',observed=observed))
except BaseException as error:
 if isinstance(error,SystemExit):raise
 # Only a stopped, guest-fenced updater supports a terminal failure. Otherwise
 # retain the reservation and phase for inspection/resumption; never free it.
 try:
  state=control('cancel');assert not state['active']
  code=str(error) if re.fullmatch(r'[a-z][a-z0-9_]{0,63}',str(error)) else 'refresh_unconfirmed'
  atomic('receipt.json',receipt('failed',errorCode=code))
 except BaseException:phase('unconfirmed')
 raise
`;

function encoded(value: string | Buffer): string { return Buffer.from(value).toString("base64"); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}

/** Idempotent bounded queue/inspection; the durable host worker outlives HTTP. */
export function preparedOmarchyRefreshHostScript(input: OmarchyRefreshRequest, cancel = false): string {
  const request = OmarchyRefreshRequestSchema.parse(input);
  const manifest = JSON.stringify(canonical(request));
  const programs = {
    "runner.py": OMARCHY_REFRESH_HOST_RUNNER,
    "guest-stage.py": OMARCHY_REFRESH_GUEST_STAGE,
    "guest-control.py": OMARCHY_REFRESH_GUEST_CONTROL,
    "guest-acceptance.py": OMARCHY_REFRESH_GUEST_ACCEPTANCE,
  };
  const envelope = { request: encoded(manifest), hash: createHash("sha256").update(manifest).digest("hex"),
    programs: Object.fromEntries(Object.entries(programs).map(([k, v]) => [k, { source: encoded(v), sha256: createHash("sha256").update(v).digest("hex") }])), cancel };
  const dispatch = String.raw`import base64,fcntl,hashlib,json,os,pathlib,re,subprocess,sys
value=json.loads(base64.b64decode(sys.argv[1]));raw=base64.b64decode(value['request']);request=json.loads(raw)
assert hashlib.sha256(raw).hexdigest()==value['hash']
operation=request['operationId'];assert re.fullmatch(r'[a-f0-9-]{36}',operation)
base=pathlib.Path('/var/lib/hivra/prepared-omarchy-refresh')/operation;base.mkdir(parents=True,exist_ok=True,mode=0o700)
lock=(base/'dispatch.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX)
if (base/'request.json').exists():assert (base/'request.json').read_bytes()==raw,'refresh_manifest_changed'
else:(base/'request.json').write_bytes(raw);os.chmod(base/'request.json',0o600)
for name,item in value['programs'].items():
 source=base64.b64decode(item['source']);assert hashlib.sha256(source).hexdigest()==item['sha256']
 target=base/name
 if target.exists():assert target.read_bytes()==source,'refresh_program_changed'
 else:target.write_bytes(source);os.chmod(target,0o600)
if value['cancel']:(base/'cancel').touch(mode=0o600)
unit='hivra-prepared-omarchy-'+operation+'.service'
p=subprocess.run(['systemctl','show',unit,'--property=ActiveState','--value'],capture_output=True,text=True,timeout=4)
active=p.returncode==0 and p.stdout.strip() in ('active','activating','deactivating','reloading')
terminal=base/'cancel-receipt.json' if (base/'cancel-receipt.json').exists() else base/'receipt.json'
if value['cancel'] and not active and terminal.exists() and terminal.name!='cancel-receipt.json':
 # The completed updater can be cancelled before admission. Re-enter the same
 # worker with its cancellation fence; it removes only this reservation's tag.
 terminal=None
if terminal is not None and terminal.exists() and not active:
 result={'state':'terminal','receipt':json.loads(terminal.read_text())}
elif not active:
 subprocess.run(['systemctl','reset-failed',unit],capture_output=True,text=True,timeout=4)
 subprocess.run(['systemd-run','--quiet','--collect','--unit='+unit,'--property=Type=exec','--property=RuntimeMaxSec=1800',
  '/usr/bin/python3',str(base/'runner.py'),str(base)],check=True,capture_output=True,text=True,timeout=5)
 result={'state':'queued'}
else:
 phase=json.loads((base/'phase.json').read_text()).get('phase','queued') if (base/'phase.json').exists() else 'queued'
 result={'state':'running','phase':phase}
print('HIVRA_PREPARED_OMARCHY_REFRESH '+json.dumps(result))`;
  return `set -euo pipefail\npython3 -c ${shellQuote(dispatch)} ${shellQuote(encoded(JSON.stringify(envelope)))}`;
}
