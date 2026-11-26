do $reconcile$
declare
  duplicate_index oid := to_regclass('public.idx_referral_codes_code');
begin
  if duplicate_index is not null and (
    pg_get_indexdef(duplicate_index) is distinct from
      'CREATE INDEX idx_referral_codes_code ON public.referral_codes USING btree (code)'
    or not exists (
      select 1
      from pg_index i
      join pg_constraint c on c.conindid = i.indexrelid and c.contype = 'u'
      where i.indexrelid = to_regclass('public.referral_codes_code_key')
        and i.indisvalid and i.indisready and i.indimmediate
        and pg_get_indexdef(i.indexrelid) =
          'CREATE UNIQUE INDEX referral_codes_code_key ON public.referral_codes USING btree (code)'
    )
  ) then
    raise exception 'Refusing to remove referral code index without its verified unique twin';
  end if;
end;
$reconcile$;

drop index if exists public.idx_referral_codes_code;

comment on table public.workspace_cloud_handoff_codes is
  'One-time PKCE authorization codes for the Hermes Workspace cloud handoff. '
  'Service role only. Exchanged at /api/workspace-cloud/handoff/exchange for a '
  'connection bundle; rows are single-use (consumed_at) and short-lived '
  '(expires_at).';

comment on table public.workspace_cloud_subscriptions is
  'Per-user billing entitlement for the Hermes Workspace cloud lane. Separate '
  'from hermes_subscriptions to keep the two products'' billing fully '
  'partitioned. Read by resolveWorkspaceCloudEntitlement; written by the '
  'lane Stripe webhook. Service role only.';

comment on table public.instance_usage_snapshots is
  'Per-instance per-UTC-day runtime usage harvested from each agent''s /api/analytics/usage over the SSH guest-hop. Folded into platform_stats_daily. Counts only, service_role only.';
