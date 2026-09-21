-- Baseline credit + trigger helper functions, plus a stub public.instances
-- table used by an early policy migration.
--
-- Several objects referenced by 20260330140000_deep_supabase_security_fixes.sql
-- were originally created via the Supabase Dashboard SQL Editor before the
-- project adopted migration files as the source of truth. They are not defined
-- in any earlier migration. The next migration in the timeline issues
-- `ALTER FUNCTION ... SET search_path = ''` and `DROP/CREATE POLICY ON
-- public.instances` against those objects, and therefore fails on a fresh
-- database where they have never existed.
--
-- This migration backfills:
--   * Five SQL helpers (add_credits/deduct_credits/reset_credits + two
--     updated_at triggers) exactly as they appear in production today.
--   * A stub `public.instances` table (only `id` + `user_id`) so the policy
--     migration's DROP/CREATE POLICY statements succeed. Production already
--     has whatever historical `public.instances` it had; on fresh databases
--     the table is created empty here and stays unused. No application code
--     reads or writes it — the project uses `public.hermes_instances`.
--
-- On databases that already have these objects (e.g. production) every
-- statement here is a no-op via CREATE OR REPLACE / CREATE TABLE IF NOT EXISTS.
-- When the codebase next iterates on credit logic, the canonical place to
-- update these definitions is in this migration's successors via additional
-- CREATE OR REPLACE statements, not by editing this file.

SET check_function_bodies = false;

-- Stub `public.instances` so 20260330140000_deep_supabase_security_fixes.sql
-- can safely DROP/CREATE its policy. Minimum columns the policy needs.
CREATE TABLE IF NOT EXISTS "public"."instances" (
  "id" "uuid" PRIMARY KEY DEFAULT "gen_random_uuid"(),
  "user_id" "uuid"
);
ALTER TABLE "public"."instances" ENABLE ROW LEVEL SECURITY;

-- Stub `public.scheduled_tasks` and `public.task_history` so
-- 20260331002200_scheduled_tasks_profile.sql can ADD COLUMN safely.
-- The project ultimately uses `public.hermes_scheduled_tasks` and the
-- accompanying schema; these stubs sit unused on fresh databases.
CREATE TABLE IF NOT EXISTS "public"."scheduled_tasks" (
  "id" "uuid" PRIMARY KEY DEFAULT "gen_random_uuid"()
);
CREATE TABLE IF NOT EXISTS "public"."task_history" (
  "id" "uuid" PRIMARY KEY DEFAULT "gen_random_uuid"()
);

-- Stub `public.profiles` so 20260331203943_add_avatar_url_to_profiles.sql can
-- ADD COLUMN safely on fresh databases, and so the defensive DO block in
-- 20260420162000_harden_public_table_policies.sql (which runs only IF the
-- table exists) finds the user_id column it expects. The project ultimately
-- stores user avatars elsewhere; this stub sits unused.
CREATE TABLE IF NOT EXISTS "public"."profiles" (
  "id" "uuid" PRIMARY KEY DEFAULT "gen_random_uuid"(),
  "user_id" "text"
);

CREATE OR REPLACE FUNCTION "public"."add_credits"("p_user_id" "text", "p_amount" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- Upsert user balance with atomic increment
  insert into user_balances (user_id, balance_cents, total_topped_up_cents, created_at, updated_at)
  values (p_user_id, p_amount, p_amount, now(), now())
  on conflict (user_id)
  do update set
    balance_cents = user_balances.balance_cents + p_amount,
    total_topped_up_cents = user_balances.total_topped_up_cents + p_amount,
    updated_at = now();
end;
$$;

CREATE OR REPLACE FUNCTION "public"."add_credits"("p_user_id" "text", "p_amount" numeric) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  insert into user_balances (user_id, balance_cents, total_topped_up_cents, created_at, updated_at)
  values (p_user_id, p_amount, p_amount, now(), now())
  on conflict (user_id)
  do update set
    balance_cents = user_balances.balance_cents + p_amount,
    total_topped_up_cents = user_balances.total_topped_up_cents + p_amount,
    updated_at = now();
end;
$$;

CREATE OR REPLACE FUNCTION "public"."deduct_credits"("p_user_id" "text", "p_amount_cents" numeric, "p_provider" "text", "p_model" "text", "p_input_tokens" integer, "p_output_tokens" integer, "p_instance_id" "text" DEFAULT NULL::"text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_new_balance numeric;
  v_auto_reload_enabled boolean;
  v_reload_threshold integer;
  v_reload_amount integer;
begin
  -- 1. Atomic deduction with overdraft prevention
  update user_balances
  set
    balance_cents = balance_cents - p_amount_cents,
    total_spent_cents = coalesce(total_spent_cents, 0) + p_amount_cents
  where user_id = p_user_id
    and balance_cents >= p_amount_cents
  returning
    balance_cents,
    auto_reload_enabled,
    auto_reload_threshold_cents,
    auto_reload_amount_cents
  into
    v_new_balance,
    v_auto_reload_enabled,
    v_reload_threshold,
    v_reload_amount;

  if not found then
    return false;
  end if;

  -- 2. Record transaction
  insert into usage_transactions (
    user_id, type, amount_cents, provider, model,
    input_tokens, output_tokens, instance_id
  ) values (
    p_user_id, 'usage', -p_amount_cents, p_provider, p_model,
    p_input_tokens, p_output_tokens, p_instance_id
  );

  -- 3. Auto-Reload trigger
  if v_auto_reload_enabled
     and v_new_balance <= v_reload_threshold
     and v_reload_amount > 0 then
    insert into auto_reload_queue (user_id, amount_cents)
    select p_user_id, v_reload_amount
    where not exists (
      select 1 from auto_reload_queue
      where user_id = p_user_id
      and status IN ('pending', 'processing')
    );
  end if;

  return true;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."reset_credits"("p_user_id" "text", "p_amount" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
    UPDATE public.user_balances
    SET balance_cents = p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."reset_credits"("p_user_id" "uuid", "p_amount" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
    UPDATE public.user_balances
    SET balance_cents = p_amount,
        updated_at = NOW()
    WHERE user_id = p_user_id::text;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."update_user_api_keys_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."update_user_balances_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

