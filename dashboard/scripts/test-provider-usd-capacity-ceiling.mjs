// Execute the original validators and additive replacement, without cloud access.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db = new PGlite();
try {
  const base = await readFile(new URL('../supabase/migrations/20260904130000_hivra_provider_resize_operations.sql',import.meta.url),'utf8');
  const migration = await readFile(new URL('../supabase/migrations/20260906030000_provider_usd_capacity_ceiling.sql',import.meta.url),'utf8');
  const original = base.slice(base.indexOf('create function public.hivra_provider_resize_quote_valid('),base.indexOf('create function public.hivra_provider_resize_action_valid(')).trim();
  const replacement = migration.slice(migration.indexOf('create or replace function')).trim();
  assert.equal(replacement,original.replace('create function','create or replace function').replace("when 'EUR' then 45 else 50 end","when 'EUR' then 45 else 60 end"));
  await db.exec('create role anon;create role authenticated;create role service_role;');
  await db.exec(base.slice(0,base.indexOf('create function public.hivra_provider_resize_action_valid(')));
  const signature='hivra_provider_resize_quote_valid(jsonb,uuid,uuid,text,text,timestamptz,timestamptz)';
  await db.exec(`revoke all on function ${signature} from public,anon,authenticated;grant execute on function ${signature} to service_role;`);
  const op='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',agent='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const size = (name,price,ram=8) => ({serverTypeId:name==='cpx22'?104:105,serverType:name,architecture:'x86',cores:4,memoryGb:ram,advertisedDiskGb:80,cpuType:'shared',price:{currency:'USD',hourlyGross:'0.08',monthlyGross:price}});
  const quote={operationId:op,agentId:agent,providerServerId:'42',quoteFingerprint:'a'.repeat(64),location:'fsn1',
    source:size('cpx22','27.588',4),target:size('cpx32','50.388'),existingDiskGb:40,upgradeDisk:false,
    observedAt:'2026-09-05T17:00:00Z',expiresAt:'2026-09-05T17:05:00Z',
    downtimeNotice:'The computer must stay powered off while Hetzner changes its server type. Hivra leaves it stopped after the resize so you can review the result before starting it again.',
    billingConfirmation:'Resize this server and accept the new Hetzner billing'};
  const valid=async q=>(await db.query(`select ${signature.split('(')[0]}($1,$2,$3,$4,$5,$6,$7) as ok`,[q,op,agent,'42',quote.quoteFingerprint,quote.observedAt,quote.expiresAt])).rows[0].ok;
  assert.equal(await valid(quote),false);
  await db.exec(migration);
  assert.equal(await valid(quote),true);
  for(const value of ['49','60'])assert.equal(await valid({...quote,target:size('cpx32',value)}),true);
  assert.equal(await valid({...quote,target:size('cpx32','60.01')}),false);
  assert.equal(await valid({...quote,upgradeDisk:true}),false);
  assert.equal(await valid({...quote,agentId:op}),false);
  assert.equal(await valid({...quote,existingDiskGb:81}),false);
  const euro=structuredClone(quote);euro.source.price.currency='EUR';euro.target.price.currency='EUR';
  euro.target.price.monthlyGross='45';assert.equal(await valid(euro),true);
  euro.target.price.monthlyGross='45.01';assert.equal(await valid(euro),false);
  for(const role of ['anon','authenticated','service_role']){
    const r=await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as ok',[role,signature]);
    assert.equal(r.rows[0].ok,role==='service_role');
  }
  console.log('PASS USD ceiling: actual 8 GiB receipt, 60 boundary, unchanged EUR, disk/identity/consent and ACL retention');
} finally {await db.close();}
