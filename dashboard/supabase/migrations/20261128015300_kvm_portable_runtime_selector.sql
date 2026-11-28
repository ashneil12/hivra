set local lock_timeout = '2s';

alter table hivra_kvm_portable_private.pilot_enrollment
  add column runtime_profile jsonb,
  add column runtime_expires_at timestamptz,
  add constraint pilot_enrollment_runtime_window check (
    (runtime_profile is null and runtime_expires_at is null)
    or (
      runtime_profile is not null and runtime_expires_at is not null
      and jsonb_typeof(runtime_profile) = 'object'
      and isfinite(enrolled_at) and isfinite(runtime_expires_at)
      and runtime_expires_at > enrolled_at
      and runtime_expires_at <= enrolled_at + interval '4 hours'
    )
  );

revoke all on table hivra_kvm_portable_private.pilot_enrollment from public, anon, authenticated, service_role;

create function public.read_hivra_kvm_portable_pilot(
  p_owner_id text default null,
  p_agent_id uuid default null
)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select jsonb_build_object(
    'ownerId', e.owner_id,
    'agentId', e.agent_id,
    'placements', jsonb_build_array(e.placement_a, e.placement_b),
    'profile', e.runtime_profile,
    'expiresAt', e.runtime_expires_at
  )
  from hivra_kvm_portable_private.pilot_enrollment e
  join public.hivra_agents a on a.id=e.agent_id and a.user_id=e.owner_id
  where ((p_owner_id is null and p_agent_id is null)
      or (e.owner_id=p_owner_id and (p_agent_id is null or e.agent_id=p_agent_id)))
    and e.runtime_profile is not null
    and e.enrolled_at <= statement_timestamp() and e.runtime_expires_at > statement_timestamp()
    and a.deployment_mode='hivra-managed' and a.computer_substrate='proxmox-kvm'
    and a.deployment_target_id is null and a.computer_profile is distinct from 'windows'
    and a.type<>'windows' and a.seat_funding='paid' and a.canary_qa_holder_expires_at is null
    and a.status='running' and a.desired_state='running'
    and not exists (select 1 from canary_qa_writer_private.scope s where s.owner_id=e.owner_id)
    and a.infrastructure_binding_token_enforced
    and a.infrastructure_binding_token_hash ~ '^[0-9a-f]{64}$'
    and e.binding_token_hash=a.infrastructure_binding_token_hash
    and hivra_kvm_portable_private.valid_target(e.placement_a)
    and hivra_kvm_portable_private.valid_target(e.placement_b)
    and e.placement_a->>'hostId' <> e.placement_b->>'hostId'
    and e.placement_a->>'ip' = e.placement_b->>'ip'
    and e.placement_a->>'bindingTag'='hivra-bind-'||left(e.binding_token_hash,32)
    and e.placement_b->>'bindingTag'='hivra-bind-'||left(e.binding_token_hash,32)
    and hivra_kvm_portable_private.agent_target(a) in (e.placement_a,e.placement_b);
$$;

revoke all on function public.read_hivra_kvm_portable_pilot(text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.read_hivra_kvm_portable_pilot(text,uuid) to service_role;
