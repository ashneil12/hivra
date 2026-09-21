import path from "path";
import * as dotenv from "dotenv";
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

import {
  ACCOUNT_DELETION_EMAIL_TABLES,
  ACCOUNT_DELETION_TABLES,
  assertClerkDeletionPolicy,
  assertConfirmedAccountDeletion,
  buildDeletionTableSummary,
  extractStorageObjectPath,
  isMissingOptionalAccountDeletionTableError,
  requireClerkSecretKey,
  resolveOpsSecretEnvPath,
  type AccountDeletionTable,
  type AccountDeletionTableCount,
} from "../src/lib/ops/account-deletion";
import {
  deleteProxmoxInstance,
  getProxmoxHostRoutingConfigFromInfrastructure,
  getReleasedProxmoxInfrastructure,
  isProxmoxBackedInstanceRow,
  isProxmoxReleaseSafeForDbOnlyDelete,
  resolveProxmoxLifecycleTarget,
} from "../src/lib/services/proxmox-instance-service";
import { deleteHetznerServer } from "../src/lib/services/hetzner-instance-service";
import { recoverProxmoxInstanceAcrossFleet } from "../src/lib/recovery/recover-orphan-provisioning";

dotenv.config({ path: resolveOpsSecretEnvPath(), override: true, quiet: true });
dotenv.config({ path: path.resolve(__dirname, "../.env.local"), quiet: true });

type SupabaseAdmin = ReturnType<typeof createClient>;

interface Args {
  userId: string;
  email: string | null;
  apply: boolean;
  confirmUserId: string | null;
  skipStripe: boolean;
  skipClerk: boolean;
  /** Required when --skip-clerk is combined with --apply. Acknowledges the
   *  resulting orphan-account risk in writing so we don't silently destroy
   *  a live user's instances while leaving them able to log back in. */
  acceptOrphanRisk: boolean;
}

interface InstanceRow {
  id: string;
  user_id: string;
  name: string | null;
  status: string | null;
  lifecycle_state: string | null;
  hetzner_server_id: number | null;
  host_id: string | null;
  config: unknown;
  infrastructure_provider: "hetzner" | "proxmox" | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  ipv4_address: string | null;
  gateway_url: string | null;
  subdomain: string | null;
}

interface ProfileRow {
  avatar_url: string | null;
}

interface SubscriptionRow {
  stripe_customer_id: string | null;
}

interface SupabaseUpdateBuilder {
  update(values: Record<string, unknown>): {
    eq(column: string, value: string): Promise<{ error: { message: string } | null }>;
  };
}

function parseArgs(argv = process.argv.slice(2)): Args {
  const valueAfter = (flag: string): string | null => {
    const index = argv.indexOf(flag);
    if (index < 0) return null;
    return argv[index + 1] || null;
  };

  const userId = valueAfter("--user") || valueAfter("--user-id");
  if (!userId) {
    throw new Error(
      "Usage: npm run ops:delete-user-account -- --user <clerk_user_id> [--email <email>] [--dry-run|--apply --confirm-delete-user-id <same_id>] [--skip-clerk --accept-orphan-risk]"
    );
  }

  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  if (apply && dryRun) throw new Error("Choose only one of --dry-run or --apply.");

  return {
    userId,
    email: valueAfter("--email"),
    apply,
    confirmUserId: valueAfter("--confirm-delete-user-id"),
    skipStripe: argv.includes("--skip-stripe"),
    skipClerk: argv.includes("--skip-clerk"),
    acceptOrphanRisk: argv.includes("--accept-orphan-risk"),
  };
}

function readSupabaseProjectRef(): string | null {
  try {
    return readFileSync(path.resolve(__dirname, "../supabase/.temp/project-ref"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Add it to ${resolveOpsSecretEnvPath()} or export it in the shell.`
    );
  }
  return value;
}

function resolveSupabaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  if (configured) return configured;

  const projectRef = readSupabaseProjectRef();
  if (projectRef) return `https://${projectRef}.supabase.co`;

  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL and no linked Supabase project ref was found.");
}

function createSupabaseAdmin(): SupabaseAdmin {
  return createClient(resolveSupabaseUrl(), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

function createStripeOrNull(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim() || process.env.STRIPE_TEST_SECRET_KEY?.trim();
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2026-03-25.dahlia" });
}

function isDeletedInstance(row: InstanceRow): boolean {
  return row.status === "deleted" || row.lifecycle_state === "deleted";
}

async function loadInstances(supabase: SupabaseAdmin, userId: string): Promise<InstanceRow[]> {
  const { data, error } = await supabase
    .from("hermes_instances")
    .select(
      "id, user_id, name, status, lifecycle_state, hetzner_server_id, host_id, config, infrastructure_provider, proxmox_node, proxmox_vmid, ipv4_address, gateway_url, subdomain",
    )
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to load instances for deletion: ${error.message}`);
  return (data || []) as InstanceRow[];
}

async function loadStripeCustomerIds(
  supabase: SupabaseAdmin,
  stripe: Stripe | null,
  userId: string,
  email: string | null
): Promise<string[]> {
  const ids = new Set<string>();

  const { data, error } = await supabase
    .from("hermes_subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", userId);
  if (error) throw new Error(`Failed to load Stripe customer ids from Supabase: ${error.message}`);

  for (const row of (data || []) as SubscriptionRow[]) {
    if (row.stripe_customer_id) ids.add(row.stripe_customer_id);
  }

  if (stripe) {
    const escapedUserId = userId.replace(/'/g, "\\'");
    const byMetadata = await stripe.customers.search({
      query: `metadata['clerk_user_id']:'${escapedUserId}'`,
      limit: 10,
    });
    for (const customer of byMetadata.data) ids.add(customer.id);

    if (email) {
      const byEmail = await stripe.customers.list({ email, limit: 10 });
      for (const customer of byEmail.data) ids.add(customer.id);
    }
  }

  return Array.from(ids);
}

async function countRows(
  supabase: SupabaseAdmin,
  spec: AccountDeletionTable,
  value: string | string[] | null
): Promise<AccountDeletionTableCount | null> {
  if (!value || (Array.isArray(value) && value.length === 0)) return null;

  let query = supabase
    .from(spec.table)
    .select("*", { count: "exact", head: true });

  query = Array.isArray(value)
    ? query.in(spec.filterColumn, value)
    : query.eq(spec.filterColumn, value);

  const { count, error } = await query;
  if (error) {
    if (isMissingOptionalAccountDeletionTableError(spec, error)) {
      console.warn(`[delete-user] optional legacy table ${spec.table} is absent during count; skipping`);
      return null;
    }
    throw new Error(`Failed to count ${spec.table}.${spec.filterColumn}: ${error.message}`);
  }

  return {
    table: spec.table,
    filterColumn: spec.filterColumn,
    count: count ?? 0,
  };
}

async function collectDeletionCounts(
  supabase: SupabaseAdmin,
  userId: string,
  email: string | null,
  instanceIds: string[]
): Promise<AccountDeletionTableCount[]> {
  const counts: AccountDeletionTableCount[] = [];
  for (const spec of [...ACCOUNT_DELETION_TABLES, ...ACCOUNT_DELETION_EMAIL_TABLES]) {
    const value =
      spec.source === "userId" ? userId :
      spec.source === "email" ? email :
      instanceIds;
    const row = await countRows(supabase, spec, value);
    if (row && row.count > 0) counts.push(row);
  }
  return counts;
}

async function deleteRows(
  supabase: SupabaseAdmin,
  spec: AccountDeletionTable,
  value: string | string[] | null
): Promise<number> {
  if (!value || (Array.isArray(value) && value.length === 0)) return 0;

  let query = supabase
    .from(spec.table)
    .delete({ count: "exact" });

  query = Array.isArray(value)
    ? query.in(spec.filterColumn, value)
    : query.eq(spec.filterColumn, value);

  const { count, error } = await query;
  if (error) {
    if (isMissingOptionalAccountDeletionTableError(spec, error)) {
      console.warn(`[delete-user] optional legacy table ${spec.table} is absent during delete; skipping`);
      return 0;
    }
    throw new Error(
      `Failed to delete ${spec.table}.${spec.filterColumn}: ${error.message}. ` +
      `Reason in deletion plan: ${spec.reason}`
    );
  }
  return count ?? 0;
}

async function collectStoragePaths(
  supabase: SupabaseAdmin,
  userId: string
): Promise<{ bucket: string; paths: string[] }[]> {
  const out: { bucket: string; paths: string[] }[] = [];

  const migrationPrefix = `migrations/${userId}`;
  const migrationList = await supabase.storage
    .from("hermes-attachments")
    .list(migrationPrefix, { limit: 1000 });
  if (migrationList.error) {
    throw new Error(`Failed to list migration uploads: ${migrationList.error.message}`);
  }
  const migrationPaths = (migrationList.data || [])
    .filter((entry) => entry.name)
    .map((entry) => `${migrationPrefix}/${entry.name}`);
  if (migrationPaths.length) out.push({ bucket: "hermes-attachments", paths: migrationPaths });

  const { data: profiles, error: profileError } = await supabase
    .from("profiles")
    .select("avatar_url")
    .eq("user_id", userId);
  if (profileError) throw new Error(`Failed to load profile avatars: ${profileError.message}`);

  const avatarPaths = Array.from(
    new Set(
      ((profiles || []) as ProfileRow[])
        .map((row) => extractStorageObjectPath(row.avatar_url, "avatars"))
        .filter((value): value is string => Boolean(value))
    )
  );
  if (avatarPaths.length) out.push({ bucket: "avatars", paths: avatarPaths });

  return out;
}

async function removeStoragePaths(
  supabase: SupabaseAdmin,
  batches: { bucket: string; paths: string[] }[]
): Promise<void> {
  for (const batch of batches) {
    if (batch.paths.length === 0) continue;
    const { error } = await supabase.storage.from(batch.bucket).remove(batch.paths);
    if (error) throw new Error(`Failed to remove ${batch.bucket} objects: ${error.message}`);
    console.log(`[delete-user] removed ${batch.paths.length} object(s) from ${batch.bucket}`);
  }
}

async function markInstanceDeleted(supabase: SupabaseAdmin, instanceId: string): Promise<void> {
  const now = new Date().toISOString();
  const hermesInstances = supabase.from("hermes_instances") as unknown as SupabaseUpdateBuilder;
  const { error } = await hermesInstances
    .update({
      status: "deleted",
      lifecycle_state: "deleted",
      proxmox_vmid: null,
      deleted_at: now,
      last_lifecycle_transition_at: now,
      updated_at: now,
    })
    .eq("id", instanceId);

  if (error) throw new Error(`Provider teardown succeeded, but failed to mark instance deleted: ${error.message}`);
}

async function teardownInstanceProviders(supabase: SupabaseAdmin, instances: InstanceRow[]): Promise<void> {
  for (const instance of instances) {
    // Resolver looks at config.infrastructure first, then DB columns. The
    // column fallback catches legacy rows that would otherwise silently fall
    // through to the no-provider branch and leave the VM running.
    const proxmoxInfra = resolveProxmoxLifecycleTarget(instance);
    const proxmoxBacked = isProxmoxBackedInstanceRow(instance);
    const proxmoxReleased = getReleasedProxmoxInfrastructure(instance.config);
    const releaseSafeForDbOnlyDelete =
      isProxmoxReleaseSafeForDbOnlyDelete(proxmoxReleased);
    if (proxmoxBacked && !proxmoxInfra && !releaseSafeForDbOnlyDelete) {
      throw new Error(
        `instance ${instance.id} is Proxmox-backed but has no authoritative teardown receipt; refusing to delete`,
      );
    }
    if (proxmoxBacked && !proxmoxInfra && releaseSafeForDbOnlyDelete) {
      console.log(
        `[delete-user] instance ${instance.id} proxmox handle previously released (${proxmoxReleased?.reason ?? "unknown"}); no provider teardown needed`,
      );
    }
    if (proxmoxInfra) {
      const hostConfig = getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfra, {
        host_id: instance.host_id ?? null,
      });
      const result = await deleteProxmoxInstance(proxmoxInfra, {
        hostConfig,
        expectedInstanceId: instance.id,
      });
      const vmMissingOnRoutedHost = (result.stdout || "")
        .split(/\r?\n/)
        .some((line) => /^HERMES_PROXMOX_DELETE_VM_MISSING \d+$/.test(line.trim()));
      if (vmMissingOnRoutedHost) {
        const recovery = await recoverProxmoxInstanceAcrossFleet({
          ...instance,
          config:
            instance.config && typeof instance.config === "object" && !Array.isArray(instance.config)
              ? (instance.config as Record<string, unknown>)
              : null,
        });
        if (recovery.status !== "gone") {
          throw new Error(
            recovery.status === "recovered"
              ? `Proxmox VM for ${instance.id} was found on another host and routing was repaired; rerun account deletion to teardown the recovered VM`
              : `Proxmox VM for ${instance.id} could not be verified absent across the fleet; account rows were preserved`,
          );
        }
      }
      if (!result.ok) {
        const removalConfirmed =
          (result.stdout || "").includes("HERMES_PROXMOX_DELETE_VM_DESTROYED") ||
          (result.stdout || "").includes("HERMES_PROXMOX_DELETE_VM_MISSING_AFTER_DESTROY") ||
          vmMissingOnRoutedHost;
        if (!removalConfirmed) {
          throw new Error(
            `Proxmox deletion failed for instance ${instance.id}; DB rows were not deleted. ` +
            `Failure: ${result.error || result.stderr || "unknown Proxmox error"}`
          );
        }
        console.log(`[delete-user] Proxmox VM for ${instance.id} was authoritatively confirmed gone; continuing`);
      } else {
        console.log(`[delete-user] deleted Proxmox VM for instance ${instance.id}`);
      }
    } else if (instance.hetzner_server_id) {
      try {
        await deleteHetznerServer(instance.hetzner_server_id);
        console.log(`[delete-user] deleted Hetzner server ${instance.hetzner_server_id} for instance ${instance.id}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("→ 404")) {
          throw new Error(
            `Hetzner deletion failed for server ${instance.hetzner_server_id}; DB rows were not deleted. ` +
            `Failure: ${message}`
          );
        }
        console.log(`[delete-user] Hetzner server ${instance.hetzner_server_id} was already gone; continuing`);
      }
    } else {
      console.log(`[delete-user] instance ${instance.id} has no provider id; marking deleted before row removal`);
    }

    await markInstanceDeleted(supabase, instance.id);
  }
}

async function deleteOwnedHostsWhenUnshared(
  supabase: SupabaseAdmin,
  userId: string,
  instances: InstanceRow[]
): Promise<void> {
  const hostIds = Array.from(new Set(instances.map((row) => row.host_id).filter((value): value is string => Boolean(value))));
  for (const hostId of hostIds) {
    const { count, error: countError } = await supabase
      .from("hermes_instances")
      .select("id", { count: "exact", head: true })
      .eq("host_id", hostId)
      .neq("user_id", userId)
      .neq("status", "deleted");
    if (countError) throw new Error(`Failed to check shared host ${hostId}: ${countError.message}`);

    if ((count ?? 0) > 0) {
      console.warn(`[delete-user] host ${hostId} is still used by other live instances; leaving host row intact`);
      continue;
    }

    const { error: deleteError } = await supabase
      .from("hermes_hosts")
      .delete()
      .eq("id", hostId)
      .eq("user_id", userId);
    if (deleteError) throw new Error(`Failed to delete host ${hostId}: ${deleteError.message}`);
    console.log(`[delete-user] deleted unshared host ${hostId}`);
  }
}

async function deleteStripeCustomers(stripe: Stripe | null, customerIds: string[]): Promise<void> {
  if (!stripe) {
    if (customerIds.length > 0) {
      console.warn("[delete-user] Stripe customer ids exist but STRIPE_SECRET_KEY is missing; Stripe deletion skipped");
    }
    return;
  }

  for (const customerId of customerIds) {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    });
    for (const subscription of subscriptions.data) {
      if (subscription.status !== "canceled") {
        await stripe.subscriptions.cancel(subscription.id);
        console.log(`[delete-user] canceled Stripe subscription ${subscription.id}`);
      }
    }

    try {
      await stripe.customers.del(customerId);
      console.log(`[delete-user] deleted Stripe customer ${customerId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/No such customer/i.test(message)) throw error;
      console.log(`[delete-user] Stripe customer ${customerId} was already gone`);
    }
  }
}

async function deleteClerkUser(userId: string): Promise<void> {
  // Hard-fail when CLERK_SECRET_KEY is missing: deleting providers + DB
  // while Clerk silently no-ops leaves the user able to log back in to a
  // half-destroyed account (Fixture Customer A / Fixture Customer B incident, 2026-05-07). Run with
  // `--skip-clerk --accept-orphan-risk` if that outcome is genuinely
  // intended — main() guards that combination separately.
  const clerkSecretKey = requireClerkSecretKey();

  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${clerkSecretKey}` },
  });
  if (response.ok || response.status === 404) {
    console.log(response.status === 404 ? "[delete-user] Clerk user already missing" : "[delete-user] deleted Clerk user");
    return;
  }

  const body = await response.text();
  throw new Error(`Clerk deletion failed: ${response.status} ${response.statusText} ${body.slice(0, 500)}`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(`[delete-user] ${mode} for ${args.userId}`);

  // Skipping Clerk while applying provider/DB teardown leaves the user able
  // to log back in to a half-destroyed account (Fixture Customer A/Fixture Customer B, 2026-05-07).
  // assertClerkDeletionPolicy throws unless --accept-orphan-risk is also set.
  assertClerkDeletionPolicy({
    apply: args.apply,
    skipClerk: args.skipClerk,
    acceptOrphanRisk: args.acceptOrphanRisk,
  });

  if (args.apply) {
    assertConfirmedAccountDeletion({
      userId: args.userId,
      confirmationUserId: args.confirmUserId,
    });
  }

  const supabase = createSupabaseAdmin();
  const stripe = args.skipStripe ? null : createStripeOrNull();

  const instances = await loadInstances(supabase, args.userId);
  const instanceIds = instances.map((row) => row.id);
  const stripeCustomerIds = args.skipStripe
    ? []
    : await loadStripeCustomerIds(supabase, stripe, args.userId, args.email);
  const storageBatches = await collectStoragePaths(supabase, args.userId);
  const counts = await collectDeletionCounts(supabase, args.userId, args.email, instanceIds);

  console.log(`[delete-user] instances found: ${instances.length} (${instances.filter((row) => !isDeletedInstance(row)).length} active/non-deleted)`);
  console.log(`[delete-user] Stripe customers found: ${stripeCustomerIds.length ? stripeCustomerIds.join(", ") : "none"}`);
  console.log(`[delete-user] storage objects found: ${storageBatches.reduce((total, batch) => total + batch.paths.length, 0)}`);
  console.log(`[delete-user] DB row summary: ${buildDeletionTableSummary(counts)}`);

  if (!args.apply) {
    console.log("[delete-user] Dry run only. Re-run with --apply --confirm-delete-user-id <same id> to delete.");
    return;
  }

  // Order matters: revoke login FIRST, then destroy resources. If Clerk
  // deletion fails (network / API error / missing CLERK_SECRET_KEY) we
  // bail out before touching any VMs, which preserves the option to retry
  // cleanly. The previous order (providers → ... → Clerk last) caused the
  // Fixture Customer A/Fixture Customer B incident where instances were destroyed but the Clerk user
  // remained, leaving a confused user unable to find their agent.
  if (!args.skipClerk) {
    await deleteClerkUser(args.userId);
  } else {
    console.warn(
      "[delete-user] Clerk deletion skipped by flag (--skip-clerk --accept-orphan-risk). User will retain their login."
    );
  }

  await teardownInstanceProviders(supabase, instances);
  await deleteStripeCustomers(stripe, stripeCustomerIds);
  await removeStoragePaths(supabase, storageBatches);

  const deletedCounts: AccountDeletionTableCount[] = [];
  for (const spec of [...ACCOUNT_DELETION_TABLES, ...ACCOUNT_DELETION_EMAIL_TABLES]) {
    const value =
      spec.source === "userId" ? args.userId :
      spec.source === "email" ? args.email :
      instanceIds;
    const count = await deleteRows(supabase, spec, value);
    if (count > 0) {
      deletedCounts.push({ table: spec.table, filterColumn: spec.filterColumn, count });
      console.log(`[delete-user] deleted ${count} row(s) from ${spec.table}`);
    }
  }

  await deleteOwnedHostsWhenUnshared(supabase, args.userId, instances);

  console.log(`[delete-user] completed. Deleted rows: ${buildDeletionTableSummary(deletedCounts)}`);
}

main().catch((error) => {
  console.error(`[delete-user] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
