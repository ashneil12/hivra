-- Service-only retrieval of the exact persisted guardian authority for an
-- authenticated owner stop/renewal coordinator.

create or replace function public.load_hivra_omarchy_native_activation_grant(
  p_user_id text,p_session_id uuid,p_activation_id uuid
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  stored public.hivra_omarchy_native_activation_grants%rowtype;
begin
  if p_user_id is null or p_user_id='' or p_session_id is null or p_activation_id is null then
    return jsonb_build_object('status','invalid_request');
  end if;
  select g.* into stored
  from public.hivra_omarchy_native_activation_grants g
  join public.hivra_remote_desktop_sessions s on s.id=g.session_id
  where g.session_id=p_session_id and g.activation_id=p_activation_id
    and g.user_id=p_user_id and s.user_id=p_user_id
    and s.native_activation_id=p_activation_id;
  if not found then return jsonb_build_object('status','denied'); end if;
  return jsonb_build_object('status','loaded','sessionId',stored.session_id,
    'activationId',stored.activation_id,'guardianGrant',stored.guardian_grant);
end;
$$;

revoke all on function public.load_hivra_omarchy_native_activation_grant(text,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.load_hivra_omarchy_native_activation_grant(text,uuid,uuid)
  to service_role;
