-- Credit-deposit USDC treasury sweep: make settled top-up receipts sweepable
-- and give the sweep a claim-before-transfer state machine.
--
-- Before this migration the sweep (src/lib/billing/credit-deposit-sweep.ts)
-- could never run: receipts keep the default sweep_status 'not_required', the
-- sweep only selected 'pending'/'failed', it wrote a status ('swept') the check
-- constraint rejects, and it wrote columns this table does not have.
--
-- 1. A trigger marks every settled checkout/open_credit Base-USDC receipt
--    'pending', whichever code path settles it, and a backfill does the same
--    for receipts settled already. Only 'not_required' is ever changed, so a
--    sweep in flight, finished or held for review is never re-queued. To hold
--    a receipt out of the sweep, set it 'skipped', not 'not_required'.
-- 2. Additive columns carry one sweep attempt's claim and its evidence:
--      sweep_attempts               claim counter; every transition after a
--                                   claim compares against it
--      sweep_attempted_at           when the current attempt claimed the row
--      sweep_claim_block            Base head at claim time; the on-chain
--                                   search for an unconfirmed transfer starts
--                                   here
--      sweep_destination_address    treasury the attempt sends to
--      sweep_transfer_requested_at  set immediately before Bankr is asked to
--                                   transfer. A claim without it provably
--                                   moved nothing and may be released
--      sweep_submitted_at           when the sweep tx hash was recorded
--      sweep_confirmed_at           when the transfer was confirmed on chain
--      sweep_error                  last failure or reason for review
-- 3. Constraints: 'confirmed' requires the tx hash, 'submitted' requires its
--    claim data, and one sweep tx can be recorded against only one receipt.
--
-- Additive and rerun-safe. The backfill changes sweep_status on existing
-- settled USDC top-up receipts; once the sweep code is deployed, the cron moves
-- their USDC to the treasury.

alter table public.crypto_deposit_receipts
  add column if not exists sweep_attempts integer not null default 0,
  add column if not exists sweep_attempted_at timestamptz,
  add column if not exists sweep_claim_block bigint,
  add column if not exists sweep_destination_address text,
  add column if not exists sweep_transfer_requested_at timestamptz,
  add column if not exists sweep_submitted_at timestamptz,
  add column if not exists sweep_confirmed_at timestamptz,
  add column if not exists sweep_error text;

alter table public.crypto_deposit_receipts
  drop constraint if exists crypto_deposit_receipts_sweep_attempts_check;
alter table public.crypto_deposit_receipts
  add constraint crypto_deposit_receipts_sweep_attempts_check
  check (sweep_attempts >= 0);

alter table public.crypto_deposit_receipts
  drop constraint if exists crypto_deposit_receipts_sweep_confirmed_check;
alter table public.crypto_deposit_receipts
  add constraint crypto_deposit_receipts_sweep_confirmed_check
  check (sweep_status <> 'confirmed' or sweep_tx_hash is not null);

alter table public.crypto_deposit_receipts
  drop constraint if exists crypto_deposit_receipts_sweep_claim_check;
alter table public.crypto_deposit_receipts
  add constraint crypto_deposit_receipts_sweep_claim_check
  check (
    sweep_status <> 'submitted'
    or (
      sweep_attempts > 0
      and sweep_attempted_at is not null
      and sweep_claim_block is not null
      and sweep_destination_address is not null
    )
  );

create unique index if not exists crypto_deposit_receipts_sweep_tx_hash_key
  on public.crypto_deposit_receipts (lower(sweep_tx_hash))
  where sweep_tx_hash is not null;

create or replace function public.crypto_deposit_receipts_require_sweep()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'settled'
     and new.sweep_status = 'not_required'
     and new.deposit_mode in ('checkout', 'open_credit')
     and new.chain_id = 8453
     and lower(new.token_address) = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  then
    new.sweep_status := 'pending';
  end if;
  return new;
end;
$$;

revoke all on function public.crypto_deposit_receipts_require_sweep() from public, anon, authenticated;

drop trigger if exists crypto_deposit_receipts_require_sweep on public.crypto_deposit_receipts;
create trigger crypto_deposit_receipts_require_sweep
  before insert or update on public.crypto_deposit_receipts
  for each row execute function public.crypto_deposit_receipts_require_sweep();

update public.crypto_deposit_receipts
   set sweep_status = 'pending'
 where status = 'settled'
   and sweep_status = 'not_required'
   and deposit_mode in ('checkout', 'open_credit')
   and chain_id = 8453
   and lower(token_address) = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
