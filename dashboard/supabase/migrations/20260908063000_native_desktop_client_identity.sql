-- Bind the public half of an isolated Moonlight identity to its session.

alter table public.hivra_remote_desktop_sessions
  add column if not exists native_profile_bound boolean not null default false,
  add column if not exists native_client_id uuid,
  add column if not exists native_client_certificate_pem text,
  add column if not exists native_client_certificate_sha256 text;

alter table public.hivra_remote_desktop_sessions
  add constraint hivra_remote_desktop_native_profile_shape check (
    (native_profile_bound=false and native_client_id is null
      and native_client_certificate_pem is null
      and native_client_certificate_sha256 is null)
    or (native_profile_bound=true and transport='sunshine-moonlight'
      and native_client_id is not null
      and native_client_certificate_pem is not null
      and octet_length(native_client_certificate_pem) between 64 and 16384
      and native_client_certificate_sha256 ~ '^[a-f0-9]{64}$')
  );

create or replace function public.issue_hivra_remote_desktop_session_v3(
  p_user_id text,p_session_id uuid,p_computer_kind text,p_computer_id uuid,
  p_transport text,p_input_role text,p_handoff text,p_exchange_code_hash text,
  p_pkce_challenge text,p_issued_at timestamptz,p_expires_at timestamptz,
  p_relay_credential_expires_at timestamptz,p_streaming_mode text,
  p_native_client_id uuid,p_native_client_certificate_pem text,
  p_native_client_certificate_sha256 text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_result jsonb;
  v_updated integer:=0;
begin
  if (
    p_transport='sunshine-moonlight' and (
      p_native_client_id is null
      or p_native_client_certificate_pem is null
      or octet_length(p_native_client_certificate_pem) not between 64 and 16384
      or p_native_client_certificate_pem !~ '^-----BEGIN CERTIFICATE-----[[:space:]]'
      or p_native_client_certificate_pem !~ '[[:space:]]-----END CERTIFICATE-----[[:space:]]*$'
      or p_native_client_certificate_sha256 is null
      or p_native_client_certificate_sha256 !~ '^[a-f0-9]{64}$'
    )
  ) or (
    p_transport<>'sunshine-moonlight' and (
      p_native_client_id is not null
      or p_native_client_certificate_pem is not null
      or p_native_client_certificate_sha256 is not null
    )
  ) then
    return jsonb_build_object('status','invalid_request');
  end if;

  v_result:=public.issue_hivra_remote_desktop_session_v2(
    p_user_id,p_session_id,p_computer_kind,p_computer_id,p_transport,p_input_role,
    p_handoff,p_exchange_code_hash,p_pkce_challenge,p_issued_at,p_expires_at,
    p_relay_credential_expires_at,p_streaming_mode
  );
  if v_result->>'status'<>'issued' then return v_result; end if;

  if p_transport='sunshine-moonlight' then
    update public.hivra_remote_desktop_sessions set
      native_profile_bound=true,
      native_client_id=p_native_client_id,
      native_client_certificate_pem=p_native_client_certificate_pem,
      native_client_certificate_sha256=p_native_client_certificate_sha256,
      updated_at=clock_timestamp()
    where id=p_session_id and user_id=p_user_id
      and transport='sunshine-moonlight' and native_profile_bound=false;
    get diagnostics v_updated=row_count;
    if v_updated<>1 then
      delete from public.hivra_remote_desktop_sessions
      where id=p_session_id and user_id=p_user_id and native_profile_bound=false;
      return jsonb_build_object('status','operation_conflict');
    end if;
    v_result:=v_result||jsonb_build_object(
      'nativeProfileBound',true,
      'nativeClientId',p_native_client_id,
      'nativeClientCertificateSha256',p_native_client_certificate_sha256
    );
  end if;
  return v_result;
end;
$$;

revoke all on function public.issue_hivra_remote_desktop_session_v3(
  text,uuid,text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,
  text,uuid,text,text
) from public,anon,authenticated;
grant execute on function public.issue_hivra_remote_desktop_session_v3(
  text,uuid,text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,
  text,uuid,text,text
) to service_role;
