import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const source=readFileSync(join(process.cwd(),"provisioner/provision-claude-code-box.sh"),"utf8");
const selection=source.slice(source.indexOf('AGENT_KIND="'),source.indexOf("# Browser stack:"));
const base=source.slice(source.indexOf("apt-get install -y curl"),source.indexOf('ok "base packages present"'));

function run(selectionEnv:Record<string,string>={},packages=false){
  return spawnSync("bash",["--noprofile","--norc","-s"],{encoding:"utf8",timeout:3_000,
    env:{PATH:"/usr/bin:/bin",NODE_ENV:"test",...selectionEnv},input:`set -euo pipefail
uname() { printf '%s\\n' "\${FIXTURE_ARCH:-x86_64}"; }
apt-get() { printf 'PACKAGE %s\\n' "$*"; }
systemctl() { printf 'SERVICE %s\\n' "$*"; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
${selection}
${packages?base:'printf "RUNTIME %s\\n" "$AGENT_KIND"'}
`});
}

it.each(["claude","codex","aeon","openclaw","agent-zero","linux-desktop"])("preserves %s rather than replacing a catalog runtime",kind=>{
  expect(run({HIVRA_AGENT_KIND:kind})).toMatchObject({status:0,stdout:`RUNTIME ${kind}\n`});
});
it("keeps the legacy default without accepting unknown runtime names",()=>{
  expect(run()).toMatchObject({status:0,stdout:"RUNTIME claude\n"});
  const bad=run({HIVRA_AGENT_KIND:"not-a-runtime"});expect(bad.status).not.toBe(0);expect(bad.stderr).toContain("unsupported HIVRA_AGENT_KIND");
});
it("requires the typed caller's native base-only path instead of exposing a half-configured DeepSeek shell launch",()=>{
  const rejected=run({HIVRA_AGENT_KIND:"deepseek-harness"},true);
  expect(rejected.status).not.toBe(0);expect(rejected.stdout).not.toContain("PACKAGE");
  expect(run({HIVRA_AGENT_KIND:"deepseek-harness",HIVRA_NATIVE_PREPARE_ONLY:"1",HIVRA_COMPUTER_SUBSTRATE:"provider-vm"}))
    .toMatchObject({status:0,stdout:"RUNTIME deepseek-harness\n"});
});
it.each(["arbitrary","docker","proxmox"])("rejects unsupported substrate %s before package work",substrate=>{
  const result=run({HIVRA_COMPUTER_SUBSTRATE:substrate},true);expect(result.status).not.toBe(0);expect(result.stdout).not.toContain("PACKAGE");
});
it.each(["aarch64","arm64","unknown"])("rejects %s before installing amd64 artifacts",architecture=>{
  const result=run({FIXTURE_ARCH:architecture},true);expect(result.status).not.toBe(0);expect(result.stdout).not.toContain("PACKAGE");
});
it("retains the default Proxmox guest-agent requirement",()=>{
  const result=run({},true);expect(result.status).toBe(0);expect(result.stdout).toContain("qemu-guest-agent");
  expect(result.stdout).toContain("SERVICE enable --now qemu-guest-agent");
});
it("does not require Proxmox guest hardware for an explicitly selected provider VM",()=>{
  const result=run({HIVRA_COMPUTER_SUBSTRATE:"provider-vm"},true);expect(result.status).toBe(0);
  expect(result.stdout).toContain("PACKAGE install -y curl ca-certificates git wget gnupg tmux");
  expect(result.stdout).not.toContain("qemu-guest-agent");expect(result.stdout).not.toContain("SERVICE");
});
