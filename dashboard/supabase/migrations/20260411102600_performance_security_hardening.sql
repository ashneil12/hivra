-- 1. Patch Mutable Search Path in orphaned/vulnerable function
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_proc
        WHERE proname = 'set_updated_at'
          AND pg_function_is_visible(oid)
    ) THEN
        EXECUTE 'ALTER FUNCTION public.set_updated_at() SET search_path = '''''';';
    END IF;
END $$;

-- 2. Drop unused index on user_api_keys
DROP INDEX IF EXISTS public.idx_user_api_keys_user_id;

-- 3. Optimize RLS Initialization Plan
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_class
        JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
        WHERE pg_namespace.nspname = 'public'
          AND pg_class.relname = 'user_vault_profiles'
          AND pg_class.relkind = 'r'
    ) THEN
        DROP POLICY IF EXISTS "users manage own vault profiles" ON public.user_vault_profiles;

        CREATE POLICY "users manage own vault profiles"
            ON public.user_vault_profiles FOR ALL
            TO public
            USING ((SELECT auth.uid())::text = user_id)
            WITH CHECK ((SELECT auth.uid())::text = user_id);
    END IF;
END $$;
