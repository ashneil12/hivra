-- Repair: a Bankr deposit wallet must never be an account's primary wallet.
--
-- ensureBankrDepositWalletForUser used to default makePrimary to true, and
-- every crypto payment path (credit top-up, yearly $HermesOS quote, managed
-- Venice quote, the wallet page) provisioned or re-used the account's Bankr
-- deposit wallet that way: it cleared is_primary on all of the account's EVM
-- wallets and promoted the deposit wallet. A deposit wallet can never back
-- token-tier standing (getTokenVerificationWallet ignores it), so the account
-- was left with no verification wallet; the holdings cron stopped re-reading
-- it and its Pro/Power qualification stayed eligible forever.
--
-- The code now provisions deposit wallets with makePrimary: false. This file
-- repairs rows written before that:
--   1. Demote every primary Bankr wallet whose purpose is not hermesos_lock
--      (credit_deposit, yearly_subscription, managed_venice_inference).
--      Grandfathered hermesos_lock wallets and legacy Bankr wallets with no
--      purpose can still back standing, so they are left alone.
--   2. Where that leaves the account without a primary EVM wallet, restore
--      its most recently verified self-custody wallet (signature or admin),
--      the wallet that was primary before the payment displaced it, unless
--      that address is now another account's primary. The holdings cron then
--      re-reads the wallet the tier was earned on, so an honest holder keeps
--      the tier and a holder who sold is breached.
-- An account left with standing and no wallet is judged at a zero balance by
-- the holdings cron.
--
-- Data only; rerun-safe: after the first run step 1 matches nothing.

do $$
declare
  demoted record;
  restore_id uuid;
begin
  for demoted in
    select wallet.id, wallet.user_id, wallet.chain_type
    from public.user_wallets as wallet
    where wallet.is_primary
      and wallet.verification_method = 'bankr'
      and (wallet.metadata -> 'bankr' ->> 'purpose') is not null
      and (wallet.metadata -> 'bankr' ->> 'purpose') <> 'hermesos_lock'
    order by wallet.user_id, wallet.id
    for update
  loop
    update public.user_wallets as wallet
    set is_primary = false,
        metadata = wallet.metadata || jsonb_build_object(
          'primary_repair', jsonb_build_object(
            'reason', 'bankr_deposit_wallet_not_verification_wallet',
            'demoted_at', now()
          )
        )
    where wallet.id = demoted.id;

    select candidate.id
      into restore_id
    from public.user_wallets as candidate
    where candidate.user_id = demoted.user_id
      and candidate.chain_type = demoted.chain_type
      and not candidate.is_primary
      and candidate.verified_at is not null
      and candidate.verification_method in ('signature', 'admin')
      and not exists (
        select 1
        from public.user_wallets as own_primary
        where own_primary.user_id = demoted.user_id
          and own_primary.chain_type = demoted.chain_type
          and own_primary.is_primary
      )
      and not exists (
        select 1
        from public.user_wallets as other_primary
        where other_primary.chain_type = candidate.chain_type
          and other_primary.normalized_address = candidate.normalized_address
          and other_primary.is_primary
          and other_primary.user_id <> candidate.user_id
      )
    order by candidate.verified_at desc, candidate.id desc
    limit 1;

    if restore_id is not null then
      update public.user_wallets as wallet
      set is_primary = true,
          metadata = wallet.metadata || jsonb_build_object(
            'primary_repair', jsonb_build_object(
              'reason', 'restored_after_bankr_deposit_wallet_demotion',
              'displaced_by', demoted.id,
              'restored_at', now()
            )
          )
      where wallet.id = restore_id;
    end if;
  end loop;
end;
$$;
