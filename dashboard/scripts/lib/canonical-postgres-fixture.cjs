const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const migration = name => fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations', name), 'utf8');

// Minimal typed legacy tables: actual projection functions/triggers and
// all canonical schema/ACLs come from the unmodified migration files.
const legacySchema = `create role anon; create role authenticated; create role service_role bypassrls;
      create table public.hermes_instances(id uuid primary key,user_id text,name text,status text,
        lifecycle_state text,backend text,agent_type text,host_id uuid,pool_id uuid,product_surface text,
        infrastructure_provider text,proxmox_node text,proxmox_vmid integer,cpu_limit integer,ram_limit integer);
      create table public.hivra_agents(id uuid primary key,user_id text,name text,status text,desired_state text,
        operation_id uuid,operation_kind text,type text,computer_profile text,deployment_mode text,
        computer_substrate text,pool_id uuid,infrastructure_connection_id uuid,infrastructure_connection_revision bigint,
        deployment_target_id uuid,provider_capacity_order_id uuid,provider_server_id text,proxmox_host text,
        vmid integer,cpu integer,ram integer);`;

async function canonicalFixture() {
  const db = new PGlite();
  try {
    await db.exec(legacySchema);
    for (const file of ['20260904100000_hivra_canonical_resource_shadow.sql',
      '20260906150000_hivra_canonical_binding_provenance.sql',
      '20260906160000_hivra_canonical_parity_coverage.sql']) await db.exec(migration(file));
    return db;
  } catch (error) { await db.close(); throw error; }
}

module.exports = { canonicalFixture, migration, legacySchema };
