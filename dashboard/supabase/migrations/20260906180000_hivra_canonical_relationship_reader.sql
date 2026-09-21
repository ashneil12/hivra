-- Explicit owner-scoped read contract. Does not select the new inventory reader,
-- grant a canonical writer, or enable attachment. One statement/snapshot joins
-- current relationships independently of immutable source-mapping slots.
create function public.read_hivra_canonical_computer_relationships(p_owner text,p_computer_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with owned as (
    select c.*,m.source_kind,m.source_id,m.compatibility_alias,m.resource_kind as source_resource_kind,
      a.write_authority as relationship_writer,a.generation as relationship_generation,a.command_id
    from public.hivra_canonical_computers c
    left join public.hivra_canonical_source_mappings m on m.computer_id=c.id and m.user_id=c.user_id
    left join public.hivra_canonical_relationship_authority a on a.computer_id=c.id and a.user_id=c.user_id
    where c.id=p_computer_id and c.user_id=p_owner
  ), bindings as (
    select b.* from public.hivra_canonical_primary_bindings b
    join owned c on c.id=b.computer_id and c.user_id=b.user_id
  ), installations as (
    select i.* from public.hivra_canonical_runtime_installations i
    join owned c on c.id=i.computer_id and c.user_id=i.user_id
  ), identities as (
    select i.* from public.hivra_canonical_agent_identities i
    where exists(select 1 from bindings b where b.agent_identity_id=i.id and b.user_id=i.user_id)
  )
  select jsonb_build_object(
    'contractVersion','2026-09-06-relationships-v1',
    'computerId',c.id,'ownerId',c.user_id,'name',c.name,
    'source',jsonb_build_object('kind',c.source_kind,'id',c.source_id,
      'alias',c.compatibility_alias,'resourceKind',c.source_resource_kind),
    'lifecycle',jsonb_build_object('authority',jsonb_build_object('writer',c.write_authority,
      'generation',c.authority_generation::text,'commandId',c.authority_command_id),
      'sourceEventId',c.source_event_id::text,'desired',c.desired_state,'observed',c.observed_state,
      'tombstoned',c.tombstoned_at is not null),
    'relationshipAuthority',jsonb_build_object('writer',c.relationship_writer,
      'generation',c.relationship_generation::text,'commandId',c.command_id),
    'identities',coalesce((select jsonb_agg(jsonb_build_object(
      'id',i.id,'ownerId',i.user_id,'name',i.name,'status',i.status,'sourceEventId',i.source_event_id::text,
      'authority',jsonb_build_object('writer',i.write_authority,'generation',i.authority_generation::text,
        'commandId',i.authority_command_id)) order by i.id) from identities i),'[]'::jsonb),
    'installations',coalesce((select jsonb_agg(jsonb_build_object(
      'id',i.id,'ownerId',i.user_id,'computerId',i.computer_id,'runtimeId',i.runtime_id,
      'status',i.status,'sourceEventId',i.source_event_id::text,
      'authority',jsonb_build_object('writer',i.write_authority,'generation',i.authority_generation::text,
        'commandId',i.authority_command_id)) order by i.id) from installations i),'[]'::jsonb),
    'bindings',coalesce((select jsonb_agg(jsonb_build_object(
      'id',b.id,'ownerId',b.user_id,'computerId',b.computer_id,'agentIdentityId',b.agent_identity_id,
      'status',b.status,'sourceEventId',b.source_event_id::text,'boundAt',b.bound_at,'detachedAt',b.detached_at,
      'authority',jsonb_build_object('writer',b.write_authority,'generation',b.authority_generation::text,
        'commandId',b.authority_command_id)) order by b.id) from bindings b),'[]'::jsonb)
  ) from owned c;
$$;

revoke all on function public.read_hivra_canonical_computer_relationships(text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.read_hivra_canonical_computer_relationships(text,uuid) to service_role;
comment on function public.read_hivra_canonical_computer_relationships(text,uuid) is
  'Service-only owner-scoped relationship snapshot. Caller must derive owner from authentication; not a writer, availability claim, or inventory cutover.';
