-- Omarchy 4.5 publishes architecture-qualified ISO names. Keep x86-only
-- release admission, exact official URL/checksum, owner/slot locks and grants.
-- This additive migration does not rewrite the already-applied refresh migration.
do $guard$
begin
 if (select md5(prosrc) from pg_proc where oid='public.reserve_hivra_prepared_omarchy(jsonb,integer,jsonb,jsonb)'::regprocedure)
   not in ('a643077616d790dbfd349c5e3d380d60','c40bc6e21f1a0acfb4c4dc1dbb5dcd63') then
   raise exception 'prepared Omarchy reservation definition changed; review before applying';
 end if;
end;
$guard$;

create or replace function public.reserve_hivra_prepared_omarchy(p_row jsonb,p_agent_limit integer,p_release jsonb,p_slot jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r jsonb; a public.hivra_agents%rowtype; v_id uuid;
begin
 if p_row->>'computer_profile' is distinct from 'omarchy' or p_row->>'type' is distinct from 'linux-desktop'
   or p_row->>'computer_substrate' is distinct from 'proxmox-kvm'
   or p_row->>'deployment_mode' is distinct from 'hivra-managed'
   or p_row->>'status' is distinct from 'provisioning' or p_row->>'desired_state' is distinct from 'running'
   or p_row->>'operation_kind' is distinct from 'provision'
   or p_row->>'allocation_operation_id' is distinct from p_row->>'operation_id'
   or not coalesce(p_row->>'operation_id' ~ '^[a-f0-9-]{36}$',false)
   or p_row->'operation_payload' is distinct from jsonb_build_object('stage','prepared_omarchy_refresh','refreshId',p_row->>'operation_id')
   or jsonb_typeof(p_release) is distinct from 'object' or jsonb_typeof(p_slot) is distinct from 'object'
   or p_release-array['release','releaseCommit','isoUrl','isoFilename','isoSha256']<>'{}'::jsonb
   or p_slot-array['host','node','vmid','ip','claim','name']<>'{}'::jsonb
   or not coalesce(p_slot->>'claim' ~ '^[a-f0-9-]{36}$',false)
   or not coalesce(p_slot->>'node' ~ '^[a-z0-9][a-z0-9-]{0,62}$',false)
   or not coalesce(p_release->>'release' ~ '^v4\.[0-9]{1,4}\.[0-9]{1,4}$',false)
   or not coalesce(p_release->>'releaseCommit' ~ '^[a-f0-9]{40}$',false)
   or not coalesce(p_release->>'isoSha256' ~ '^[a-f0-9]{64}$',false)
   or p_release->>'isoFilename' is distinct from ('omarchy-'||substring(p_release->>'release' from 2)||
      case when p_release->>'release' ~ '^v4\.[0-9]{1,4}\.[0-9]{1,4}$' then
        case when split_part(substring(p_release->>'release' from 2),'.',2)::integer>=5 then '-x86' else '' end
      else '' end||'.iso')
   or p_release->>'isoUrl' is distinct from 'https://iso.omarchy.org/'||(p_release->>'isoFilename')
   or p_slot->>'host' is distinct from p_row->>'proxmox_host' or p_slot->'vmid' is distinct from p_row->'vmid'
   or p_slot->>'ip' is distinct from p_row->>'ip'
 then return jsonb_build_object('status','invalid_request'); end if;
 perform pg_advisory_xact_lock(hashtextextended('hivra-prepared-omarchy:'||(p_slot->>'host')||':'||(p_slot->>'vmid'),0));
 select * into a from public.hivra_agents where proxmox_host=p_slot->>'host' and vmid=(p_slot->>'vmid')::integer and status<>'deleted' for update;
 if found then
   if a.user_id=p_row->>'user_id' and a.computer_profile='omarchy' then
     return jsonb_build_object('status','inserted','row',to_jsonb(a));
   end if;
   return jsonb_build_object('status','prepared_slot_claimed');
 end if;
 r:=public.insert_hivra_managed_agent(p_row,p_agent_limit);
 if r->>'status'<>'inserted' then return r; end if;
 select * into a from public.hivra_agents where id=(r->'row'->>'id')::uuid;
 v_id:=a.operation_id;
 insert into public.hivra_prepared_omarchy_refreshes(id,agent_id,user_id,authority,requested_release,slot,phase)
   values(v_id,a.id,a.user_id,public.hivra_prepared_omarchy_authority(a),p_release,p_slot,'reserved');
 return r;
end;
$$;

revoke all on function public.reserve_hivra_prepared_omarchy(jsonb,integer,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_hivra_prepared_omarchy(jsonb,integer,jsonb,jsonb) to service_role;
