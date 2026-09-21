-- Original-server absence is different evidence from successful guest cleanup.
-- This narrow handoff requires an already observed terminal desktop installer
-- and explicit delete intent. It neither destroys a server nor completes delete.
create table public.hivra_provider_desktop_absence (
  agent_id uuid primary key references public.hivra_agents(id),
  user_id text not null,
  operation_id uuid not null,
  identity jsonb not null,
  connection_id uuid not null,
  connection_revision bigint not null,
  target_id uuid not null,
  order_id uuid not null,
  enrollment_attempt_id uuid not null,
  server_id text not null,
  observed_at timestamptz not null,
  recorded_at timestamptz not null
);
alter table public.hivra_provider_desktop_absence enable row level security;
revoke all on public.hivra_provider_desktop_absence from public,anon,authenticated,service_role;
grant select on public.hivra_provider_desktop_absence to service_role;

create function public.hivra_provider_desktop_absence_verified(a public.hivra_agents)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.hivra_provider_desktop_absence j
    where j.agent_id=a.id and j.user_id=a.user_id and j.operation_id=a.operation_id
      and j.identity=a.provider_install_identity and j.connection_id=a.infrastructure_connection_id
      and j.connection_revision=a.infrastructure_connection_revision and j.target_id=a.deployment_target_id
      and j.order_id=a.provider_capacity_order_id and j.enrollment_attempt_id=a.provider_enrollment_attempt_id
      and j.server_id=a.provider_server_id and j.observed_at>=clock_timestamp()-interval '15 seconds'
      and j.observed_at<=clock_timestamp()+interval '5 seconds'
      and j.recorded_at>=j.observed_at-interval '5 seconds');
$$;
revoke all on function public.hivra_provider_desktop_absence_verified(public.hivra_agents) from public,anon,authenticated;
grant execute on function public.hivra_provider_desktop_absence_verified(public.hivra_agents) to service_role;

-- Preserve the existing guard verbatim except this independently evidenced
-- error handoff. No running/stopped/deleted transition or unfinished worker is
-- admitted. A missing expected anchor aborts instead of replacing unknown code.
do $migration$
declare definition text; anchor text := $anchor$    -- A combined stopped+release update cannot bypass committed evidence.$anchor$;
begin
  select pg_get_functiondef('public.guard_hivra_provider_desktop_lifecycle()'::regprocedure) into definition;
  if length(definition)-length(replace(definition,anchor,'')) <> length(anchor) then
    raise exception 'Unexpected desktop lifecycle guard'; end if;
  execute replace(definition,anchor,$replacement$    if old.desired_state='deleted' and new.desired_state='deleted' and new.status='error'
      and old.provider_install_stopped_at is not null
      and public.hivra_provider_desktop_absence_verified(old) then
      return new; -- Original server absent, not a fabricated guest-stop proof.
    end if;
    -- A combined stopped+release update cannot bypass committed evidence.$replacement$);
end;
$migration$;

create function public.handoff_hivra_absent_desktop_provision(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_connection_id uuid,p_revision bigint,
  p_target_id uuid,p_order_id uuid,p_attempt_id uuid,p_server_id text,p_observed_at timestamptz
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; locked public.hivra_agents%rowtype; o public.infrastructure_capacity_orders%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id;
  if not found or a.computer_substrate is distinct from 'provider-vm'
    or a.type is distinct from 'linux-desktop' or a.computer_profile is distinct from 'ubuntu-desktop'
    or a.status is distinct from 'provisioning' or a.desired_state is distinct from 'deleted'
    or a.operation_kind is distinct from 'provision' or a.operation_id is distinct from p_operation_id
    or a.allocation_operation_id is distinct from p_operation_id or a.provider_install_stopped_at is null
    or not public.hivra_provider_desktop_identity_valid(a.provider_install_identity,a.id,a.operation_id)
    or row(a.infrastructure_connection_id,a.infrastructure_connection_revision,a.deployment_target_id,
      a.provider_capacity_order_id,a.provider_enrollment_attempt_id,a.provider_server_id)
      is distinct from row(p_connection_id,p_revision,p_target_id,p_order_id,p_attempt_id,p_server_id)
    or p_observed_at is null or p_observed_at<clock_timestamp()-interval '15 seconds'
    or p_observed_at>clock_timestamp()+interval '5 seconds' then return false; end if;
  perform id from public.infrastructure_connections where id=p_connection_id and user_id=p_user_id
    and revision=p_revision and status='ready' and provider='hetzner-cloud' for update;
  if not found then return false; end if;
  select * into o from public.infrastructure_capacity_orders where id=p_order_id and user_id=p_user_id
    and connection_id=p_connection_id and active_connection_id=p_connection_id and connection_revision=p_revision
    and provider='hetzner-cloud' and provider_resource_id=p_server_id
    and provider_creation_receipt->>'serverId'=p_server_id for update;
  if not found then return false; end if;
  perform order_id from public.infrastructure_first_boot_enrollments where order_id=p_order_id
    and user_id=p_user_id and connection_id=p_connection_id and connection_revision=p_revision
    and attempt_id=p_attempt_id and provider_server_id=p_server_id
    and quote_fingerprint_sha256=o.quote_fingerprint_sha256 for update;
  if not found then return false; end if;
  perform order_id from public.infrastructure_first_boot_operations where order_id=p_order_id
    and user_id=p_user_id and connection_id=p_connection_id and connection_revision=p_revision
    and attempt_id=p_attempt_id and provider_server_id=p_server_id
    and quote_fingerprint_sha256=o.quote_fingerprint_sha256 for update;
  if not found then return false; end if;
  perform id from public.deployment_targets where id=p_target_id and user_id=p_user_id
    and connection_id=p_connection_id and evidence_connection_revision=p_revision
    and provider_capacity_order_id=p_order_id and external_id=p_server_id for update;
  if not found then return false; end if;
  -- Match provider lifecycle parent-first locking, then recheck the original
  -- child snapshot. A concurrent operation cannot be adopted after waiting.
  select * into locked from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found or locked is distinct from a
    or p_observed_at<clock_timestamp()-interval '15 seconds'
    or p_observed_at>clock_timestamp()+interval '5 seconds' then return false; end if;
  -- No direct role can forge this journal; insertion and handoff are atomic.
  insert into public.hivra_provider_desktop_absence values(a.id,a.user_id,a.operation_id,a.provider_install_identity,
    p_connection_id,p_revision,p_target_id,p_order_id,p_attempt_id,p_server_id,p_observed_at,clock_timestamp())
    on conflict(agent_id) do update set observed_at=excluded.observed_at,recorded_at=excluded.recorded_at
      where row(hivra_provider_desktop_absence.user_id,hivra_provider_desktop_absence.operation_id,
        hivra_provider_desktop_absence.identity,hivra_provider_desktop_absence.connection_id,
        hivra_provider_desktop_absence.connection_revision,hivra_provider_desktop_absence.target_id,
        hivra_provider_desktop_absence.order_id,hivra_provider_desktop_absence.enrollment_attempt_id,
        hivra_provider_desktop_absence.server_id)
      = row(excluded.user_id,excluded.operation_id,excluded.identity,excluded.connection_id,
        excluded.connection_revision,excluded.target_id,excluded.order_id,excluded.enrollment_attempt_id,excluded.server_id);
  if not public.hivra_provider_desktop_absence_verified(a) then
    raise exception 'Provider absence expired before handoff' using errcode='55006'; end if;
  update public.hivra_agents set status='error',
    error='The original provider server is absent. Remaining resource cleanup is requested.',
    operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=a.id and user_id=a.user_id;
  return true;
end;
$$;
revoke all on function public.handoff_hivra_absent_desktop_provision(text,uuid,uuid,uuid,bigint,uuid,uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.handoff_hivra_absent_desktop_provision(text,uuid,uuid,uuid,bigint,uuid,uuid,uuid,text,timestamptz) to service_role;
