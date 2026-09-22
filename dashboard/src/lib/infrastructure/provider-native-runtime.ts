import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import currentRelease from "../../../provisioner-releases/2026.09.22.1.json";
import capacityRelease from "../../../provisioner-releases/2026.09.15.2.json";
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
import desktopWorkerRelease from "../../../provisioner-releases/2026.09.05.6.json";
import alignedDesktopRelease from "../../../provisioner-releases/2026.09.05.5.json";
import sessionBindingRelease from "../../../provisioner-releases/2026.09.05.4.json";
import symlinkIdentityRelease from "../../../provisioner-releases/2026.09.05.3.json";
import specialModesRelease from "../../../provisioner-releases/2026.09.05.2.json";
import desktopIdentityRelease from "../../../provisioner-releases/2026.09.05.1.json";
import desktopReconnectRelease from "../../../provisioner-releases/2026.09.04.4.json";
import controlProtectionRelease from "../../../provisioner-releases/2026.09.04.3.json";
import credentialRotationRelease from "../../../provisioner-releases/2026.09.04.2.json";
import desktopResizeRelease from "../../../provisioner-releases/2026.09.04.1.json";
import selkiesImageRelease from "../../../provisioner-releases/2026.09.03.2.json";
import currentDesktopRelease from "../../../provisioner-releases/2026.09.03.1.json";
import desktopBaseRelease from "../../../provisioner-releases/2026.09.02.8.json";
import linuxDesktopPredecessorRelease from "../../../provisioner-releases/2026.09.02.7.json";
import sourceHygieneRelease from "../../../provisioner-releases/2026.09.02.6.json";
import publicSourceRelease from "../../../provisioner-releases/2026.09.02.5.json";
import qgaBootstrapRelease from "../../../provisioner-releases/2026.09.02.4.json";
import qgaSshRelease from "../../../provisioner-releases/2026.09.02.3.json";
import lifecycleSshRelease from "../../../provisioner-releases/2026.09.02.2.json";
import proxmoxHandoffRelease from "../../../provisioner-releases/2026.09.02.1.json";
import lastRelease from "../../../provisioner-releases/2026.09.01.9.json";
import previousRelease from "../../../provisioner-releases/2026.09.01.8.json";
import olderRelease from "../../../provisioner-releases/2026.09.01.7.json";
import legacyRelease from "../../../provisioner-releases/2026.09.01.6.json";
import earliestRelease from "../../../provisioner-releases/2026.09.01.5.json";
import oldestRelease from "../../../provisioner-releases/2026.09.01.4.json";
import priorRelease from "../../../provisioner-releases/2026.09.01.3.json";
import firstRelease from "../../../provisioner-releases/2026.09.01.2.json";
import initialRelease from "../../../provisioner-releases/2026.09.01.1.json";
import historicalRelease from "../../../provisioner-releases/2026.08.31.4.json";
import { parseProviderNativeAccess, parseProviderNativeWorkerIdentity,
  type ProviderNativeAccess, type ProviderNativeWorkerIdentity } from "./provider-native-worker";

const closure = new Set(["deepseek-harness/bux-hivra-chat.service", "deepseek-harness/install-native.py", "deepseek-harness/service-owner.py"]);
const gatewayTargets = new Map<string, string>([
  ...["server.js", "llm-application.js", "guarded-files.cjs", "agent-zero-editor.cjs", "index.html", "app.js"].map(name => [`hivra-chat/${name}`, name] as const),
  ...["native-broker.cjs", "gateway-policy.cjs", "runtime-process.cjs"].map(name => [`deepseek-harness/${name}`, `deepseek-harness/${name}`] as const),
]);
function releaseRows(release: typeof currentRelease) {
  const rows = release.files.filter(file => closure.has(file.path)).map(file => [file.path, file.sha256, file.bytes,
    file.path.endsWith(".sh") ? 0o700 : 0o600] as const).sort((a, b) => a[0].localeCompare(b[0]));
  const gatewayRows = release.files.filter(file => gatewayTargets.has(file.path))
    .map(file => [gatewayTargets.get(file.path)!, file.sha256, file.bytes, 0o644] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return { rows, gatewayRows };
}
const Receipt = z.discriminatedUnion("ready", [
  z.object({ version: z.literal(1), ready: z.literal(true), identity: z.unknown(), access: z.unknown(),
    sessionCookie: z.string().regex(/^__Host-hivra_auth=[a-f0-9]{64}$/),
    invocationId: z.string().regex(/^[a-f0-9]{32}$/).refine(value => value !== "0".repeat(32)) }).strict(),
  z.object({ version: z.literal(1), ready: z.literal(false), identity: z.unknown(), access: z.unknown(),
    reason: z.enum(["installer_unverified", "service_unverified", "authentication_unverified", "native_unavailable"]) }).strict(),
]);
export type ProviderNativeRuntimeProbe = { identity: ProviderNativeWorkerIdentity; access: ProviderNativeAccess };
export type ProviderNativeRuntimeReceipt = z.infer<typeof Receipt>;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function checked(input: ProviderNativeRuntimeProbe) {
  const identity = parseProviderNativeWorkerIdentity(input.identity), access = parseProviderNativeAccess(input.access);
  const release = identity.bundle.provisionerVersion === "2026.09.22.1"
    ? currentRelease
    : identity.bundle.provisionerVersion === "2026.09.15.2"
      ? capacityRelease
    : identity.bundle.provisionerVersion === "2026.09.15.1"
      ? priorFifteenRelease
    : identity.bundle.provisionerVersion === "2026.09.08.3"
      ? handoffReductionRelease
    : identity.bundle.provisionerVersion === "2026.09.08.2"
      ? handoffLatencyRelease
    : identity.bundle.provisionerVersion === "2026.09.08.1"
      ? firstFrameRelease
    : identity.bundle.provisionerVersion === "2026.09.07.1"
      ? densityRelease
    : identity.bundle.provisionerVersion === "2026.09.06.4"
      ? scalingRelease
    : identity.bundle.provisionerVersion === "2026.09.06.3"
      ? transferRelease
    : identity.bundle.provisionerVersion === "2026.09.06.2"
      ? preparedRelease
    : identity.bundle.provisionerVersion === "2026.09.06.1"
      ? editorRelease
    : identity.bundle.provisionerVersion === "2026.09.05.10"
      ? ownershipRelease
    : identity.bundle.provisionerVersion === "2026.09.05.9"
      ? workspaceRelease
    : identity.bundle.provisionerVersion === "2026.09.05.8"
      ? coldStartRelease
    : identity.bundle.provisionerVersion === "2026.09.05.7"
      ? framingRelease
    : identity.bundle.provisionerVersion === "2026.09.05.6"
      ? desktopWorkerRelease
    : identity.bundle.provisionerVersion === "2026.09.05.5"
      ? alignedDesktopRelease
    : identity.bundle.provisionerVersion === "2026.09.05.4"
      ? sessionBindingRelease
    : identity.bundle.provisionerVersion === "2026.09.05.3"
      ? symlinkIdentityRelease
    : identity.bundle.provisionerVersion === "2026.09.05.2"
      ? specialModesRelease
    : identity.bundle.provisionerVersion === "2026.09.05.1"
      ? desktopIdentityRelease
    : identity.bundle.provisionerVersion === "2026.09.04.4"
      ? desktopReconnectRelease
    : identity.bundle.provisionerVersion === "2026.09.04.3"
      ? controlProtectionRelease
    : identity.bundle.provisionerVersion === "2026.09.04.2"
      ? credentialRotationRelease
    : identity.bundle.provisionerVersion === "2026.09.04.1"
      ? desktopResizeRelease
    : identity.bundle.provisionerVersion === "2026.09.03.2"
      ? selkiesImageRelease
    : identity.bundle.provisionerVersion === "2026.09.03.1"
      ? currentDesktopRelease
    : identity.bundle.provisionerVersion === "2026.09.02.8"
      ? desktopBaseRelease
    : identity.bundle.provisionerVersion === "2026.09.02.7"
      ? linuxDesktopPredecessorRelease
      : identity.bundle.provisionerVersion === "2026.09.02.6"
      ? sourceHygieneRelease
      : identity.bundle.provisionerVersion === "2026.09.02.5"
      ? publicSourceRelease
      : identity.bundle.provisionerVersion === "2026.09.02.4"
        ? qgaBootstrapRelease
        : identity.bundle.provisionerVersion === "2026.09.02.3"
          ? qgaSshRelease
        : identity.bundle.provisionerVersion === "2026.09.02.2"
          ? lifecycleSshRelease
          : identity.bundle.provisionerVersion === "2026.09.02.1"
            ? proxmoxHandoffRelease
            : identity.bundle.provisionerVersion === "2026.09.01.9"
              ? lastRelease
              : identity.bundle.provisionerVersion === "2026.09.01.8"
                ? previousRelease
                : identity.bundle.provisionerVersion === "2026.09.01.7"
                  ? olderRelease
                  : identity.bundle.provisionerVersion === "2026.09.01.6"
                    ? legacyRelease
                    : identity.bundle.provisionerVersion === "2026.09.01.5"
                      ? earliestRelease
                      : identity.bundle.provisionerVersion === "2026.09.01.4"
                        ? oldestRelease
                        : identity.bundle.provisionerVersion === "2026.09.01.3"
                          ? priorRelease
                          : identity.bundle.provisionerVersion === "2026.09.01.2"
                            ? firstRelease
                            : identity.bundle.provisionerVersion === "2026.09.01.1"
                              ? initialRelease
                              : identity.bundle.provisionerVersion === "2026.08.31.4" ? historicalRelease : null;
  if (!release) throw new Error("Unsafe native gateway release");
  const { rows, gatewayRows } = releaseRows(release);
  return { identity, access, origin: `https://${access.hostname}`, rows, gatewayRows,
    closureSha256: hash(JSON.stringify(rows) + "\n") };
}

/** Fixed read-only ownership/readiness recipe for an installed native service.
 * It validates and imports only the retained, identity-hashed controller
 * closure. The sole mutation is one normal in-memory gateway session, minted
 * locally from the box key and returned as an opaque cookie; no key leaves SSH.
 */
export function buildProviderNativeRuntimeProbe(input: ProviderNativeRuntimeProbe) {
  let expected: ReturnType<typeof checked>;
  try { expected = checked(input); if (expected.closureSha256 !== expected.identity.nativeCleanup.closureSha256) throw new Error(); }
  catch { throw new Error("Invalid provider native runtime probe"); }
  const encoded = Buffer.from(JSON.stringify(expected)).toString("base64");
  const script = `import base64, fcntl, hashlib, http.client, importlib.util, json, os, pwd, re, stat, sys
EXPECTED=json.loads(base64.b64decode("${encoded}",validate=True)); ROOT="/var/lib/hivra/provider-install"; NATIVE=ROOT+"/native-cleanup"; MAX=1048576
def unique(pairs):
 out={}
 for k,v in pairs:
  if k in out: raise ValueError()
  out[k]=v
 return out
def directory(path,uid):
 s=os.lstat(path)
 if not stat.S_ISDIR(s.st_mode) or s.st_uid!=uid or s.st_mode&0o022: raise ValueError()
def read(path,uid,mode,limit):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=uid or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=mode or s.st_size>limit: raise ValueError()
  raw=os.read(fd,limit+1)
  if len(raw)>limit: raise ValueError()
  return raw
 finally: os.close(fd)
def decode(raw): return json.loads(raw,object_pairs_hook=unique)
def request(method,path,headers=None,body=None,limit=8192):
 c=http.client.HTTPConnection("127.0.0.1",8080,timeout=1)
 try:
  c.request(method,path,body=body,headers=headers or {}); r=c.getresponse(); raw=r.read(limit+1)
  if len(raw)>limit: raise ValueError()
  values={}
  for k,v in r.getheaders():
   key=k.lower()
   if key in values: raise ValueError()
   values[key]=v
  return r.status,values,raw
 finally: c.close()
result={"version":1,"ready":False,"identity":EXPECTED["identity"],"access":EXPECTED["access"]}; reason="installer_unverified"
try:
 for path in ("/","/etc","/etc/hivra","/var","/var/lib","/var/lib/hivra",ROOT,NATIVE): directory(path,0)
 identity=decode(read(ROOT+"/identity.json",0,0o600,8192)); finished=decode(read(ROOT+"/result.json",0,0o600,8192))
 if identity!=EXPECTED["identity"] or finished!={"identity":identity,"exitCode":0}: raise ValueError()
 manifest=decode(read(ROOT+"/manifest.json",0,0o600,131072)); actual=[]
 if not isinstance(manifest,list): raise ValueError()
 for item in manifest:
  if not isinstance(item,dict) or set(item)!={"path","sha256","size","mode"}: raise ValueError()
  actual.append([item["path"],item["sha256"],item["size"],item["mode"]])
 if hashlib.sha256(json.dumps(actual,separators=(",",":")).encode()).hexdigest()!=identity["bundle"]["bundleSha256"]: raise ValueError()
 wanted=EXPECTED["rows"]
 if [row for row in actual if row[0] in [item[0] for item in wanted]]!=wanted or hashlib.sha256((json.dumps(wanted,separators=(",",":"))+"\\n").encode()).hexdigest()!=EXPECTED["closureSha256"]: raise ValueError()
 if sorted(os.listdir(NATIVE))!=sorted(os.path.basename(row[0]) for row in wanted): raise ValueError()
 for name,digest,size,mode in wanted:
  raw=read(NATIVE+"/"+os.path.basename(name),0,mode,size)
  if len(raw)!=size or hashlib.sha256(raw).hexdigest()!=digest: raise ValueError()
 gateway="/opt/hivra/deepseek-gateway"; directory("/opt",0); directory("/opt/hivra",0); directory(gateway,0); directory(gateway+"/deepseek-harness",0)
 top=sorted(name for name,_,_,_ in EXPECTED["gatewayRows"] if "/" not in name)+["deepseek-harness"]
 nested=sorted(name.split("/",1)[1] for name,_,_,_ in EXPECTED["gatewayRows"] if "/" in name)
 if sorted(os.listdir(gateway))!=sorted(top) or sorted(os.listdir(gateway+"/deepseek-harness"))!=nested: raise ValueError()
 for name,digest,size,mode in EXPECTED["gatewayRows"]:
  raw=read(gateway+"/"+name,0,mode,size)
  if len(raw)!=size or hashlib.sha256(raw).hexdigest()!=digest: raise ValueError()
 lock=os.open(ROOT+"/manager.lock",os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except: os.close(lock); raise
 reason="service_unverified"
 try:
  install_spec=importlib.util.spec_from_file_location("hivra_native_readiness_install",NATIVE+"/install-native.py"); installer=importlib.util.module_from_spec(install_spec); install_spec.loader.exec_module(installer)
  installer.verified_existing()
  spec=importlib.util.spec_from_file_location("hivra_native_readiness_owner",NATIVE+"/service-owner.py"); owner=importlib.util.module_from_spec(spec); spec.loader.exec_module(owner)
  before=owner.verify_running()
  user=pwd.getpwnam("bux"); directory("/home",0); directory("/home/bux",user.pw_uid); directory("/home/bux/.hivra",user.pw_uid)
  token=read("/home/bux/.hivra/api-token",user.pw_uid,0o600,65).decode("ascii").strip()
  kind=read("/home/bux/.hivra/agent-kind",user.pw_uid,0o600,64).decode("ascii").strip()
  config=decode(read("/etc/hivra/deepseek-native.json",0,0o644,1024))
  if not re.fullmatch(r"[a-f0-9]{64}",token) or kind!="deepseek-harness" or config!={"version":1,"publicOrigin":EXPECTED["origin"]}: raise ValueError()
  reason="authentication_unverified"
  host={"Host":EXPECTED["access"]["hostname"],"Origin":EXPECTED["origin"],"Content-Type":"application/x-www-form-urlencoded"}
  body=("token="+token+"&destination=%2F").encode("ascii"); status,headers,_=request("POST","/auth/bootstrap",host,body)
  if status!=303 or headers.get("location")!="/" or headers.get("cache-control")!="no-store" or headers.get("referrer-policy")!="no-referrer": raise ValueError()
  raw=headers.get("set-cookie",""); parts=[item.strip() for item in raw.split(";")]; pair=parts[0]
  expected_attrs=sorted(["path=/","httponly","secure","samesite=none","partitioned","max-age=43200"])
  if not re.fullmatch(r"__Host-hivra_auth=[a-f0-9]{64}",pair) or pair.endswith(token) or sorted(item.lower() for item in parts[1:])!=expected_attrs: raise ValueError()
  reason="native_unavailable"; session={"Host":EXPECTED["access"]["hostname"],"Origin":EXPECTED["origin"],"Cookie":pair}
  health=request("GET","/healthz",host)[0:3:2]; meta=request("GET","/api/meta",host)
  root=request("GET","/",session,limit=MAX); terminal=request("GET","/terminal/",session); box=request("GET","/box-terminal/",session); vnc=request("GET","/vnc/",session); management=request("GET","/api/browser/status",session)
  summary=decode(meta[2])
  if health!=(200,b"ok") or meta[0]!=200 or summary.get("agentKind")!="deepseek-harness" or summary.get("surfaceAuth")!="post-cookie-v1" or summary.get("nativeSurface")!="/" or summary.get("nativeReady") is not True: raise ValueError()
  if root[0]!=200 or b'<base href="/"' not in root[2] or any(value[0]!=200 for value in (terminal,box,vnc)) or management[0]!=401: raise ValueError()
  after=owner.verify_running()
  if before!=after: raise ValueError()
  result.update(ready=True,sessionCookie=pair,invocationId=before["invocationId"]); result.pop("reason",None)
 finally: os.close(lock)
except Exception: result["reason"]=reason
print("HIVRA_PROVIDER_NATIVE_RUNTIME_V1 "+json.dumps(result,separators=(",",":")),flush=True)
`;
  return { ...expected, script };
}

export function parseProviderNativeRuntimeReceipt(output: string, input: ProviderNativeRuntimeProbe): ProviderNativeRuntimeReceipt {
  try {
    const expected = checked(input), marker = "HIVRA_PROVIDER_NATIVE_RUNTIME_V1 ";
    if (Buffer.byteLength(output) > 16384 || !output.startsWith(marker) || !output.endsWith("\n")
      || output.indexOf("\n") !== output.length - 1 || output.includes("\r")) throw new Error();
    const value = Receipt.parse(JSON.parse(output.slice(marker.length)));
    if (JSON.stringify(parseProviderNativeWorkerIdentity(value.identity)) !== JSON.stringify(expected.identity)
      || JSON.stringify(parseProviderNativeAccess(value.access)) !== JSON.stringify(expected.access)) throw new Error();
    return value;
  } catch { throw new Error("Invalid provider native runtime receipt"); }
}
