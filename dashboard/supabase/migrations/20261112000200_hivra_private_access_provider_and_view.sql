-- Remember which private network a Hivra computer joined and what the computer
-- itself reported about it at the last check, so a page reload shows the same
-- thing as the check did. Purely additive: nullable columns, no change to any
-- function, grant, policy or existing row. No secrets are stored here.
--
-- The service role already holds select/update on this table
-- (20260915153000_hivra_private_access.sql); the dashboard writes these columns
-- after a successful connect or refresh, and reads them back with a fallback to
-- the original columns where this migration has not been applied.

alter table public.hivra_private_access_connections
  add column if not exists provider text
    check (provider is null or provider in ('tailscale','headscale','netbird')),
  add column if not exists can_see_other_devices boolean,
  add column if not exists visible_peer_count integer
    check (visible_peer_count is null or visible_peer_count between 0 and 100000),
  add column if not exists tagged_hivra boolean,
  add column if not exists block_present boolean,
  add column if not exists client_version text
    check (client_version is null or char_length(client_version) between 1 and 40);
