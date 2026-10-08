-- SYNTHETIC rows for the five tables the chain constrains. Invented values only.
-- Shapes follow what an older build wrote: no operation, provider or
-- attachment columns, and only states that older build produced.

-- hivra_agents: 108 rows across the lifecycle states
insert into public.hivra_agents (user_id, type, name, status, proxmox_host, vmid, ip, chat_url, cpu, ram, error, provisioned_at, api_token, managed_venice)
select
  'user_' || lpad((g % 40)::text, 3, '0'),
  (array['hermes','claude-code','codex'])[1 + g % 3],
  'agent-' || g,
  case when g % 9 = 0 then 'deleted' when g % 7 = 0 then 'stopped' when g % 11 = 0 then 'error' when g % 13 = 0 then 'provisioning' else 'running' end,
  case when g % 4 = 0 then 'local' else 'node-' || (g % 3) end,
  case when g % 9 = 0 or g % 13 = 0 then null else 1000 + g end,
  case when g % 9 = 0 or g % 13 = 0 then null else '10.0.' || (g / 250) || '.' || (g % 250) end,
  case when g % 9 = 0 or g % 13 = 0 then null else 'https://agent-' || g || '.example.invalid' end,
  (array[0.5, 1, 2, 4])[1 + g % 4],
  (array[2, 4, 8, 16])[1 + g % 4],
  case when g % 11 = 0 then 'provision timed out' end,
  case when g % 13 = 0 then null else now() - (g || ' days')::interval end,
  case when g % 9 = 0 or g % 13 = 0 then null else 'tok_' || g end,
  g % 5 = 0
from generate_series(1, 108) as g;

-- crypto_deposit_receipts: settled USDC on Base (the chain flips these to
-- sweep pending), plus detected, ignored and failed receipts
insert into public.crypto_deposit_receipts (user_id, reference_id, chain_id, token_address, token_symbol, token_decimals, deposit_address, normalized_deposit_address, amount_minor, tx_hash, log_index, block_number, status, deposit_mode, sweep_status)
select
  'user_' || lpad((g % 40)::text, 3, '0'),
  'ref-' || g,
  8453,
  '0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913',
  'USDC',
  6,
  '0xdeposit' || lpad(g::text, 32, '0'),
  '0xdeposit' || lpad(g::text, 32, '0'),
  1000000 * (1 + g % 20),
  '0xtx' || lpad(g::text, 60, '0'),
  g % 3,
  1000000 + g,
  (array['settled','settled','settled','detected','ignored','failed'])[1 + g % 6],
  (array['checkout','open_credit'])[1 + g % 2],
  'not_required'
from generate_series(1, 14) as g;

-- yearly_token_quotes: active, expired, one consumed with a transfer hash
insert into public.yearly_token_quotes (id, user_id, tier, usd_target_cents, price_usd_at_quote, tokens_required_raw, tokens_required_display, deposit_address, quoted_at, expires_at, status, consumed_balance_raw, consumed_at, consumed_tx_hash)
values
  ('00000000-0000-4000-8000-000000000001', 'user_001', 'pro', 24000, '0.01', 2400000000000000000000000, '2400000', '0xyearly0000000000000000000000000000000001', now() - interval '40 days', now() - interval '39 days', 'consumed', 2400000000000000000000000, now() - interval '40 days', '0xyearlyconsumed00000000000000000000000000000000000000000000000001'),
  ('00000000-0000-4000-8000-000000000002', 'user_002', 'power', 48000, '0.01', 4800000000000000000000000, '4800000', '0xyearly0000000000000000000000000000000002', now() - interval '60 days', now() - interval '59 days', 'expired', null, null, null),
  ('00000000-0000-4000-8000-000000000003', 'user_003', 'pro', 24000, '0.01', 2400000000000000000000000, '2400000', '0xyearly0000000000000000000000000000000003', now(), now() + interval '1 day', 'active', null, null, null);

-- yearly_token_subscriptions: the one subscription, swept
insert into public.yearly_token_subscriptions (user_id, tier, yearly_quote_id, expires_at, deposit_tx_hash, amount_received_raw, sweep_status, sweep_tx_hash, status, metadata)
values ('user_001', 'pro', '00000000-0000-4000-8000-000000000001', now() + interval '325 days', '0xyearlyconsumed00000000000000000000000000000000000000000000000001', 2400000000000000000000000, 'swept', '0xsweep00000000000000000000000000000000000000000000000000000001', 'active', '{"depositAddress": "0xYEARLY0000000000000000000000000000000001"}');

-- managed_venice_token_quotes: 179 quotes across the lifecycle
insert into public.managed_venice_wallet_accounts (id, user_id)
select ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'user_' || lpad(g::text, 3, '0') from generate_series(0, 39) as g;

insert into public.managed_venice_token_quotes (account_id, user_id, token_amount_raw, snapshot_price_usd, locked_value_micro_usd, deposit_address, quoted_at, expires_at, status, source, transaction_hash, settled_at, sweep_status, sweep_tx_hash, sweep_attempted_at)
select
  ('00000000-0000-4000-9000-' || lpad((g % 40)::text, 12, '0'))::uuid,
  'user_' || lpad((g % 40)::text, 3, '0'),
  1000000000000000000000 * (1 + g % 9),
  '0.0123',
  5000000 * (1 + g % 9),
  '0xvenice' || lpad(g::text, 32, '0'),
  now() - (g || ' hours')::interval,
  now() - (g || ' hours')::interval + interval '30 minutes',
  case when g % 10 = 0 then 'expired' when g % 17 = 0 then 'manual_review_required' else 'settled' end,
  'dexscreener',
  case when g % 10 = 0 or g % 17 = 0 then null else '0xvtx' || lpad(g::text, 60, '0') end,
  case when g % 10 = 0 or g % 17 = 0 then null else now() - (g || ' hours')::interval end,
  case when g % 10 = 0 or g % 17 = 0 then 'skipped' when g % 3 = 0 then 'swept' else 'pending' end,
  case when g % 10 <> 0 and g % 17 <> 0 and g % 3 = 0 then '0xvsweep' || lpad(g::text, 56, '0') end,
  case when g % 10 <> 0 and g % 17 <> 0 and g % 3 = 0 then now() - (g || ' hours')::interval end
from generate_series(1, 179) as g;
