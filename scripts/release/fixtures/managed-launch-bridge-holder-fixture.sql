insert into public.proxmox_hosts(id,total_cpu,total_ram_mb,cpu_overcommit_ratio,thinpool_size_gb)
values ('bridge-host',32,131072,1,1000);

insert into public.token_tier_qualifications(user_id,tier,token_key,currently_eligible,
  qualifying_quantity,threshold_at_qualification,qualifying_threshold_tier)
values ('bridge-grandfather','pro','hermesos',true,100,100,'PRO_STANDARD'),
       ('bridge-waitlisted','pro','hermesos',true,100,100,'PRO_STANDARD');

set role service_role;
do $$
declare
  result jsonb;
begin
  result := public.reserve_hivra_launch_model_request_v3(
    'bridge-grandfather','10101010-1010-4010-8010-101010101010',
    jsonb_build_array(jsonb_build_object('version',2,'keyTag',repeat('a',64),'digest',repeat('b',64))),
    '30303030-3030-4030-8030-303030303030',
    jsonb_build_object('id','20202020-2020-4020-8020-202020202020','name','Old receipt',
      'type','codex','cpu',1,'ram',2,'deployment_mode','hivra-managed',
      'computer_substrate','proxmox-kvm','proxmox_host','bridge-host','operation_id',gen_random_uuid(),
      'infrastructure_binding_token_hash',repeat('c',64)),
    '{"provider":"venice","mode":"managed","model":"synthetic","walletType":"card"}',null,1
  );
  if result->>'status' is distinct from 'reserved' then
    raise exception 'Could not seed old receipt: %', result;
  end if;
end;
$$;
reset role;
