-- Fix the token odometer checkpoint timestamp.
--
-- roll_token_anchor() originally stamped the checkpoint at the hour boundary
-- (date_trunc('hour', now())), but the rollup that creates it runs at :50 — so
-- the client playback window [curr_at, curr_at + span] = [H:00, H+1:00] expired
-- ~50 min before the next checkpoint landed (at H+1:50), freezing the counter.
-- Stamp it at the real creation time (now()) so the window aligns with the
-- ~hourly rollup cadence and the next checkpoint always lands as the current
-- playback finishes (seamless hand-off, no freeze, no hourly jump).
create or replace function public.roll_token_anchor()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total bigint := coalesce((select sum(tokens_total) from public.platform_stats_daily), 0);
begin
  update public.platform_geo
  set
    tokens_anchor_prev = tokens_anchor_curr,
    tokens_anchor_prev_at = tokens_anchor_curr_at,
    tokens_anchor_curr = v_total,
    tokens_anchor_curr_at = now()
  where id = 1
    and (tokens_anchor_curr_at is null
         or date_trunc('hour', tokens_anchor_curr_at) < date_trunc('hour', now()));
end;
$$;
revoke all on function public.roll_token_anchor() from public;
revoke all on function public.roll_token_anchor() from anon, authenticated;
grant execute on function public.roll_token_anchor() to service_role;
