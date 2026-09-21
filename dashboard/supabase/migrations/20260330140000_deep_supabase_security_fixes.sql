-- Deep Supabase Security Fixes
-- This migration hardens the storage policies and fixes search path exploits.

-- 1. Fix Storage IDOR vulnerability
DROP POLICY IF EXISTS "Service role upload" ON storage.objects;
DROP POLICY IF EXISTS "Service role delete" ON storage.objects;
CREATE POLICY "Service role upload"
    ON storage.objects FOR INSERT
    TO service_role
    WITH CHECK (bucket_id = 'blog-images');
CREATE POLICY "Service role delete"
    ON storage.objects FOR DELETE
    TO service_role
    USING (bucket_id = 'blog-images');
-- 2. Patch Mutable Search Path in trigger/definer functions
ALTER FUNCTION public.add_credits(text,integer) SET search_path = '';
ALTER FUNCTION public.add_credits(text,numeric) SET search_path = '';
ALTER FUNCTION public.deduct_credits(text,numeric,text,text,integer,integer,text) SET search_path = '';
ALTER FUNCTION public.reset_credits(text,integer) SET search_path = '';
ALTER FUNCTION public.reset_credits(uuid,integer) SET search_path = '';
ALTER FUNCTION public.update_user_api_keys_updated_at() SET search_path = '';
ALTER FUNCTION public.update_user_balances_updated_at() SET search_path = '';
-- 3. Explicit WITH CHECK on 'instances' policy
DROP POLICY IF EXISTS "users see own instances" ON public.instances;
CREATE POLICY "users see own instances"
    ON public.instances FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
