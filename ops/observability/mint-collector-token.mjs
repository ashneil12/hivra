#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";

const args=process.argv.slice(2); const take=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined};
const all=(name)=>args.flatMap((v,i)=>v===name&&args[i+1]?[args[i+1]]:[]);
const userId=take("--user-id"); const resourceIds=all("--resource-id"); const out=take("--out");
const ttl=Number(take("--ttl-seconds")??3600); const secret=process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET?.trim();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
if(!userId||userId.length>256||!resourceIds.length||resourceIds.length>100||resourceIds.some(id=>!uuid.test(id))||!out||!Number.isInteger(ttl)||ttl<60||ttl>2_592_000||!secret||secret.length<32){
  console.error("Usage: ACTIVITY_COLLECTOR_SIGNING_SECRET=<32+ chars> mint-collector-token.mjs --user-id <id> --resource-id <uuid> [--resource-id <uuid>] --ttl-seconds <60..2592000> --out <file>"); process.exit(2);
}
const now=Math.floor(Date.now()/1000); const claims={v:1,userId,resourceIds:[...new Set(resourceIds.map(v=>v.toLowerCase()))],iat:now,exp:now+ttl};
const encoded=Buffer.from(JSON.stringify(claims),"utf8").toString("base64url");
const prefix="hvra_otlp_v1"; const signature=crypto.createHmac("sha256",secret).update(`${prefix}.${encoded}`,"utf8").digest("base64url");
fs.writeFileSync(out,`${prefix}.${encoded}.${signature}\n`,{encoding:"utf8",mode:0o600,flag:"wx"});
console.error(`Wrote a ${ttl}-second collector token scoped to ${claims.resourceIds.length} resource(s) at ${out}.`);

