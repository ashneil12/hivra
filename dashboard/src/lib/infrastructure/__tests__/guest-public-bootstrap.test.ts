/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const source=readFileSync(path.join(process.cwd(),"provisioner/provision-claude-code-box.sh"),"utf8");

it("keeps public bootstrap usable under a private worker umask without passing secrets or changing the parent",()=>{
  const directory=mkdtempSync(path.join(tmpdir(),"hivra-public-bootstrap-"));
  const checkout=path.join(directory,"checkout");mkdirSync(checkout);
  const start=source.indexOf('  ( ',source.indexOf('  say "running bux installer'));
  const invocation=source.slice(start,source.indexOf('  ok "bux installed"',start));
  const helperStart=source.indexOf("run_public_bootstrap() (");
  const helper=helperStart<0?"":source.slice(helperStart,source.indexOf("\n)\n",helperStart)+3);
  writeFileSync(path.join(checkout,"install.sh"),`#!/bin/bash
set -eu
: > public-key.gpg
temp="$(mktemp ./ttyd.XXXXXX)"
printf '#!/bin/sh\\nexit 0\\n' > "$temp"
chmod +x "$temp"
mv "$temp" ttyd
[ -z "\${HIVRA_MODEL_KEY+x}" ] && [ -z "\${TG_BOT_TOKEN+x}" ] && [ -z "\${UNRELATED_SECRET+x}" ]
[ "$BROWSER_USE_API_KEY" = local ] && [ "$WITH_ZTK" = 0 ] && [ "$BUX_REF" = fixture-pin ]
`,{mode:0o755});
  try {
    const result=spawnSync("/bin/bash",["--noprofile","--norc","-s"],{
      input:`set -euo pipefail\numask 077\n${helper}\n${invocation}\nprintf '%s\\n' "$(umask)"\n: > "$BUX_DIR/private-after"\n`,
      env:{PATH:"/usr/bin:/bin",NODE_ENV:"test",BUX_DIR:checkout,BUX_REF:"fixture-pin",DUMMY_BU_KEY:"local",
        HIVRA_MODEL_KEY:"fixture-only",TG_BOT_TOKEN:"fixture-only",UNRELATED_SECRET:"fixture-only"},
      encoding:"utf8",timeout:3000,
    });
    expect(statSync(path.join(checkout,"public-key.gpg")).mode&0o777).toBe(0o644);
    expect(statSync(path.join(checkout,"ttyd")).mode&0o111).toBe(0o111);
    expect(result).toMatchObject({status:0,stdout:"0077\n"});
    expect(statSync(path.join(checkout,"private-after")).mode&0o777).toBe(0o600);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

it("creates only a fresh public checkout with public modes while retaining the parent mask",()=>{
  const directory=mkdtempSync(path.join(tmpdir(),"hivra-public-checkout-"));
  const checkout=path.join(directory,"checkout");
  const start=source.indexOf('if [ ! -e "${BUX_DIR}" ]');
  const creation=source.slice(start,source.indexOf("  BUX_CHECKOUT_CREATED=1",start))+"\nfi\n";
  try {
    const result=spawnSync("/bin/bash",["--noprofile","--norc","-s"],{
      input:`set -euo pipefail\numask 077\ngit() { if [ "$3" = init ]; then mkdir "$BUX_DIR/.git"; elif [ "$3" = checkout ]; then : > "$BUX_DIR/install.sh"; chmod +x "$BUX_DIR/install.sh"; fi; }\n${creation}\nprintf '%s\\n' "$(umask)"\n`,
      env:{PATH:"/usr/bin:/bin",NODE_ENV:"test",BUX_DIR:checkout,BUX_REF:"fixture-pin"},encoding:"utf8",timeout:3000,
    });
    expect(result).toMatchObject({status:0,stdout:"0077\n"});
    expect(statSync(checkout).mode&0o777).toBe(0o755);
    expect(statSync(path.join(checkout,"install.sh")).mode&0o777).toBe(0o755);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
