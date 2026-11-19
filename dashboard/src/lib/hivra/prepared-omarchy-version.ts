import { z } from "zod";
import { shellQuote } from "./proxmox-target";

export const PREPARED_OMARCHY_VERSION_MARKER = "HIVRA_PREPARED_OMARCHY_VERSION ";

const Receipt = z.object({
  packageVersion: z.string().regex(/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}-[0-9]{1,4}(?:\.[0-9]{1,4})?$/),
  osVersion: z.string().regex(/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/),
  kernelRelease: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}$/),
  observedAt: z.string().datetime(),
}).strict().refine(value => value.packageVersion.split("-")[0] === value.osVersion);
export type PreparedOmarchyVersionReceipt = z.infer<typeof Receipt>;

export function readPreparedOmarchyVersion(stdout: string): PreparedOmarchyVersionReceipt {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(PREPARED_OMARCHY_VERSION_MARKER));
  if (lines.length !== 1) throw new Error("prepared_omarchy_version_unavailable");
  try {
    return Receipt.parse(JSON.parse(lines[0].slice(PREPARED_OMARCHY_VERSION_MARKER.length)));
  } catch {
    throw new Error("prepared_omarchy_version_unavailable");
  }
}

// /usr/share/omarchy/version can remain 4.0.0.alpha on released packages. Read
// pacman's installed package and /etc/os-release; neither a static file nor an
// installer selection proves the OS version currently running for this claim.
export const PREPARED_OMARCHY_GUEST_OBSERVATION = `import json,pathlib,re,shlex,subprocess
package=subprocess.check_output(['/usr/bin/pacman','-Q','omarchy'],text=True).strip()
match=re.fullmatch(r'omarchy ([0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}-[0-9]{1,4}(?:\\.[0-9]{1,4})?)',package)
assert match,'installed Omarchy package version unavailable'
os_version=None
for line in pathlib.Path('/etc/os-release').read_text().splitlines():
 if line.startswith('VERSION_ID='):
  parts=shlex.split(line.split('=',1)[1]); assert len(parts)==1
  os_version=parts[0]
assert os_version==match[1].split('-')[0],'Omarchy package and OS release disagree'
kernel=subprocess.check_output(['uname','-r'],text=True).strip()
assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,95}',kernel)
print(json.dumps({'packageVersion':match[1],'osVersion':os_version,'kernelRelease':kernel}))`;

/** Append only after the caller has verified the exact prepared VM identity. */
export function preparedOmarchyObservationScript(vmid: number, claim: string): string {
  if (!Number.isSafeInteger(vmid) || vmid < 100 || !/^[0-9a-f-]{36}$/i.test(claim)) throw new Error("prepared_binding_unavailable");
  const hostObservation = `import datetime,json,os,pathlib,sys,tempfile
result=json.load(sys.stdin)
assert result.get('exited') is True and result.get('exitcode')==0,'guest observation failed'
receipt=json.loads(result['out-data'])
assert set(receipt)=={'packageVersion','osVersion','kernelRelease'},'guest receipt shape invalid'
receipt['observedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')
directory=pathlib.Path('/var/lib/hivra/omarchy-receipts');directory.mkdir(parents=True,exist_ok=True,mode=0o700)
fd,name=tempfile.mkstemp(prefix='.observed-',dir=directory)
try:
 with os.fdopen(fd,'w') as out:json.dump(receipt,out);out.write('\\n')
 os.replace(name,directory/${JSON.stringify(`${vmid}-${claim}.observed.json`)})
finally:
 if os.path.exists(name):os.unlink(name)
print(${JSON.stringify(PREPARED_OMARCHY_VERSION_MARKER)}+json.dumps(receipt))`;
  return `qm guest exec ${vmid} --timeout 6 --synchronous 1 -- python3 -c ${shellQuote(PREPARED_OMARCHY_GUEST_OBSERVATION)} | python3 -c ${shellQuote(hostObservation)}`;
}
