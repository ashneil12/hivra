-- Venice promo campaigns: capped, Venice-funded credit for the managed Venice
-- CARD wallet (managed_venice_card_ledger_entries). That ledger is what a
-- managed Venice proxy key bound to the "card" wallet spends, so promo money
-- is granted there as a positive entry (source 'promo', reason 'promo_grant')
-- and the unspent part is removed again with a negative entry (reason
-- 'promo_expiry') when the grant expires.
--
-- Everything is off until the owner flips both the campaign row
-- (enabled = true, with starts_at / grant_cutoff_at set) and the server flag
-- HIVRA_VENICE_PROMO_ENABLED.
--
-- Tables
--   venice_promo_campaigns    one row per campaign (kind launch_credit | topup_bonus)
--   venice_promo_grants       one row per user per campaign; money actually granted
--   venice_promo_redemptions  a user's redeemed code / referral attribution, which
--                             is what makes them eligible for a launch credit
--
-- Functions (service role only; each is one transaction)
--   grant_venice_promo         budget / max_grants / per-user cap enforced under a
--                              row lock on the campaign, grant row and wallet
--                              ledger credit written together, idempotent by
--                              reference_id and by (campaign, user)
--   expire_venice_promo_grant  removes only the unspent promo part from the wallet,
--                              never more than the wallet's available balance,
--                              idempotent by grant id
--
-- Class: additive, plus a widened check on the card ledger (source / reason).
-- Rerun-safe: if not exists, create or replace, drop constraint if exists.

-- 1. Let the card ledger carry promo entries. The list also keeps the values
--    the application already writes for reconciliation refunds.
alter table public.managed_venice_card_ledger_entries
  drop constraint if exists managed_venice_card_ledger_entries_source_check;
alter table public.managed_venice_card_ledger_entries
  add constraint managed_venice_card_ledger_entries_source_check
  check (source in ('stripe', 'admin', 'refund', 'system', 'reconciliation', 'promo'));

alter table public.managed_venice_card_ledger_entries
  drop constraint if exists managed_venice_card_ledger_entries_reason_check;
alter table public.managed_venice_card_ledger_entries
  add constraint managed_venice_card_ledger_entries_reason_check
  check (reason in (
    'stripe_topup',
    'admin_adjustment',
    'refund',
    'managed_venice_debit',
    'overcharge_refund',
    'promo_grant',
    'promo_expiry'
  ));

-- 2. Campaigns.
create table if not exists public.venice_promo_campaigns (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (btrim(slug) <> ''),
  kind text not null check (kind in ('launch_credit', 'topup_bonus')),
  code text,
  enabled boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  grant_cutoff_at timestamptz,
  budget_micro_usd bigint not null check (budget_micro_usd >= 0),
  per_user_cap_micro_usd bigint not null check (per_user_cap_micro_usd > 0),
  bonus_bps integer check (bonus_bps is null or (bonus_bps > 0 and bonus_bps <= 10000)),
  max_grants integer not null check (max_grants >= 0),
  grant_expiry_days integer not null default 30 check (grant_expiry_days > 0),
  created_at timestamptz not null default timezone('utc'::text, now()),
  check (kind <> 'topup_bonus' or bonus_bps is not null)
);

create unique index if not exists venice_promo_campaigns_code_idx
  on public.venice_promo_campaigns (lower(code))
  where code is not null;

comment on table public.venice_promo_campaigns is
  'Venice-funded promo campaigns. A campaign grants nothing until enabled = true, starts_at is set and grant_cutoff_at (or ends_at) is set; the server flag HIVRA_VENICE_PROMO_ENABLED must also be true.';

-- 3. Grants.
create table if not exists public.venice_promo_grants (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.venice_promo_campaigns(id),
  user_id text not null check (btrim(user_id) <> ''),
  amount_micro_usd bigint not null check (amount_micro_usd > 0),
  spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0),
  granted_at timestamptz not null default timezone('utc'::text, now()),
  expires_at timestamptz not null,
  expired_micro_usd bigint not null default 0 check (expired_micro_usd >= 0),
  status text not null default 'active' check (status in ('active', 'spent', 'expired')),
  eligibility_reason text not null check (btrim(eligibility_reason) <> ''),
  reference_id text not null unique check (btrim(reference_id) <> ''),
  unique (campaign_id, user_id)
);

create index if not exists venice_promo_grants_active_expiry_idx
  on public.venice_promo_grants (expires_at)
  where status = 'active';

create index if not exists venice_promo_grants_user_idx
  on public.venice_promo_grants (user_id);

comment on column public.venice_promo_grants.spent_micro_usd is
  'Set when the grant closes (expiry run): the part of the grant spent, taken as card spend since granted_at, capped at the amount. For an active grant the spent part is computed on read.';

-- 4. Redemptions: the code / referral signal that makes a user eligible.
create table if not exists public.venice_promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.venice_promo_campaigns(id),
  user_id text not null check (btrim(user_id) <> ''),
  source text not null check (source in ('code', 'ref')),
  code text,
  redeemed_at timestamptz not null default timezone('utc'::text, now()),
  unique (campaign_id, user_id)
);

create index if not exists venice_promo_redemptions_user_idx
  on public.venice_promo_redemptions (user_id);

-- 5. Access: service role only. Users read their promo lines through the API.
alter table public.venice_promo_campaigns enable row level security;
alter table public.venice_promo_grants enable row level security;
alter table public.venice_promo_redemptions enable row level security;

revoke all on public.venice_promo_campaigns from anon, authenticated;
revoke all on public.venice_promo_grants from anon, authenticated;
revoke all on public.venice_promo_redemptions from anon, authenticated;

drop policy if exists "service role full access venice_promo_campaigns" on public.venice_promo_campaigns;
create policy "service role full access venice_promo_campaigns"
  on public.venice_promo_campaigns for all to service_role using (true) with check (true);

drop policy if exists "service role full access venice_promo_grants" on public.venice_promo_grants;
create policy "service role full access venice_promo_grants"
  on public.venice_promo_grants for all to service_role using (true) with check (true);

drop policy if exists "service role full access venice_promo_redemptions" on public.venice_promo_redemptions;
create policy "service role full access venice_promo_redemptions"
  on public.venice_promo_redemptions for all to service_role using (true) with check (true);

-- 6. Grant: one transaction. The campaign row is locked first, so concurrent
--    grants for a campaign run one after another and each sees the others'
--    totals: the budget and max_grants can never be exceeded.
create or replace function public.grant_venice_promo(
  p_campaign_id uuid,
  p_user_id text,
  p_amount_micro_usd bigint,
  p_reference_id text,
  p_eligibility_reason text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.venice_promo_campaigns%rowtype;
  v_existing public.venice_promo_grants%rowtype;
  v_cutoff timestamptz;
  v_amount bigint;
  v_count integer;
  v_sum bigint;
  v_account_id uuid;
  v_grant_id uuid;
  v_expires_at timestamptz;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'venice_promo_invalid: user id is required' using errcode = '22023';
  end if;
  if p_reference_id is null or btrim(p_reference_id) = '' then
    raise exception 'venice_promo_invalid: reference id is required' using errcode = '22023';
  end if;
  if p_eligibility_reason is null or btrim(p_eligibility_reason) = '' then
    raise exception 'venice_promo_invalid: eligibility reason is required' using errcode = '22023';
  end if;
  if p_amount_micro_usd is null or p_amount_micro_usd <= 0 then
    raise exception 'venice_promo_invalid: amount must be a positive number of micro-USD'
      using errcode = '22023';
  end if;

  select * into v_campaign from public.venice_promo_campaigns where id = p_campaign_id for update;
  if not found then
    return jsonb_build_object('granted', false, 'status', 'campaign_not_found');
  end if;

  -- A replay of a grant already made (same reference): report it, change nothing.
  select * into v_existing from public.venice_promo_grants where reference_id = p_reference_id;
  if found then
    if v_existing.user_id <> p_user_id or v_existing.campaign_id <> p_campaign_id then
      raise exception 'venice_promo_invalid: reference id belongs to another grant' using errcode = '22023';
    end if;
    return jsonb_build_object(
      'granted', false, 'status', 'already_granted',
      'grantId', v_existing.id, 'amountMicroUsd', v_existing.amount_micro_usd,
      'expiresAt', v_existing.expires_at
    );
  end if;

  select * into v_existing
    from public.venice_promo_grants
   where campaign_id = p_campaign_id and user_id = p_user_id;
  if found then
    return jsonb_build_object(
      'granted', false, 'status', 'already_granted',
      'grantId', v_existing.id, 'amountMicroUsd', v_existing.amount_micro_usd,
      'expiresAt', v_existing.expires_at
    );
  end if;

  if not v_campaign.enabled then
    return jsonb_build_object('granted', false, 'status', 'disabled');
  end if;
  if v_campaign.starts_at is null or p_now < v_campaign.starts_at then
    return jsonb_build_object('granted', false, 'status', 'not_started');
  end if;
  v_cutoff := coalesce(v_campaign.grant_cutoff_at, v_campaign.ends_at);
  if v_cutoff is null
     or p_now > v_cutoff
     or (v_campaign.ends_at is not null and p_now > v_campaign.ends_at) then
    return jsonb_build_object('granted', false, 'status', 'ended');
  end if;

  v_amount := least(p_amount_micro_usd, v_campaign.per_user_cap_micro_usd);

  select count(*), coalesce(sum(amount_micro_usd), 0)
    into v_count, v_sum
    from public.venice_promo_grants
   where campaign_id = p_campaign_id;

  if v_count >= v_campaign.max_grants then
    return jsonb_build_object('granted', false, 'status', 'max_grants_reached');
  end if;
  if v_sum + v_amount > v_campaign.budget_micro_usd then
    return jsonb_build_object('granted', false, 'status', 'budget_exhausted');
  end if;

  insert into public.managed_venice_wallet_accounts (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;
  select id into v_account_id from public.managed_venice_wallet_accounts where user_id = p_user_id;

  v_expires_at := p_now + make_interval(days => v_campaign.grant_expiry_days);

  insert into public.venice_promo_grants
    (campaign_id, user_id, amount_micro_usd, granted_at, expires_at, eligibility_reason, reference_id)
  values
    (p_campaign_id, p_user_id, v_amount, p_now, v_expires_at, p_eligibility_reason, p_reference_id)
  returning id into v_grant_id;

  insert into public.managed_venice_card_ledger_entries
    (account_id, user_id, amount_micro_usd, source, actor, reason, reference_id, metadata)
  values
    (v_account_id, p_user_id, v_amount, 'promo', 'venice_promo', 'promo_grant', p_reference_id,
     jsonb_build_object('campaignId', p_campaign_id, 'campaignSlug', v_campaign.slug,
                        'grantId', v_grant_id, 'expiresAt', v_expires_at));

  return jsonb_build_object(
    'granted', true, 'status', 'granted',
    'grantId', v_grant_id, 'amountMicroUsd', v_amount, 'expiresAt', v_expires_at
  );
end;
$$;

-- 7. Expiry: remove only the unspent promo part from the wallet.
--      spent   = card spend (managed_venice_debit entries) since granted_at,
--                taken as consuming the promo money first
--      unspent = max(0, amount - spent)
--      removed = min(unspent, wallet available balance), never negative
--    The wallet lock is the one the balance guards take, so a debit cannot slip
--    in between the balance read and the removal.
create or replace function public.expire_venice_promo_grant(
  p_grant_id uuid,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant public.venice_promo_grants%rowtype;
  v_spent bigint;
  v_unspent bigint;
  v_available bigint;
  v_remove bigint;
  v_account_id uuid;
begin
  select * into v_grant from public.venice_promo_grants where id = p_grant_id for update;
  if not found then
    return jsonb_build_object('expired', false, 'status', 'grant_not_found');
  end if;
  if v_grant.status <> 'active' then
    return jsonb_build_object('expired', false, 'status', 'already_closed', 'grantStatus', v_grant.status);
  end if;
  if v_grant.expires_at > p_now then
    return jsonb_build_object('expired', false, 'status', 'not_due');
  end if;

  perform pg_advisory_xact_lock(hashtext('managed_venice_wallet:' || v_grant.user_id));

  select coalesce(-sum(amount_micro_usd), 0) into v_spent
    from public.managed_venice_card_ledger_entries
   where user_id = v_grant.user_id
     and reason = 'managed_venice_debit'
     and amount_micro_usd < 0
     and created_at >= v_grant.granted_at;
  v_spent := least(greatest(v_spent, 0), v_grant.amount_micro_usd);
  v_unspent := v_grant.amount_micro_usd - v_spent;

  v_available :=
    coalesce((select sum(amount_micro_usd) from public.managed_venice_card_ledger_entries
              where user_id = v_grant.user_id), 0)
    - coalesce((select sum(reserved_micro_usd) from public.managed_venice_reservations
                where user_id = v_grant.user_id and status = 'active' and wallet_type = 'card'), 0);

  v_remove := least(v_unspent, greatest(v_available, 0));

  if v_remove > 0 then
    select id into v_account_id from public.managed_venice_wallet_accounts where user_id = v_grant.user_id;
    insert into public.managed_venice_card_ledger_entries
      (account_id, user_id, amount_micro_usd, source, actor, reason, reference_id, metadata)
    values
      (v_account_id, v_grant.user_id, -v_remove, 'promo', 'venice_promo', 'promo_expiry',
       'promo_expiry:' || v_grant.id::text,
       jsonb_build_object('grantId', v_grant.id, 'campaignId', v_grant.campaign_id,
                          'grantedMicroUsd', v_grant.amount_micro_usd,
                          'spentMicroUsd', v_spent, 'unspentMicroUsd', v_unspent))
    on conflict (source, reference_id, reason) do nothing;
  end if;

  update public.venice_promo_grants
     set status = case when v_unspent = 0 then 'spent' else 'expired' end,
         spent_micro_usd = v_spent,
         expired_micro_usd = v_remove
   where id = v_grant.id;

  return jsonb_build_object(
    'expired', true,
    'status', case when v_unspent = 0 then 'spent' else 'expired' end,
    'grantId', v_grant.id,
    'spentMicroUsd', v_spent,
    'unspentMicroUsd', v_unspent,
    'removedMicroUsd', v_remove
  );
end;
$$;

revoke all on function public.grant_venice_promo(uuid, text, bigint, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.grant_venice_promo(uuid, text, bigint, text, text, timestamptz)
  to service_role;
comment on function public.grant_venice_promo(uuid, text, bigint, text, text, timestamptz) is
  'Grants promo money to the managed Venice card wallet under a row lock on the campaign, so budget_micro_usd and max_grants cannot be exceeded. Idempotent by reference_id and by (campaign, user). Service role only.';

revoke all on function public.expire_venice_promo_grant(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.expire_venice_promo_grant(uuid, timestamptz)
  to service_role;
comment on function public.expire_venice_promo_grant(uuid, timestamptz) is
  'Closes a due promo grant and removes only its unspent part from the card wallet (never more than the available balance). Idempotent by grant id. Service role only.';

-- 8. Report helpers (read-only). Aggregated in SQL so the weekly report is not
--    cut off by the API's row limit.
--    venice_promo_grant_stats: one object per grant with
--      spentMicroUsd   closed grant: the recorded spent part; active grant: card
--                      spend (managed_venice_debit entries) since granted_at, capped
--      active7/active30  null while the grant is younger than 7/30 days, else
--                      whether the user had a recorded managed Venice request at or
--                      after granted_at + 7/30 days (and not after p_now)
--      toppedUpAfter   a paid card top-up (stripe_topup) after granted_at
create or replace function public.venice_promo_grant_stats(p_now timestamptz default now())
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'grantId', g.id,
    'campaignId', g.campaign_id,
    'userId', g.user_id,
    'amountMicroUsd', g.amount_micro_usd,
    'status', g.status,
    'grantedAt', g.granted_at,
    'expiresAt', g.expires_at,
    'expiredMicroUsd', g.expired_micro_usd,
    'spentMicroUsd', case when g.status = 'active' then least(g.amount_micro_usd, coalesce((
        select -sum(l.amount_micro_usd) from public.managed_venice_card_ledger_entries l
         where l.user_id = g.user_id and l.reason = 'managed_venice_debit'
           and l.amount_micro_usd < 0 and l.created_at >= g.granted_at), 0))
      else g.spent_micro_usd end,
    'active7', case when p_now >= g.granted_at + interval '7 days' then exists (
        select 1 from public.managed_venice_usage_events u
         where u.user_id = g.user_id and u.status = 'recorded'
           and u.created_at >= g.granted_at + interval '7 days' and u.created_at <= p_now) else null end,
    'active30', case when p_now >= g.granted_at + interval '30 days' then exists (
        select 1 from public.managed_venice_usage_events u
         where u.user_id = g.user_id and u.status = 'recorded'
           and u.created_at >= g.granted_at + interval '30 days' and u.created_at <= p_now) else null end,
    'toppedUpAfter', exists (
        select 1 from public.managed_venice_card_ledger_entries l
         where l.user_id = g.user_id and l.reason = 'stripe_topup' and l.created_at > g.granted_at)
  ) order by g.granted_at), '[]'::jsonb)
  from public.venice_promo_grants g;
$$;

--    venice_promo_window_stats: managed Venice spend by model in [p_from, p_to)
--    (all users, and the promo users' share) and the users who launched an agent
--    in credits mode (hivra_agents.llm_config.mode = 'managed') in the window.
create or replace function public.venice_promo_window_stats(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'modelSpend', coalesce((
      select jsonb_agg(jsonb_build_object(
        'model', m.model,
        'requests', m.requests,
        'chargedMicroUsd', m.charged,
        'veniceCostMicroUsd', m.cost,
        'promoUserRequests', m.promo_requests,
        'promoUserChargedMicroUsd', m.promo_charged
      ) order by m.charged desc, m.model)
      from (
        select u.model,
               count(*) as requests,
               coalesce(sum(u.charged_micro_usd), 0) as charged,
               coalesce(sum(u.actual_cost_micro_usd), 0) as cost,
               count(*) filter (where pu.user_id is not null) as promo_requests,
               coalesce(sum(u.charged_micro_usd) filter (where pu.user_id is not null), 0) as promo_charged
          from public.managed_venice_usage_events u
          left join (select distinct user_id from public.venice_promo_grants) pu on pu.user_id = u.user_id
         where u.status = 'recorded' and u.created_at >= p_from and u.created_at < p_to
         group by u.model
      ) m), '[]'::jsonb),
    'creditsModeLaunchUsers', (
      select count(distinct user_id) from public.hivra_agents
       where created_at >= p_from and created_at < p_to and llm_config->>'mode' = 'managed'),
    'creditsModeLaunches', (
      select count(*) from public.hivra_agents
       where created_at >= p_from and created_at < p_to and llm_config->>'mode' = 'managed')
  );
$$;

revoke all on function public.venice_promo_grant_stats(timestamptz) from public, anon, authenticated;
grant execute on function public.venice_promo_grant_stats(timestamptz) to service_role;
revoke all on function public.venice_promo_window_stats(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.venice_promo_window_stats(timestamptz, timestamptz) to service_role;

-- 9. Seed the two campaigns, disabled and without dates, so nothing runs
--    until the owner sets them and turns them on.
insert into public.venice_promo_campaigns
  (slug, kind, code, enabled, budget_micro_usd, per_user_cap_micro_usd, bonus_bps, max_grants, grant_expiry_days)
values
  ('venice-launch-2026', 'launch_credit', 'VENICE', false, 700000000, 10000000, null, 70, 30),
  ('venice-topup-2026', 'topup_bonus', null, false, 200000000, 10000000, 5000, 20, 30)
on conflict (slug) do nothing;
