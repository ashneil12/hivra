export const FIXTURE_SQL = `
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.token_tier_qualifications(
      user_id text, tier text, token_key text, currently_eligible boolean,
      last_suspend_at timestamptz, last_breach_at timestamptz
    );
    create table public.hermes_subscriptions(user_id text, plan text, status text, instance_limit integer, grace_period_ends_at timestamptz);
    create table public.apple_iap_subscriptions(user_id text, status text);
    create table public.yearly_token_subscriptions(user_id text, status text);
    create table public.workspace_cloud_subscriptions(user_id text primary key, plan text, status text, instance_limit integer, total_cpu_budget numeric, total_ram_budget integer, stripe_customer_id text, stripe_subscription_id text, current_period_end timestamptz, created_at timestamptz, updated_at timestamptz);
    create table public.hivra_agents(
      id uuid default gen_random_uuid(), operation_kind text, operation_id uuid, operation_started_at timestamptz,
      operation_payload jsonb, desired_state text, error text, cpu_max numeric, ram_max integer, user_id text, deployment_mode text, status text, cpu numeric, ram integer, proxmox_host text, vmid integer, sleep_state text, seat_funding text
    );
    create table public.hermes_instances(
      id uuid default gen_random_uuid(), user_id text, status text, lifecycle_state text, cpu_limit numeric, ram_limit integer, proxmox_node text, disk_size_gb integer, seat_funding text, resource_tier text, updated_at timestamptz, tier_change_pending boolean default false,
      deleted_at timestamptz, archive_uri text, scheduled_deletion_at timestamptz, entitlement_state text,
      created_at timestamptz, last_activity_at timestamptz, last_agent_activity_at timestamptz,
      last_lifecycle_transition_at timestamptz, host_id text, proxmox_vmid int, config jsonb,
      paused_reason text, lifecycle_substate text, gateway_url text, ipv4_address text, infrastructure_provider text,
      product_surface text default 'hermesos'
    );
    create table public.hermes_computer_moves(instance_id uuid, state text);
    create table public.channel_connections(target_kind text, target_id text);
    create function public.token_tier_row_counts_for_user(text, text, timestamptz)
      returns boolean language sql stable as $$ select true $$;
    create function public.lock_hivra_owner_agent_slots(p_owner text)
      returns void language sql volatile as $$ select pg_advisory_xact_lock(hashtextextended('hivra-agent-slots-v1:' || p_owner, 0)) $$;
    create function public.hivra_owner_agent_slot_count(p_owner text)
      returns integer language sql stable as $$ select 0 $$;
    create table public.proxmox_hosts(
      id text primary key, total_cpu integer, total_ram_mb integer,
      reserved_cpu integer default 2, reserved_ram_mb integer default 4096,
      wake_headroom_ram_mb integer default 8192, cpu_overcommit_ratio numeric,
      status text default 'active', sleep_mode text default 'on', decommissioned_at timestamptz, placement_skip_deep_sleep boolean default false,
      thinpool_size_gb integer, thinpool_overcommit_ratio numeric default 1.5,
      capacity_reading jsonb, capacity_reading_at timestamptz
    );
  `;
