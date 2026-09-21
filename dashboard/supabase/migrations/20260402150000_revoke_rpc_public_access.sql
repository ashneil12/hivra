-- Database Security: Lock down all public RPC functions
-- By default, PostgreSQL grants EXECUTE on new functions to PUBLIC.
-- This mitigates the risk by revoking execution from 'public' and 'anon',
-- leaving it explicitly available only to 'service_role'.

DO $$ 
DECLARE 
    func_record RECORD;
BEGIN 
    -- Loop through all functions in the 'public' schema
    FOR func_record IN 
        SELECT p.oid::regprocedure AS func_signature 
        FROM pg_proc p 
        JOIN pg_namespace n ON n.oid = p.pronamespace 
        WHERE n.nspname = 'public'
    LOOP 
        EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || func_record.func_signature || ' FROM public;';
        EXECUTE 'REVOKE EXECUTE ON FUNCTION ' || func_record.func_signature || ' FROM anon;';
        
        -- Grant explicit execute rights to the service role to ensure backend API logic functions correctly
        EXECUTE 'GRANT EXECUTE ON FUNCTION ' || func_record.func_signature || ' TO service_role;';
    END LOOP;
END $$;
