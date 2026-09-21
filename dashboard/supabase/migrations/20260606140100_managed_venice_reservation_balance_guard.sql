-- Atomic balance guard for managed-Venice reservations.
--
-- createManagedVeniceReservation (src/lib/billing/managed-venice-wallets.ts) does
-- a check-then-act: it reads the wallet summary, checks available >= amount, then
-- inserts the reservation. Two concurrent requests for the same user can both
-- pass the application-level check and both insert, over-reserving past the
-- available balance (overdraft). This BEFORE INSERT trigger makes the check
-- atomic with the insert.
--
-- A per-user transaction advisory lock serializes concurrent reservation/debit
-- inserts for a user, so a second insert blocks until the first commits and then
-- sees the first reservation in the sums. The available math mirrors
-- getManagedVeniceWalletSummary exactly (active token lots minus active hermesos
-- reservations; card ledger sum minus active card reservations). The
-- application-level check stays as a fast fail-early path; this is the backstop
-- that closes the race.
--
-- Idempotency: a row whose reference_id already exists is a retry/ON-CONFLICT
-- update, not a new reservation, so it is exempt from the balance check.
--
-- Rerun-safe: create-or-replace + drop/recreate trigger.

create or replace function public.enforce_managed_venice_reservation_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available bigint;
begin
  -- Only newly-created active reservations consume balance.
  if new.status is distinct from 'active' then
    return new;
  end if;

  -- Same reference_id already present => this is an idempotent retry whose
  -- INSERT will be turned into an ON CONFLICT DO UPDATE. It reserves nothing
  -- new, so skip the balance check (otherwise a racing retry could be wrongly
  -- rejected once the original reservation is counted).
  if exists (
    select 1 from public.managed_venice_reservations
    where reference_id = new.reference_id
  ) then
    return new;
  end if;

  -- Serialize concurrent reserve/debit for this user.
  perform pg_advisory_xact_lock(hashtext('managed_venice_wallet:' || new.user_id));

  if new.wallet_type = 'hermesos' then
    v_available :=
      coalesce((select sum(remaining_value_micro_usd) from public.managed_venice_token_lots
                where user_id = new.user_id and status = 'active'), 0)
      - coalesce((select sum(reserved_micro_usd) from public.managed_venice_reservations
                  where user_id = new.user_id and status = 'active' and wallet_type = 'hermesos'), 0);
  else
    v_available :=
      coalesce((select sum(amount_micro_usd) from public.managed_venice_card_ledger_entries
                where user_id = new.user_id), 0)
      - coalesce((select sum(reserved_micro_usd) from public.managed_venice_reservations
                  where user_id = new.user_id and status = 'active' and wallet_type = 'card'), 0);
  end if;

  -- NEW row is not yet counted (BEFORE INSERT), so the existing available must
  -- cover it.
  if v_available < new.reserved_micro_usd then
    raise exception 'managed_venice_insufficient_balance: available=% requested=%',
      v_available, new.reserved_micro_usd
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_mv_reservation_balance on public.managed_venice_reservations;
create trigger trg_enforce_mv_reservation_balance
  before insert on public.managed_venice_reservations
  for each row
  execute function public.enforce_managed_venice_reservation_balance();

-- Defense-in-depth for the card wallet: debitCardWallet also does a
-- check-then-act (read summary, then insert a negative ledger entry), so two
-- concurrent debits could both pass and drive the card balance negative. A card
-- balance physically can't go below zero, so enforce that invariant atomically
-- on every debit. This can never reject a valid capture (which only debits what
-- was credited), and the per-user advisory lock serializes concurrent debits.
create or replace function public.enforce_managed_venice_card_balance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sum bigint;
begin
  -- Only debits (negative entries) can drive the balance negative.
  if new.amount_micro_usd >= 0 then
    return new;
  end if;

  -- Idempotent duplicate: let the unique (source, reference_id, reason)
  -- constraint handle it rather than balance-rejecting.
  if exists (
    select 1 from public.managed_venice_card_ledger_entries
    where source = new.source and reference_id = new.reference_id and reason = new.reason
  ) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('managed_venice_wallet:' || new.user_id));

  v_sum := coalesce((select sum(amount_micro_usd)
                     from public.managed_venice_card_ledger_entries
                     where user_id = new.user_id), 0);

  if v_sum + new.amount_micro_usd < 0 then
    raise exception 'managed_venice_insufficient_balance: card_balance=% debit=%',
      v_sum, new.amount_micro_usd
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_mv_card_balance on public.managed_venice_card_ledger_entries;
create trigger trg_enforce_mv_card_balance
  before insert on public.managed_venice_card_ledger_entries
  for each row
  execute function public.enforce_managed_venice_card_balance();
