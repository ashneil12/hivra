-- The project does not use Supabase GraphQL.
-- Disabling the extension removes an unnecessary exposed API surface.

DROP EXTENSION IF EXISTS pg_graphql;
