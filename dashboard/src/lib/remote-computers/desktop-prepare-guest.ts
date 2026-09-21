import { shellQuote } from "@/lib/hivra/proxmox-target";
import type { DesktopPrepareReceipt } from "./desktop-prepare-operation";

const DESKTOP_PREPARE_MARKER = "HIVRA_DESKTOP_PREPARE_TERMINAL ";
type Identity = Pick<DesktopPrepareReceipt, "operationId" | "computerId" | "vmid" | "guestIp" | "bindingTag">;

// The guest lock outlives an SSH/QGA observer disconnect. A started operation
// without a terminal receipt is never automatically redispatched or unlocked.
export const DESKTOP_PREPARE_GUEST_PROGRAM = String.raw`import fcntl,json,os,pathlib,stat,subprocess,sys,tempfile
identity=json.loads(sys.argv[1]); mode=sys.argv[2]
root=pathlib.Path('/var/lib/hivra/desktop-preparations')
if mode=='run': root.mkdir(mode=0o700,parents=True,exist_ok=True)
info=os.lstat(root)
if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o700: raise SystemExit(1)
lock_path=root/'installer.lock'
flags=os.O_RDWR|os.O_NOFOLLOW|(os.O_CREAT if mode=='run' else 0)
lock_fd=os.open(lock_path,flags,0o600)
info=os.fstat(lock_fd)
if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o600: raise SystemExit(1)
fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
receipt_path=root/(identity['operationId']+'.json')
boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
def read_receipt():
 fd=os.open(receipt_path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as stream:
  info=os.fstat(stream.fileno())
  if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o600 or info.st_size>4096: raise SystemExit(1)
  return json.loads(stream.read(4097))
def publish(value):
 fd,tmp=tempfile.mkstemp(prefix='.receipt-',dir=root)
 try:
  with os.fdopen(fd,'w') as stream:
   os.fchmod(stream.fileno(),0o600); json.dump(value,stream,separators=(',',':')); stream.flush(); os.fsync(stream.fileno())
  os.replace(tmp,receipt_path)
  directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
  try: os.fsync(directory)
  finally: os.close(directory)
 finally:
  try: os.unlink(tmp)
  except FileNotFoundError: pass
def emit(value):
 if set(value)!=set(identity)|{'version','bootId','exitCode'} or any(value.get(k)!=v for k,v in identity.items()): raise SystemExit(1)
 if value.get('version')!=1 or value.get('bootId')!=boot or type(value.get('exitCode')) is not int or not 0<=value['exitCode']<=255: raise SystemExit(1)
 print('HIVRA_DESKTOP_PREPARE_TERMINAL '+json.dumps(value,separators=(',',':')))
if receipt_path.exists():
 emit(read_receipt()); raise SystemExit(0)
if mode!='run': raise SystemExit(1)
publish(dict(identity,version=1,bootId=boot,phase='started'))
try:
 result=subprocess.run(sys.argv[3:],stdout=subprocess.DEVNULL,check=False,pass_fds=(lock_fd,))
 code=result.returncode
 # A signal or ambiguous spawn/wait failure cannot prove dispatched children
 # stopped. Leave the durable started receipt and never unlock the DB lease.
 if not 0<=code<=255: raise SystemExit(1)
except Exception: raise SystemExit(1)
value=dict(identity,version=1,bootId=boot,exitCode=code)
publish(value); emit(value)
`;

export function desktopPrepareGuestCommand(identity: Identity, mode: "run" | "observe"): string {
  return `run_vmid_bound_guest_exec /usr/bin/python3 -I -B -c ${shellQuote(DESKTOP_PREPARE_GUEST_PROGRAM)} ${shellQuote(JSON.stringify(identity))} ${mode}`;
}

export function parseDesktopPrepareReceipt(stdout: string, identity: Identity): DesktopPrepareReceipt | null {
  const lines = stdout.split("\n").filter(line => line.startsWith(DESKTOP_PREPARE_MARKER));
  if (lines.length !== 1 || lines[0].length > 4096) return null;
  try {
    const value = JSON.parse(lines[0].slice(DESKTOP_PREPARE_MARKER.length));
    const keys = [...Object.keys(identity), "version", "bootId", "exitCode"].sort();
    if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
      || Object.entries(identity).some(([key, expected]) => value[key] !== expected)
      || value.version !== 1 || !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255
      || typeof value.bootId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.bootId)) return null;
    return value;
  } catch { return null; }
}
