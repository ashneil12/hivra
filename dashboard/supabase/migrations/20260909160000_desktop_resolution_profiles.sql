-- Extend the revision-bound desktop profile contract without changing its
-- HQ-first default. 4K is available only when a caller explicitly requests it.

alter table public.hivra_remote_desktop_sessions
  drop constraint if exists hivra_remote_desktop_sessions_streaming_mode_check;

alter table public.hivra_remote_desktop_sessions
  add constraint hivra_remote_desktop_sessions_streaming_mode_check
  check (streaming_mode in ('hq','qhd','uhd','performance'));

do $$
declare
  v_function regprocedure := 'public.issue_hivra_remote_desktop_session_v2(text,uuid,text,uuid,text,text,text,text,text,timestamptz,timestamptz,timestamptz,text)'::regprocedure;
  v_definition text;
  v_old text := 'p_streaming_mode not in (''hq'',''performance'')';
  v_new text := 'p_streaming_mode not in (''hq'',''qhd'',''uhd'',''performance'')';
begin
  select pg_get_functiondef(v_function) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'desktop_streaming_mode_validator_not_found';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$$;
