-- Reserve a paid prepared Omarchy computer before OS mutation. A reserved
-- computer is not admitted to Desktop until the exact requested release and
-- rebooted desktop have terminal host evidence. Existing owner opens unchanged.
create table public.hivra_prepared_omarchy_refreshes (
  id uuid primary key, agent_id uuid not null references public.hivra_agents(id), user_id text not null,
  authority jsonb not null, requested_release jsonb not null, slot jsonb not null,
  phase text not null check (phase in ('reserved','dispatched','complete','failed','cancelled')),
  created_at timestamptz not null default clock_timestamp(), completed_at timestamptz,
  terminal_receipt jsonb,
  check (jsonb_typeof(authority)='object' and jsonb_typeof(requested_release)='object' and jsonb_typeof(slot)='object')
);
create unique index hivra_prepared_omarchy_one_active on public.hivra_prepared_omarchy_refreshes(agent_id)
  where phase in ('reserved','dispatched','failed');
alter table public.hivra_prepared_omarchy_refreshes enable row level security;
revoke all on public.hivra_prepared_omarchy_refreshes from public,anon,authenticated,service_role;
grant select on public.hivra_prepared_omarchy_refreshes to service_role;
alter table public.hivra_agents add column if not exists omarchy_release_receipt jsonb;

create function public.hivra_prepared_omarchy_authority(a public.hivra_agents)
returns jsonb language sql immutable security invoker set search_path=public,pg_temp as $$
 select public.hivra_desktop_prepare_authority(a)-'infrastructure_binding_token_enforced'
   || jsonb_build_object('allocation_operation_id',(a).allocation_operation_id);
$$;

create function public.guard_hivra_prepared_omarchy_refresh()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.hivra_prepared_omarchy_refreshes%rowtype;
begin
 select * into p from public.hivra_prepared_omarchy_refreshes where agent_id=old.id and phase in ('reserved','dispatched','failed');
 if not found then return new; end if;
 if public.hivra_prepared_omarchy_authority(new) is distinct from p.authority
   or new.operation_id is distinct from p.id or new.operation_kind is distinct from 'provision'
   or new.operation_payload is distinct from jsonb_build_object('stage','prepared_omarchy_refresh','refreshId',p.id::text)
   or new.status is distinct from (case when p.phase='failed' then 'error' else 'provisioning' end)
   or new.desired_state is null or new.desired_state not in ('running','deleted')
   or (old.desired_state='deleted' and new.desired_state is distinct from 'deleted')
   or (old.infrastructure_binding_token_enforced is true and new.infrastructure_binding_token_enforced is distinct from true)
 then raise exception 'prepared Omarchy refresh requires exact terminal evidence' using errcode='55000'; end if;
 return new;
end;
$$;
create trigger hivra_prepared_omarchy_refresh_guard before update on public.hivra_agents
 for each row execute function public.guard_hivra_prepared_omarchy_refresh();

create function public.reserve_hivra_prepared_omarchy(p_row jsonb,p_agent_limit integer,p_release jsonb,p_slot jsonb)
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
   or p_release->>'isoFilename' is distinct from 'omarchy-'||substring(p_release->>'release' from 2)||'.iso'
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

-- Binding cannot be admitted by a stale request after cancellation/reuse.
create function public.bind_hivra_prepared_omarchy(p_user_id text,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.hivra_prepared_omarchy_refreshes%rowtype; a public.hivra_agents%rowtype;
begin
 select * into p from public.hivra_prepared_omarchy_refreshes where id=p_operation_id and user_id=p_user_id;
 if not found or p.phase not in ('reserved','dispatched') then return false; end if;
 select * into a from public.hivra_agents where id=p.agent_id and user_id=p_user_id for update;
 if not found or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'provision'
   or a.status is distinct from 'provisioning' or a.desired_state is distinct from 'running'
   or public.hivra_prepared_omarchy_authority(a) is distinct from p.authority
 then return false; end if;
 update public.hivra_agents set infrastructure_binding_token_enforced=true where id=a.id;
 return true;
end;
$$;

create function public.dispatch_hivra_prepared_omarchy(p_user_id text,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.hivra_prepared_omarchy_refreshes%rowtype; a public.hivra_agents%rowtype;
begin
 select * into p from public.hivra_prepared_omarchy_refreshes where id=p_operation_id and user_id=p_user_id;
 if not found then return false; end if;
 select * into a from public.hivra_agents where id=p.agent_id and user_id=p_user_id for update;
 if not found or a.operation_id is distinct from p.id or a.operation_kind<>'provision'
   or a.status<>'provisioning' or a.desired_state not in ('running','deleted')
   or public.hivra_prepared_omarchy_authority(a) is distinct from p.authority
   or (a.desired_state='running' and a.infrastructure_binding_token_enforced is distinct from true)
 then return false; end if;
 update public.hivra_prepared_omarchy_refreshes set phase='dispatched' where id=p.id and phase='reserved';
 return found or p.phase='dispatched';
end;
$$;

create function public.cancel_hivra_prepared_omarchy(p_user_id text,p_operation_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.hivra_prepared_omarchy_refreshes%rowtype;
begin
 select * into p from public.hivra_prepared_omarchy_refreshes where id=p_operation_id and user_id=p_user_id;
 if not found or p.phase not in ('reserved','dispatched','failed') then return false; end if;
 update public.hivra_agents set desired_state='deleted' where id=p.agent_id and user_id=p_user_id
   and operation_id=p.id and operation_kind='provision';
 return found;
end;
$$;

create function public.complete_hivra_prepared_omarchy(p_user_id text,p_operation_id uuid,p_receipt jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.hivra_prepared_omarchy_refreshes%rowtype; a public.hivra_agents%rowtype; observed jsonb; outcome text;
begin
 select * into p from public.hivra_prepared_omarchy_refreshes where id=p_operation_id and user_id=p_user_id;
 if not found then return false; end if;
 select * into a from public.hivra_agents where id=p.agent_id and user_id=p_user_id for update;
 select * into p from public.hivra_prepared_omarchy_refreshes where id=p_operation_id for update;
 if p.phase in ('complete','cancelled') then return p.terminal_receipt=p_receipt; end if;
 if public.hivra_prepared_omarchy_authority(a) is distinct from p.authority
   or a.operation_id is distinct from p.id or a.operation_kind is distinct from 'provision'
   or jsonb_typeof(p_receipt) is distinct from 'object'
   or p_receipt->'version' is distinct from '1'::jsonb
   or p_receipt->>'operationId' is distinct from p.id::text or p_receipt->>'computerId' is distinct from a.id::text
   or p_receipt->'vmid' is distinct from to_jsonb(a.vmid)
   or p_receipt->>'bindingTag' is distinct from 'hivra-bind-'||left(a.infrastructure_binding_token_hash,32)
   or p_receipt->'requestedRelease' is distinct from p.requested_release
   or p_receipt->'guestUpdaterStopped' is distinct from 'true'::jsonb
 then return false; end if;
 outcome:=p_receipt->>'state'; observed:=p_receipt->'observed';
 if outcome='complete' then
   if a.desired_state is distinct from 'running' or a.infrastructure_binding_token_enforced is distinct from true
     or p.phase<>'dispatched' or jsonb_typeof(observed) is distinct from 'object'
     or observed->>'osVersion' is distinct from substring(p.requested_release->>'release' from 2)
     or split_part(observed->>'packageVersion','-',1) is distinct from observed->>'osVersion'
     or not coalesce(observed->>'packageVersion' ~ '^[0-9]+\.[0-9]+\.[0-9]+-[0-9]+(\.[0-9]+)?$',false)
     or not coalesce(observed->>'kernelRelease' ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}$',false)
     or observed->>'kernelRelease' is distinct from observed->>'selectedKernel'
     or not coalesce(observed->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$',false)
     or observed->'desktopReady' is distinct from 'true'::jsonb
     or observed->'migrationsComplete' is distinct from 'true'::jsonb
     or not coalesce(observed->>'bootIdBefore' ~ '^[a-f0-9-]{36}$',false)
     or not coalesce(observed->>'bootIdAfter' ~ '^[a-f0-9-]{36}$',false)
     or observed->>'bootIdBefore'=observed->>'bootIdAfter'
   then return false; end if;
 elsif outcome='cancelled' then
   if a.desired_state is distinct from 'deleted' or p_receipt->'bindingReleased' is distinct from 'true'::jsonb then return false; end if;
 elsif outcome='failed' then
   if p.phase not in ('dispatched','failed') or not coalesce(p_receipt->>'errorCode' ~ '^[a-z][a-z0-9_]{0,63}$',false) then return false; end if;
 else return false; end if;
 update public.hivra_prepared_omarchy_refreshes set phase=outcome,completed_at=clock_timestamp(),terminal_receipt=p_receipt where id=p.id;
 if outcome='failed' then
   update public.hivra_agents set status='error',error='Omarchy could not finish updating. Inspect this computer before retrying.' where id=a.id;
 else
   update public.hivra_agents set status=case when outcome='complete' then 'running' else 'deleted' end,
     operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null,error=null,
     provisioned_at=case when outcome='complete' then clock_timestamp() else provisioned_at end,
     omarchy_release_receipt=case when outcome='complete' then jsonb_build_object('requestedRelease',p.requested_release,'observed',jsonb_build_object('packageVersion',observed->>'packageVersion','osVersion',observed->>'osVersion','kernelRelease',observed->>'kernelRelease','observedAt',observed->>'observedAt')) else null end
     where id=a.id;
 end if;
 return true;
end;
$$;

-- An older deployment must not bypass latest-version preparation for new
-- Omarchy owners after this migration. Existing rows and owner opens unaffected.
create function public.guard_hivra_prepared_omarchy_reservation()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.computer_profile='omarchy' and new.deployment_mode='hivra-managed' and new.status<>'deleted' then
   perform 1 from public.hivra_prepared_omarchy_refreshes p where p.agent_id=new.id and p.id=new.operation_id
     and p.user_id=new.user_id and p.phase='reserved' and public.hivra_prepared_omarchy_authority(new)=p.authority;
   if not found then raise exception 'New prepared Omarchy claim requires a reserved refresh operation' using errcode='55000'; end if;
 end if;
 return null;
end;
$$;
create constraint trigger hivra_prepared_omarchy_reservation_guard after insert on public.hivra_agents
 deferrable initially deferred for each row execute function public.guard_hivra_prepared_omarchy_reservation();

revoke all on function public.hivra_prepared_omarchy_authority(public.hivra_agents),public.guard_hivra_prepared_omarchy_refresh(),
 public.guard_hivra_prepared_omarchy_reservation(),public.reserve_hivra_prepared_omarchy(jsonb,integer,jsonb,jsonb),
 public.bind_hivra_prepared_omarchy(text,uuid),public.dispatch_hivra_prepared_omarchy(text,uuid),public.cancel_hivra_prepared_omarchy(text,uuid),public.complete_hivra_prepared_omarchy(text,uuid,jsonb)
 from public,anon,authenticated;
grant execute on function public.reserve_hivra_prepared_omarchy(jsonb,integer,jsonb,jsonb),public.bind_hivra_prepared_omarchy(text,uuid),public.dispatch_hivra_prepared_omarchy(text,uuid),
 public.cancel_hivra_prepared_omarchy(text,uuid),public.complete_hivra_prepared_omarchy(text,uuid,jsonb) to service_role;
