import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  buildRemoteDesktopCapabilityInspectionScript, inspectRemoteDesktopCapability, parseRemoteDesktopCapabilityReceipt,
  REMOTE_DESKTOP_COMPATIBILITY, REMOTE_DESKTOP_BUNDLE_REVISION,
} from "../capability-inspection";

const ID = "11111111-1111-4111-8111-111111111111";
const GENERATION = "22222222-2222-4222-8222-222222222222";
const BOOT_ID = "33333333-3333-4333-8333-333333333333";
// The guest derives its capability generation as UUIDv5(installed generation,
// "hivra-remote-desktop-boot-v1:" + boot id); mirror that instead of pinning
// a derived identifier in the public tree.
function uuidV5(namespace: string, name: string): string {
  const hash = createHash("sha1").update(Buffer.from(namespace.replace(/-/g, ""), "hex")).update(name, "utf8").digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const BOOT_GENERATION = uuidV5(GENERATION, `hivra-remote-desktop-boot-v1:${BOOT_ID}`);
const ORIGIN = "https://desktop.example.test";
const revisions = Object.keys(REMOTE_DESKTOP_COMPATIBILITY) as Array<keyof typeof REMOTE_DESKTOP_COMPATIBILITY>;
const script = buildRemoteDesktopCapabilityInspectionScript({ vmid: 1123, guestIp: "10.241.0.23", infrastructureBindingTag: "hivra-bind-" + "a".repeat(32) });
const encoded = script.trim().split("\n").at(-1)!.match(/hivra '([A-Za-z0-9+/=]+)'$/)![1];
const program = Buffer.from(encoded, "base64").toString("utf8");
const helper = program.slice(program.indexOf("SPECIAL_MODE_VALIDATOR="), program.indexOf("\nroot=pathlib.Path"));

// Digests independently derived from the pure recipe functions in the sealed
// .05.1/.05.2/.05.3 commits. Tests need neither Git history nor archived code.
const sealedRecipeDigests = {
  "identity-v1": ["45b32712e40e21b62b7995a2df121d78881dc77b4d0722bf0aac50850259208f", "7319b6560bdcc64edb6447ea8a55d78f4e4a83ddcfe7afb110e40e2b5277f784", "660e82c66be92b995e6d2e2a8aa9eef1283a24c919133fcfba918e3257743d72", "744789b3778c558df9d3796d07eeda8261c0d7b459d97a941985b9f2fe136a8b", "cf78da0b5fc972c5915b22f2aac0bdd1ea45361e3d99aa1f7abee82fe08c9c18"],
  "special-modes-v2": ["45b32712e40e21b62b7995a2df121d78881dc77b4d0722bf0aac50850259208f", "dc5e139ea03a5fd4ca26f7b00b426efcc5db0a5a6f69c52fd5044997b43264b1", "4972bc778b7ac80507511e1f57f7b322d30631df65c39336dc3be83289ca229d", "0c814320f2c90056ba5e47eb60aadb87182c8c984c783fb92f409a51e79e111b", "95e7a6bd4e0c843dfd41875fb0f9cbc094c9e906b70034a756a688e0b63b3f79"],
  "symlinks-v3": ["45b32712e40e21b62b7995a2df121d78881dc77b4d0722bf0aac50850259208f", "fb3ff9f7074c8f021f2470f13fff72f6fc6063be12494d0e66646f413d577b39", "bfa37b228a8fd0aec663d85c59356ee1ad91b6a70139ae5dda738d7706feaace", "b4afffed7d9a01e3438f682cfb178086e7c21445a28bbb0048fea8294e2feef0", "99a56426b2745c5c6928c724c1765b2a9f7b26c6c784a8ae79499737f416593c"],
};

function python(source: string) {
  return spawnSync("python3", ["-I", "-B", "-c", source], { encoding: "utf8", timeout: 5_000 });
}

function guestFixture(revision: string, fault = "") {
  // Execute the complete production probe. Only host filesystem and exact
  // subprocess observations are fixtures; no Docker/service/network call runs.
  return python(`
import hashlib,json,os,pathlib,shlex,stat,subprocess,types
${helper}
def fail(code): raise RuntimeError(code)
revision=${JSON.stringify(revision)}; fault=${JSON.stringify(fault)}; uid=1001; gid=1001
base='ghcr.io/selkies-project/selkies-egl-desktop@sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa'
base_id='sha256:'+'a'*64; runtime_id='sha256:'+'b'*64
variant=COMPATIBLE_RELEASES.get(revision,{'recipe':'special-modes-v2'})['recipe']
recipe=hashlib.sha256(identity_recipe(uid,gid,variant).encode()).hexdigest()
if fault=='recipe': recipe='f'*64
cap={'protocol':'hivra-remote-desktop-installed-v1','computerKind':'hivra-agent','computerId':'${ID}',
 'capabilityGeneration':'${GENERATION}','observedRevision':revision,'compositor':'x11',
 'installedTransports':['selkies-websocket'],'privateNetworkReachable':False,'supportsInputTakeover':True,
 'brokerOrigin':'${ORIGIN}','baseImage':base,'baseImageIndexDigest':base.split('@')[1],
 'baseImageId':base_id,'runtimeImageId':runtime_id,'identityRecipeSha256':recipe,
 'desktopUser':'ubuntu','desktopUid':uid,'desktopGid':gid,'inputIsolation':'selkies-container-no-agent-input-v1'}
if fault=='uid': cap['desktopUid']=1000
if fault=='missing-metadata': del cap['identityRecipeSha256']
config={'User':'1000','Entrypoint':['/etc/container-entrypoint.sh'],'Cmd':None,'WorkingDir':'/home/ubuntu','Volumes':None,'Labels':{}}
base_image={'Os':'linux','Architecture':'amd64','Id':base_id,'Config':config,'RepoDigests':[base],'RootFS':{'Type':'layers','Layers':['sha256:'+'c'*64]}}
labels={'io.hivra.remote-desktop.base-index-digest':cap['baseImageIndexDigest'],'io.hivra.remote-desktop.base-image-id':base_id,
 'io.hivra.remote-desktop.identity-recipe-sha256':recipe,'io.hivra.remote-desktop.desktop-user':'ubuntu',
 'io.hivra.remote-desktop.desktop-uid':str(uid),'io.hivra.remote-desktop.desktop-gid':str(gid)}
runtime_image={**base_image,'Id':runtime_id,'Config':{**config,'User':'ubuntu','Labels':labels},'RootFS':{'Type':'layers','Layers':base_image['RootFS']['Layers']+['sha256:'+'d'*64]}}
container={'Image':runtime_id,'Config':{'Image':runtime_id,'User':'ubuntu'},'State':{'Running':True},
 'HostConfig':{'Privileged':False,'NetworkMode':'hivra-remote-desktop'},
 'NetworkSettings':{'Ports':{'8080/tcp':[{'HostIp':'127.0.0.1','HostPort':'8088'}]}},
 'Mounts':[{'Type':'bind','Source':'/home/bux/Hivra','Destination':'/home/ubuntu/Hivra','RW':True}]}
if fault=='image': container['Image']=base_id
if fault=='mount': container['Mounts'][0]['Source']='/home/bux'
if fault=='transport': container['NetworkSettings']['Ports']['8080/tcp'][0]['HostIp']='0.0.0.0'
def lstat(path):
 path=str(path)
 if path in ('/opt','/opt/hivra','/opt/hivra/remote-desktop'): return types.SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_uid=0,st_gid=0)
 if path=='/home/bux/Hivra': return types.SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_uid=uid,st_gid=gid)
 if path=='/opt/hivra/remote-desktop/capability.json': return types.SimpleNamespace(st_mode=stat.S_IFREG|0o600,st_uid=0,st_gid=0)
 if path=='/opt/hivra/remote-desktop/input-isolation': return types.SimpleNamespace(st_mode=stat.S_IFREG|0o640,st_uid=0,st_gid=0)
 raise AssertionError('unexpected path')
def read_text(path,**kwargs):
 if str(path)=='/proc/sys/kernel/random/boot_id': return '${BOOT_ID}\\n'
 if str(path)=='/opt/hivra/remote-desktop/capability.json': return json.dumps(cap)
 if str(path)=='/opt/hivra/remote-desktop/input-isolation': return 'selkies-container-no-agent-input-v1\\n'
 raise AssertionError('unexpected read')
def run(command,**kwargs):
 output=''; code=0
 if command[:2]==['/usr/bin/id','-u']: output=str(uid)
 elif command[:2]==['/usr/bin/id','-g']: output=str(gid)
 elif command[:2]==['/usr/bin/id','-nG']: output='ordinary-user'
 elif command[:3]==['/usr/bin/systemctl','is-active','--quiet']: code=1 if fault=='service' else 0
 elif command[:3]==['/usr/bin/docker','inspect','hivra-selkies-desktop']: output=json.dumps([container])
 elif command[:3]==['/usr/bin/docker','image','inspect']: output=json.dumps([base_image if command[3]==base else runtime_image])
 elif command[:3]==['/usr/bin/docker','exec','hivra-selkies-desktop']:
  sub=command[3:]
  if sub[:2]==['/usr/bin/id','-u']: output=str(uid)
  elif sub[:2]==['/usr/bin/id','-g']: output=str(gid)
  elif sub==['/usr/bin/id','-un']: output='ubuntu'
  elif sub[0]=='/usr/bin/stat': output=f'{uid}:{gid}:directory:700'
  else: raise AssertionError('unexpected container command')
 elif command[0]=='/usr/bin/curl': output='401' if command[-1]=='http://127.0.0.1:8088/' else '200'
 else: raise AssertionError('unexpected subprocess')
 return types.SimpleNamespace(returncode=code,stdout=output,stderr='')
os.lstat=lstat
pathlib.Path.exists=lambda path: str(path) in ('/opt/hivra/remote-desktop/capability.json','/opt/hivra/remote-desktop/input-isolation')
pathlib.Path.read_text=read_text
subprocess.run=run
exec(${JSON.stringify(program)})
`);
}

function dependencies(observed: ReturnType<typeof guestFixture>, leased = false) {
  return {
    loadAgent: jest.fn().mockResolvedValue({ id: ID, user_id: "owner", type: "linux-desktop", computer_profile: "ubuntu-desktop",
      status: "running", desired_state: "running", operation_id: leased ? GENERATION : null, operation_kind: leased ? "desktop_prepare" : null,
      vmid: 1123, ip: "10.241.0.23", chat_url: ORIGIN, infrastructure_binding_token_enforced: true }),
    resolveContext: jest.fn().mockResolvedValue({ kind: "managed", host: "fixture", env: {}, infrastructureBindingTag: "hivra-bind-"+"a".repeat(32), infrastructureBindingTagEnforced: true }),
    runHostScript: jest.fn().mockResolvedValue({ ok: observed.status===0, stdout: observed.stdout, stderr: observed.stderr }),
    recordCapability: jest.fn().mockResolvedValue({ ok: true }),
  };
}

describe("known desktop release compatibility", () => {
  it("matches every admitted recipe variant to independent sealed digests", () => {
    const result=python(`import hashlib,shlex\n${helper}\ndef fail(code): raise RuntimeError(code)\nexpected=${JSON.stringify(sealedRecipeDigests)}
for variant,digests in expected.items():
 for pair,digest in zip(((1000,1000),(1001,1001),(1001,1000),(1000,1001),(2000,3000)),digests):
  assert hashlib.sha256(identity_recipe(*pair,variant).encode()).hexdigest()==digest,(variant,pair)
`);
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it.each(revisions)("fully probes and renews known revision %s without relabeling its generation", async revision => {
    const observed=guestFixture(revision);
    expect({ status: observed.status, stderr: observed.stderr }).toEqual({ status: 0, stderr: "" });
    // The normal new-launch caller uses the default parser and must remain
    // current-only even though read-only inspection admits known predecessors.
    const currentOnly=parseRemoteDesktopCapabilityReceipt(observed.stdout);
    if (revision===REMOTE_DESKTOP_BUNDLE_REVISION) expect(currentOnly).toMatchObject({ observedRevision: revision });
    else expect(currentOnly).toBeNull();
    expect(parseRemoteDesktopCapabilityReceipt(observed.stdout,{ allowKnownPredecessor: true }))
      .toMatchObject({ observedRevision: revision, capabilityGeneration: BOOT_GENERATION });
    const deps=dependencies(observed);
    const result=await inspectRemoteDesktopCapability(ID,deps as never);
    expect(result).toMatchObject({ ok: true, runtimeVersion: REMOTE_DESKTOP_COMPATIBILITY[revision].version,
      upgradeAvailable: revision!==REMOTE_DESKTOP_BUNDLE_REVISION });
    expect(deps.recordCapability).toHaveBeenCalledWith(expect.objectContaining({
      userId: "owner", receipt: expect.objectContaining({ observedRevision: revision, capabilityGeneration: BOOT_GENERATION }),
    }));
  });

  it.each(["recipe","uid","image","mount","service","transport"])("rejects a known revision with changed %s proof", async fault => {
    const observed=guestFixture(revisions[1],fault);
    expect(observed.status).toBe(1);
    const deps=dependencies(observed);
    expect((await inspectRemoteDesktopCapability(ID,deps as never)).ok).toBe(false);
    expect(deps.recordCapability).not.toHaveBeenCalled();
  });

  it("keeps unknown revisions closed and old/missing identity explicitly upgrade-required", async () => {
    const unknownReceipt=guestFixture(REMOTE_DESKTOP_BUNDLE_REVISION).stdout.replace(REMOTE_DESKTOP_BUNDLE_REVISION,"f".repeat(64));
    expect(parseRemoteDesktopCapabilityReceipt(unknownReceipt)).toBeNull();
    expect(parseRemoteDesktopCapabilityReceipt(unknownReceipt,{ allowKnownPredecessor: true })).toBeNull();
    const unknown=dependencies(guestFixture("f".repeat(64)));
    expect(await inspectRemoteDesktopCapability(ID,unknown as never)).toMatchObject({ ok: false });
    expect(unknown.recordCapability).not.toHaveBeenCalled();
    for (const [revision,fault] of [["5a24955abe099ddbabaa66e01da0dc9cb395254d7b9ebcbb268539abcf2db38d",""],[revisions[1],"missing-metadata"]]) {
      const deps=dependencies(guestFixture(revision,fault));
      expect(await inspectRemoteDesktopCapability(ID,deps as never)).toMatchObject({ ok: false, code: "desktop_upgrade_required",
        error: expect.stringContaining("update to establish its shared-folder identity") });
      expect(deps.recordCapability).not.toHaveBeenCalled();
    }
  });

  it("does not use compatible predecessors to prove completion of a current installer", async () => {
    const deps=dependencies(guestFixture(revisions[1]),true);
    expect((await inspectRemoteDesktopCapability(ID,deps as never,{ preparationOperationId: GENERATION })).ok).toBe(false);
    expect(deps.recordCapability).not.toHaveBeenCalled();
  });
});
