// Apply every migration in dashboard/supabase/migrations, in order, to an
// in-memory PostgreSQL (PGlite). The Supabase-provided roles, schemas and the
// pgcrypto digest() used by migrations are stubbed; everything else comes from
// the unmodified migration files. No credentials and no live database.
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");

const SUPABASE_STUBS = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create role supabase_admin; create role authenticator;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  create schema auth; create schema storage; create schema supabase_migrations; create schema extensions;
  create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create function auth.role() returns text language sql stable as $$ select null::text $$;
  create table auth.users (id uuid primary key, email text);
  create table storage.buckets (id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[], owner uuid, created_at timestamptz default now(), updated_at timestamptz default now());
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
    name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
  create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
  create publication supabase_realtime;
  create function public.digest(text, text) returns bytea language sql as $$ select sha256(convert_to($1, 'UTF8')) $$;
  create function public.digest(bytea, text) returns bytea language sql as $$ select sha256($1) $$;
`;

function migrationFiles(through) {
  const files = fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  if (!through) return files;
  if (!files.includes(through)) throw new Error(`Unknown migration ${through}`);
  return files.filter((name) => name <= through);
}

function readMigration(name) {
  // PGlite ships without extensions; the functions they provide are stubbed above.
  return fs.readFileSync(path.join(MIGRATIONS, name), "utf8").replace(/create extension[^;]*;/gi, "");
}

/**
 * Open a database with every migration up to and including `through` applied.
 * `skip` names migrations to leave out (for a test that applies them itself).
 */
async function openMigratedDatabase({ through, skip = [] } = {}) {
  const db = new PGlite();
  try {
    await db.exec(SUPABASE_STUBS);
    for (const name of migrationFiles(through)) {
      if (skip.includes(name)) continue;
      try { await db.exec(readMigration(name)); } catch (error) { throw new Error(`${name}: ${error.message}`); }
    }
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

module.exports = { openMigratedDatabase, readMigration, migrationFiles, MIGRATIONS };
