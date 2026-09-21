-- Retire a dead controller only when a fresh, owner-bound capability proves
-- that the guest boot changed. Legacy and provider receipts carry no boot
-- identity and therefore retain the existing guest-confirmed release fence.

alter table public.hivra_remote_desktop_capabilities
  add column if not exists boot_identity_sha256 text
  check (boot_identity_sha256 is null or boot_identity_sha256 ~ '^[a-f0-9]{64}$');

alter table public.hivra_remote_desktop_sessions
  add column if not exists capability_boot_identity_sha256 text
  check (capability_boot_identity_sha256 is null or capability_boot_identity_sha256 ~ '^[a-f0-9]{64}$');

create or replace function public.preserve_hivra_remote_desktop_boot_identity()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  -- The v1 recorder knows nothing about boot evidence. Preserve an existing
  -- value across its capability refresh; only the v2 wrapper may replace it.
  if tg_op='UPDATE' and new.generation<>old.generation
    and new.boot_identity_sha256=old.boot_identity_sha256 then
    -- The legacy recorder's upsert does not mention this column, so PostgreSQL
    -- presents the old value in NEW. A changed generation without v2 evidence
    -- must clear it; the v2 wrapper sets its explicit hash in a second update.
    new.boot_identity_sha256:=null;
  end if;
  return new;
end;
$$;

drop trigger if exists hivra_remote_desktop_capability_boot_identity on public.hivra_remote_desktop_capabilities;
create trigger hivra_remote_desktop_capability_boot_identity
  before insert or update on public.hivra_remote_desktop_capabilities
  for each row execute function public.preserve_hivra_remote_desktop_boot_identity();

create or replace function public.record_hivra_remote_desktop_capability_v2(
  p_user_id text,p_computer_kind text,p_computer_id uuid,p_generation uuid,
  p_receipt jsonb,p_expires_at timestamptz,p_boot_identity_sha256 text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_result jsonb; v_updated integer:=0;
  v_previous public.hivra_remote_desktop_capabilities%rowtype;
  v_observed_at timestamptz;
begin
  if p_boot_identity_sha256 is null or p_boot_identity_sha256 !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status','invalid_receipt');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'hivra-remote-desktop-v1:'||p_computer_kind||':'||p_computer_id::text,0));
  select * into v_previous from public.hivra_remote_desktop_capabilities
    where computer_kind=p_computer_kind and computer_id=p_computer_id for update;
  begin
    v_observed_at:=(p_receipt->>'observedAt')::timestamptz;
  exception when others then
    return jsonb_build_object('status','invalid_receipt');
  end;
  if v_previous.computer_id is not null and v_observed_at<v_previous.observed_at then
    return jsonb_build_object('status','stale_observation');
  end if;
  v_result:=public.record_hivra_remote_desktop_capability(
    p_user_id,p_computer_kind,p_computer_id,p_generation,p_receipt,p_expires_at);
  if v_result->>'status'<>'ready' then return v_result; end if;
  update public.hivra_remote_desktop_capabilities set
    boot_identity_sha256=p_boot_identity_sha256
  where computer_kind=p_computer_kind and computer_id=p_computer_id
    and user_id=p_user_id and generation=p_generation and revoked_at is null;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then return jsonb_build_object('status','operation_conflict'); end if;
  if v_previous.computer_id is not null
    and v_previous.user_id=p_user_id
    and v_previous.boot_identity_sha256 is not null
    and v_previous.boot_identity_sha256<>p_boot_identity_sha256 then
    update public.hivra_remote_desktop_sessions set
      revoked_at=coalesce(revoked_at,clock_timestamp()),
      revoke_reason=coalesce(revoke_reason,'computer_restarted'),
      input_state='released',control_released_at=coalesce(control_released_at,clock_timestamp()),
      updated_at=clock_timestamp()
    where user_id=v_previous.user_id and computer_kind=v_previous.computer_kind
      and computer_id=v_previous.computer_id
      and capability_boot_identity_sha256=v_previous.boot_identity_sha256
      and input_role='controller'
      and input_state in ('takeover-pending','active','release-pending');
  end if;
  return v_result;
end;
$$;

create or replace function public.bind_hivra_remote_desktop_session_boot_identity()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.hivra_remote_desktop_capabilities%rowtype;
begin
  select * into c from public.hivra_remote_desktop_capabilities
    where computer_kind=new.computer_kind and computer_id=new.computer_id;
  if found and c.user_id=new.user_id and c.generation=new.capability_generation then
    new.capability_boot_identity_sha256:=c.boot_identity_sha256;
  else
    new.capability_boot_identity_sha256:=null;
  end if;
  return new;
end;
$$;

drop trigger if exists hivra_remote_desktop_session_boot_identity on public.hivra_remote_desktop_sessions;
create trigger hivra_remote_desktop_session_boot_identity
  before insert on public.hivra_remote_desktop_sessions
  for each row execute function public.bind_hivra_remote_desktop_session_boot_identity();

revoke all on function public.preserve_hivra_remote_desktop_boot_identity(),
  public.bind_hivra_remote_desktop_session_boot_identity() from public,anon,authenticated;
revoke all on function public.record_hivra_remote_desktop_capability_v2(text,text,uuid,uuid,jsonb,timestamptz,text)
  from public,anon,authenticated;
grant execute on function public.record_hivra_remote_desktop_capability_v2(text,text,uuid,uuid,jsonb,timestamptz,text)
  to service_role;
