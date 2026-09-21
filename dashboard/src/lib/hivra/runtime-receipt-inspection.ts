import "server-only";

import { Buffer } from "node:buffer";

import { supabaseAdmin } from "@/lib/supabase";
import {
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildVmidBoundGuestSshPrelude } from "@/lib/hivra/vmid-bound-guest-ssh";
import {
  runProxmoxHostScript,
  type HostScriptResult,
} from "@/lib/services/proxmox-instance-service";

const RECEIPT_MARKER = "HIVRA_RUNTIME_RECEIPT_SUMMARY_V1 ";
const INSPECTION_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^20[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[1-9][0-9]*$/;

type RuntimeReceiptAgentRow = {
  id: string;
  user_id: string;
  status: string | null;
  desired_state: string | null;
  operation_id: string | null;
  operation_kind: string | null;
  vmid: number | null;
  ip: string | null;
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

export type RuntimeReceiptSummary = {
  schemaVersion: 1 | 2;
  provisionerVersion: string;
  releaseApproved: false;
  receiptSha256: string;
  agentKind: string;
  browserEnabled: boolean;
  substrate: string;
  architecture: string | null;
  operatingSystemId: string;
  operatingSystemVersionId: string;
  systemPackageCount: number;
  npmGlobalPackageCount: number;
  artifactCount: number;
  binaryCount: number;
  serviceCount: number;
  activeServiceCount: number;
  gitCheckoutCount: number;
  containerImageCount: number;
  gapCount: number;
  sbomSha256: string;
  sbomComponentCount: number;
  noticeManifestSha256: string;
  systemNoticeCount: number;
  npmNoticeCount: number;
  systemPackagesMissingCopyrightCount: number;
  npmPackagesWithoutDeclaredLicenseCount: number;
  npmPackagesWithoutLicenseFilesCount: number;
};

export type RuntimeReceiptInspectionResult = {
  ok: boolean;
  agentId: string;
  targetId: string | null;
  vmid: number | null;
  summary?: RuntimeReceiptSummary;
  error?: string;
};

type InspectionDependencies = {
  loadAgent: (agentId: string) => Promise<RuntimeReceiptAgentRow | null>;
  resolveContext: (
    userId: string,
    agent: RuntimeReceiptAgentRow,
  ) => Promise<HivraAgentExecutionContext>;
  runHostScript: typeof runProxmoxHostScript;
};

async function loadAgent(agentId: string): Promise<RuntimeReceiptAgentRow | null> {
  if (!supabaseAdmin) throw new Error("Runtime receipt database client is unavailable.");
  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select([
      "id", "user_id", "status", "desired_state", "operation_id", "operation_kind",
      "vmid", "ip", "computer_substrate", "provider_capacity_order_id",
      "provider_enrollment_attempt_id", "provider_server_id", "deployment_mode",
      "proxmox_host", "infrastructure_connection_id", "deployment_target_id",
      "infrastructure_connection_revision", "infrastructure_binding_token_hash",
      "infrastructure_binding_token_enforced", "managed_provisioner_channel",
    ].join(","))
    .eq("id", agentId)
    .maybeSingle();
  if (error) throw new Error("Runtime receipt agent lookup failed.");
  return (data as RuntimeReceiptAgentRow | null) ?? null;
}

const DEFAULT_DEPENDENCIES: InspectionDependencies = {
  loadAgent,
  resolveContext: resolveHivraAgentExecutionContext,
  runHostScript: runProxmoxHostScript,
};

function validIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every(part => {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}

const GUEST_INSPECTION_PROGRAM = String.raw`import hashlib,json,os,pathlib,re,stat
root=pathlib.Path('/var/lib/hivra')
def bound(name,checksum,max_bytes=32*1024*1024):
    p=root/name; c=root/checksum
    for candidate in (p,c):
        info=os.lstat(candidate)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o600: raise SystemExit('unsafe evidence file')
    raw=p.read_bytes()
    if len(raw)>max_bytes: raise SystemExit('evidence file too large')
    digest=hashlib.sha256(raw).hexdigest()
    if c.read_text(encoding='ascii') != digest+'  '+name+'\n': raise SystemExit('checksum mismatch')
    return json.loads(raw),digest
d,digest=bound('runtime-receipt.json','runtime-receipt.sha256')
sbom,sbom_digest=bound('runtime-sbom.cdx.json','runtime-sbom.sha256',64*1024*1024)
notice,notice_digest=bound('runtime-notice-manifest.json','runtime-notice-manifest.sha256',64*1024*1024)
schema=d.get('schemaVersion') if isinstance(d,dict) else None
expected={'agent','artifacts','binaries','containerImages','gaps','gitCheckouts','host','npmGlobalPackages','provisionerVersion','releaseApproved','schemaVersion','services','systemPackages'}
if schema==2: expected.add('inventoryCompleteness')
if not isinstance(d,dict) or set(d)!=expected: raise SystemExit('receipt shape mismatch')
for value in (d['artifacts'],d['binaries'],d['containerImages'],d['gaps'],d['gitCheckouts'],d['npmGlobalPackages'],d['services'],d['systemPackages']):
    if not isinstance(value,list): raise SystemExit('receipt inventory mismatch')
if schema not in (1,2) or d['releaseApproved'] is not False: raise SystemExit('receipt decision mismatch')
if schema==2:
    completeness=d['inventoryCompleteness']
    if completeness!={'npmGlobalPackages':'recursive-node-modules-v1','systemPackages':'dpkg-installed-v1'}: raise SystemExit('receipt inventory completeness mismatch')
    install_paths=[]
    for package in d['npmGlobalPackages']:
        if not isinstance(package,dict) or set(package)!={'declaredLicense','installPath','licenseFiles','name','packageJsonSha256','scope','version'}: raise SystemExit('npm package shape mismatch')
        install_path=package.get('installPath')
        if not isinstance(install_path,str) or not (install_path.startswith('/usr/lib/node_modules/') or install_path.startswith('/home/bux/.npm-global/lib/node_modules/')) or '/..' in install_path or '//' in install_path: raise SystemExit('npm install path mismatch')
        install_paths.append(install_path)
    if len(set(install_paths))!=len(install_paths): raise SystemExit('duplicate npm install path')
if not isinstance(d['provisionerVersion'],str) or not re.fullmatch(r'20[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[1-9][0-9]*',d['provisionerVersion']): raise SystemExit('receipt version mismatch')
agent=d['agent']; host=d['host']; osr=host.get('operatingSystem') if isinstance(host,dict) else None
if not isinstance(agent,dict) or not isinstance(host,dict) or not isinstance(osr,dict): raise SystemExit('receipt identity mismatch')
if not isinstance(osr.get('ID'),str) or not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,63}',osr['ID']): raise SystemExit('receipt operating system mismatch')
if not isinstance(osr.get('VERSION_ID'),str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,63}',osr['VERSION_ID']): raise SystemExit('receipt operating system version mismatch')
if not isinstance(sbom,dict) or set(sbom)!={'bomFormat','components','metadata','specVersion','version'} or sbom.get('bomFormat')!='CycloneDX' or sbom.get('specVersion')!='1.6' or sbom.get('version')!=1 or not isinstance(sbom.get('components'),list): raise SystemExit('SBOM shape mismatch')
expected_components=sum(len(d[key]) for key in ('systemPackages','npmGlobalPackages','gitCheckouts','containerImages','artifacts','binaries'))
if len(sbom['components'])!=expected_components or expected_components<1: raise SystemExit('SBOM component count mismatch')
refs=[component.get('bom-ref') for component in sbom['components'] if isinstance(component,dict)]
if len(refs)!=expected_components or any(not isinstance(ref,str) or not ref for ref in refs) or len(set(refs))!=len(refs): raise SystemExit('SBOM component identity mismatch')
meta_component=sbom.get('metadata',{}).get('component') if isinstance(sbom.get('metadata'),dict) else None
properties=meta_component.get('properties') if isinstance(meta_component,dict) else None
if not isinstance(properties,list): raise SystemExit('SBOM metadata mismatch')
property_map={item.get('name'):item.get('value') for item in properties if isinstance(item,dict)}
if property_map.get('hivra:source-receipt-sha256')!=digest or property_map.get('hivra:release-approved')!='false': raise SystemExit('SBOM receipt binding mismatch')
notice_expected={'artifacts','containerImages','format','gaps','gitCheckouts','npmGlobalPackages','releaseApproved','schemaVersion','sourceReceiptSha256','summary','systemPackages'}
if not isinstance(notice,dict) or set(notice)!=notice_expected or notice.get('format')!='hivra-installed-runtime-notice-manifest-v1' or notice.get('schemaVersion')!=1 or notice.get('releaseApproved') is not False or notice.get('sourceReceiptSha256')!=digest: raise SystemExit('notice manifest shape mismatch')
for key in ('artifacts','containerImages','gaps','gitCheckouts','npmGlobalPackages','systemPackages'):
    if notice.get(key)!=d.get(key): raise SystemExit('notice manifest inventory mismatch')
notice_summary=notice.get('summary')
notice_summary_keys={'npmPackageCount','npmPackagesWithoutDeclaredLicenseCount','npmPackagesWithoutLicenseFilesCount','systemPackageCount','systemPackagesMissingCopyrightCount'}
if not isinstance(notice_summary,dict) or set(notice_summary)!=notice_summary_keys: raise SystemExit('notice summary mismatch')
calculated={'npmPackageCount':len(d['npmGlobalPackages']),'npmPackagesWithoutDeclaredLicenseCount':sum(1 for x in d['npmGlobalPackages'] if not isinstance(x,dict) or x.get('declaredLicense') is None),'npmPackagesWithoutLicenseFilesCount':sum(1 for x in d['npmGlobalPackages'] if not isinstance(x,dict) or not x.get('licenseFiles')),'systemPackageCount':len(d['systemPackages']),'systemPackagesMissingCopyrightCount':sum(1 for x in d['systemPackages'] if not isinstance(x,dict) or x.get('copyrightSha256') is None)}
if notice_summary!=calculated: raise SystemExit('notice count mismatch')
stack=[d,sbom,notice]
while stack:
    node=stack.pop()
    if isinstance(node,dict):
        for key,value in node.items():
            if re.sub(r'[^a-z]','',str(key).lower()) in {'apikey','token','secret','credential','credentials','commandline','processenv','processenvironment','browserprofile'}: raise SystemExit('forbidden evidence key')
            stack.append(value)
    elif isinstance(node,list): stack.extend(node)
summary={'schemaVersion':schema,'provisionerVersion':d['provisionerVersion'],'releaseApproved':False,'receiptSha256':digest,'agentKind':agent.get('kind'),'browserEnabled':agent.get('browserEnabled'),'substrate':host.get('substrate'),'architecture':host.get('architecture'),'operatingSystemId':osr['ID'],'operatingSystemVersionId':osr['VERSION_ID'],'systemPackageCount':len(d['systemPackages']),'npmGlobalPackageCount':len(d['npmGlobalPackages']),'artifactCount':len(d['artifacts']),'binaryCount':len(d['binaries']),'serviceCount':len(d['services']),'activeServiceCount':sum(1 for x in d['services'] if isinstance(x,dict) and x.get('active')=='active'),'gitCheckoutCount':len(d['gitCheckouts']),'containerImageCount':len(d['containerImages']),'gapCount':len(d['gaps']),'sbomSha256':sbom_digest,'sbomComponentCount':len(sbom['components']),'noticeManifestSha256':notice_digest,'systemNoticeCount':notice_summary['systemPackageCount'],'npmNoticeCount':notice_summary['npmPackageCount'],'systemPackagesMissingCopyrightCount':notice_summary['systemPackagesMissingCopyrightCount'],'npmPackagesWithoutDeclaredLicenseCount':notice_summary['npmPackagesWithoutDeclaredLicenseCount'],'npmPackagesWithoutLicenseFilesCount':notice_summary['npmPackagesWithoutLicenseFilesCount']}
print('HIVRA_RUNTIME_RECEIPT_SUMMARY_V1 '+json.dumps(summary,sort_keys=True,separators=(',',':')))`;

export function buildRuntimeReceiptInspectionScript(input: {
  vmid: number;
  guestIp: string;
  vmSshKeyPath: string;
  infrastructureBindingTag: string;
}): string {
  const program = Buffer.from(GUEST_INSPECTION_PROGRAM, "utf8").toString("base64");
  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
VMID=${input.vmid}
GUEST_IP=${shellQuote(input.guestIp)}
VM_KEY=${shellQuote(input.vmSshKeyPath)}
EXPECTED_BINDING_TAG=${shellQuote(input.infrastructureBindingTag)}
[[ "$VMID" =~ ^[0-9]+$ ]] && [ "$VMID" -ge 100 ]
[ -n "$EXPECTED_BINDING_TAG" ]
[ -f "$VM_KEY" ]
[ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = 'running' ]
VM_CONFIG="$(qm config "$VMID")"
TAGS="$(printf '%s\\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestSshPrelude()}
printf '%s' ${shellQuote(program)} | base64 -d | "\${GUEST_SSH[@]}" 'sudo -n /usr/bin/python3 -'
`;
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseRuntimeReceiptSummary(stdout: string): RuntimeReceiptSummary | null {
  const lines = stdout.split("\n").filter(line => line.startsWith(RECEIPT_MARKER));
  if (lines.length !== 1) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(lines[0].slice(RECEIPT_MARKER.length)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const expected = new Set([
    "schemaVersion", "provisionerVersion", "releaseApproved", "receiptSha256",
    "agentKind", "browserEnabled", "substrate", "architecture", "operatingSystemId", "operatingSystemVersionId",
    "systemPackageCount", "npmGlobalPackageCount", "artifactCount", "binaryCount",
    "serviceCount", "activeServiceCount", "gitCheckoutCount", "containerImageCount", "gapCount",
    "sbomSha256", "sbomComponentCount", "noticeManifestSha256", "systemNoticeCount",
    "npmNoticeCount", "systemPackagesMissingCopyrightCount",
    "npmPackagesWithoutDeclaredLicenseCount", "npmPackagesWithoutLicenseFilesCount",
  ]);
  if (Object.keys(value).some(key => !expected.delete(key)) || expected.size !== 0) return null;
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) || value.releaseApproved !== false ||
    typeof value.provisionerVersion !== "string" || !VERSION.test(value.provisionerVersion) ||
    typeof value.receiptSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.receiptSha256) ||
    typeof value.sbomSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sbomSha256) ||
    typeof value.noticeManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.noticeManifestSha256) ||
    typeof value.agentKind !== "string" || !value.agentKind ||
    typeof value.browserEnabled !== "boolean" ||
    typeof value.substrate !== "string" || !value.substrate ||
    !(value.architecture === null || typeof value.architecture === "string") ||
    typeof value.operatingSystemId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.operatingSystemId) ||
    typeof value.operatingSystemVersionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value.operatingSystemVersionId) ||
    !count(value.systemPackageCount) || value.systemPackageCount < 1 ||
    !count(value.npmGlobalPackageCount) || !count(value.artifactCount) ||
    !count(value.binaryCount) || !count(value.serviceCount) ||
    !count(value.activeServiceCount) || value.activeServiceCount > value.serviceCount ||
    !count(value.gitCheckoutCount) || !count(value.containerImageCount) || !count(value.gapCount) ||
    !count(value.sbomComponentCount) || value.sbomComponentCount !== (
      value.systemPackageCount + value.npmGlobalPackageCount + value.gitCheckoutCount +
      value.containerImageCount + value.artifactCount + value.binaryCount
    ) ||
    !count(value.systemNoticeCount) || value.systemNoticeCount !== value.systemPackageCount ||
    !count(value.npmNoticeCount) || value.npmNoticeCount !== value.npmGlobalPackageCount ||
    !count(value.systemPackagesMissingCopyrightCount) ||
    value.systemPackagesMissingCopyrightCount > value.systemNoticeCount ||
    !count(value.npmPackagesWithoutDeclaredLicenseCount) ||
    value.npmPackagesWithoutDeclaredLicenseCount > value.npmNoticeCount ||
    !count(value.npmPackagesWithoutLicenseFilesCount) ||
    value.npmPackagesWithoutLicenseFilesCount > value.npmNoticeCount
  ) return null;
  return value as RuntimeReceiptSummary;
}

export async function inspectHivraRuntimeReceipt(
  agentId: string,
  dependencies: Partial<InspectionDependencies> = {},
): Promise<RuntimeReceiptInspectionResult> {
  if (!UUID.test(agentId)) {
    return { ok: false, agentId, targetId: null, vmid: null, error: "Agent id is invalid." };
  }
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const agent = await deps.loadAgent(agentId);
  if (!agent) return { ok: false, agentId, targetId: null, vmid: null, error: "Agent not found." };
  const vmid = Number(agent.vmid);
  const ip = typeof agent.ip === "string" ? agent.ip.trim() : "";
  if (
    agent.status !== "running" || agent.desired_state !== "running" ||
    agent.operation_id != null || agent.operation_kind != null ||
    !Number.isSafeInteger(vmid) || vmid < 100 || !validIpv4(ip) ||
    agent.infrastructure_binding_token_enforced !== true
  ) {
    return { ok: false, agentId, targetId: null, vmid: Number.isSafeInteger(vmid) ? vmid : null, error: "Agent is not in a stable, identity-bound running state." };
  }
  const context = await deps.resolveContext(agent.user_id, agent);
  if (!context.paths.vmSshKeyPath || !context.infrastructureBindingTagEnforced) {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Agent runtime receipt authority is unavailable." };
  }
  let hostResult: HostScriptResult;
  try {
    hostResult = await deps.runHostScript(buildRuntimeReceiptInspectionScript({
      vmid,
      guestIp: ip,
      vmSshKeyPath: context.paths.vmSshKeyPath,
      infrastructureBindingTag: context.infrastructureBindingTag,
    }), context.env, { timeoutMs: INSPECTION_TIMEOUT_MS, maxOutputBytes: 16 * 1024 });
  } catch {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Runtime receipt inspection failed." };
  }
  const summary = hostResult.ok ? parseRuntimeReceiptSummary(hostResult.stdout) : null;
  if (!summary) {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Runtime receipt could not be verified." };
  }
  return { ok: true, agentId, targetId: context.host, vmid, summary };
}
