-- Whole-provider-VM desktop floor, independent of managed pool slices.
-- Check quote admission and the first dispatch boundary, never strand the
-- observation/cleanup of a request whose provider POST already happened.
create function public.guard_hivra_provider_desktop_resize_floor()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype;
begin
  if tg_op='UPDATE' then
    if not ((old.status='quoted' and new.status='dispatch_pending')
      or (old.provider_post_attempted_at is null and new.provider_post_attempted_at is not null)) then return new; end if;
  end if;
  select * into a from public.hivra_agents where id=new.agent_id and user_id=new.user_id;
  if found and a.type='linux-desktop' then
    if a.computer_profile is distinct from 'ubuntu-desktop'
      or coalesce((new.quote_snapshot#>>'{target,cores}')::numeric,0)<2
      or coalesce((new.quote_snapshot#>>'{target,memoryGb}')::numeric,0)<6 then
      raise exception 'Provider desktop requires original Ubuntu profile and host headroom' using errcode='55006';
    end if;
  end if;
  return new;
end;
$$;
create trigger hivra_provider_desktop_resize_floor_guard before insert or update on public.hivra_provider_resize_operations
  for each row execute function public.guard_hivra_provider_desktop_resize_floor();
revoke all on function public.guard_hivra_provider_desktop_resize_floor() from public,anon,authenticated;
grant execute on function public.guard_hivra_provider_desktop_resize_floor() to service_role;
