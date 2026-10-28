import "server-only";

import { createHash } from "node:crypto";

import { mapWithConcurrencyLimit } from "@/lib/concurrency";
import {
  isSafeManagedProvisionerTargetId,
  managedProvisionerBundleManifestFile,
  probeManagedProvisionerBundle,
  syncManagedProvisionerBundle,
  type ManagedProvisionerBundleProbe,
  type ManagedProvisionerBundleSyncResult,
} from "@/lib/hivra/managed-provisioner-bundle-sync";
import {
  persistedManagedHivraProvisionerChannel,
  type ManagedHivraProvisionerChannel,
} from "@/lib/hivra/managed-provisioner-channel";
import { resolveHivraClaudeCodeProxmoxHost, resolveHivraProxmoxHost } from "@/lib/hivra/proxmox-target";
import { loadPortableProvisionerBundle } from "@/lib/infrastructure/connection-preparation";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "@/lib/infrastructure/portable-provisioner-contract";
import type { supabaseAdmin } from "@/lib/supabase";

/** Hosts probed over SSH at once. */
const PROBE_CONCURRENCY = 4;

/**
 * Keeps each managed Proxmox host's provisioner bundle for THIS deployment's
 * channel at the version this deployment ships, so an owner's "Update
 * connection service" (which requires exactly PORTABLE_HIVRA_PROVISIONER_VERSION
 * on the host) does not 503 after every provisioner release until an operator
 * syncs each host by hand.
 *
 * What it will and will not do:
 * - Hosts considered: every host that holds a live managed computer on this
 *   channel, every active placement host, and the explicit Claude Code launch
 *   host. Nothing else, and only hosts with their own configuration (the sync
 *   library refuses the rest before any SSH).
 * - It only upgrades a provisioner directory that already exists. Preparing a
 *   host for the first time stays an operator step (proxmox-host-standup).
 * - It never replaces a bundle that claims a newer version than this
 *   deployment ships: a rolled-back or stale deployment must not downgrade a
 *   shared host.
 * - At most one successful sync per run, two attempts at most, so one broken
 *   host costs one attempt per run and cannot starve the others.
 * - The sync itself is the operator route's syncManagedProvisionerBundle: host
 *   identity proof, allocation lock, checksum-verified atomic swap, rollback,
 *   readiness check and the VM/Caddy/storage preservation receipt.
 *
 * OFF unless HIVRA_MANAGED_BUNDLE_SYNC_ENABLED=true. Off means no database read
 * and no SSH at all. A dry run (probe only, never sync) works either way.
 */
export const MANAGED_BUNDLE_SYNC_ENABLED_ENV = "HIVRA_MANAGED_BUNDLE_SYNC_ENABLED";
export const MAX_BUNDLE_SYNCS_PER_RUN = 1;
export const MAX_BUNDLE_SYNC_ATTEMPTS_PER_RUN = 2;

type Supabase = NonNullable<typeof supabaseAdmin>;

export type ManagedBundleHostStatus =
  | "current"
  | "synced"
  | "stale"
  | "sync_failed"
  | "newer_on_host"
  | "not_prepared"
  | "unreachable"
  | "unconfigured";

export type ManagedBundleHostReport = {
  targetId: string;
  liveComputers: number;
  placementHost: boolean;
  status: ManagedBundleHostStatus;
  observedVersion: string | null;
  error?: string;
  preservation?: ManagedProvisionerBundleSyncResult["preservation"];
};

export type ManagedBundleConvergenceSummary = {
  enabled: boolean;
  dryRun: boolean;
  channel: ManagedHivraProvisionerChannel;
  requestedVersion: string;
  hosts: ManagedBundleHostReport[];
  synced: string[];
  /** Behind, but left for a later run by the per-run bound (or by dry run). */
  pending: string[];
};

type Dependencies = {
  loadBundle: typeof loadPortableProvisionerBundle;
  probe: typeof probeManagedProvisionerBundle;
  sync: typeof syncManagedProvisionerBundle;
};

const DEFAULT_DEPENDENCIES: Dependencies = {
  loadBundle: loadPortableProvisionerBundle,
  probe: probeManagedProvisionerBundle,
  sync: syncManagedProvisionerBundle,
};

const AGENT_PAGE_SIZE = 1000;

export function managedBundleSyncEnabled(env: Record<string, string | undefined>): boolean {
  return env[MANAGED_BUNDLE_SYNC_ENABLED_ENV]?.trim().toLowerCase() === "true";
}

/** Provisioner versions are dotted integers (2026.10.07.1). null when either
 * side is not one, so an unknown host version is never mistaken for newer. */
export function compareProvisionerVersions(left: string, right: string): number | null {
  const parse = (value: string) => (/^\d+(\.\d+)*$/.test(value) ? value.split(".").map(Number) : null);
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function normalizeHostId(value: string | null | undefined): string | null {
  const id = value?.trim().toLowerCase();
  return id && isSafeManagedProvisionerTargetId(id) ? id : null;
}

async function loadLiveComputersByHost(
  supabase: Supabase,
  channel: ManagedHivraProvisionerChannel,
  env: Record<string, string | undefined>,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let from = 0; ; from += AGENT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("hivra_agents")
      .select("id, proxmox_host, managed_provisioner_channel")
      .eq("deployment_mode", "hivra-managed")
      .neq("status", "deleted")
      .order("id", { ascending: true })
      .range(from, from + AGENT_PAGE_SIZE - 1);
    if (error) throw new Error(`hivra_agents host read failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ proxmox_host: string | null; managed_provisioner_channel: unknown }>;
    for (const row of rows) {
      // Same rule the execution context applies: null is the historical
      // default lane, anything unknown is not ours to serve.
      if (persistedManagedHivraProvisionerChannel(row.managed_provisioner_channel) !== channel) continue;
      const host = normalizeHostId(resolveHivraProxmoxHost(row.proxmox_host, env));
      if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    if (rows.length < AGENT_PAGE_SIZE) return counts;
  }
}

async function loadPlacementHosts(
  supabase: Supabase,
  env: Record<string, string | undefined>,
): Promise<Set<string>> {
  const { data, error } = await supabase.from("proxmox_hosts").select("id, status");
  if (error) throw new Error(`proxmox_hosts read failed: ${error.message}`);
  const hosts = new Set<string>();
  for (const row of (data ?? []) as Array<{ id: string; status: string }>) {
    const id = row.status === "active" ? normalizeHostId(row.id) : null;
    if (id) hosts.add(id);
  }
  const claudeHost = normalizeHostId(resolveHivraClaudeCodeProxmoxHost(env));
  if (claudeHost) hosts.add(claudeHost);
  return hosts;
}

function classify(probe: ManagedProvisionerBundleProbe): {
  status: ManagedBundleHostStatus;
  observedVersion: string | null;
  error?: string;
} {
  switch (probe.kind) {
    case "unconfigured":
      return { status: "unconfigured", observedVersion: null, error: probe.error };
    case "unreachable":
      return { status: "unreachable", observedVersion: null, error: probe.error };
    case "missing":
      return { status: "not_prepared", observedVersion: null };
    case "present": {
      if (
        probe.observedVersion === PORTABLE_HIVRA_PROVISIONER_VERSION &&
        probe.manifestMatches &&
        probe.intact
      ) {
        return { status: "current", observedVersion: probe.observedVersion };
      }
      const order = probe.observedVersion
        ? compareProvisionerVersions(probe.observedVersion, PORTABLE_HIVRA_PROVISIONER_VERSION)
        : null;
      if (order !== null && order > 0) {
        return {
          status: "newer_on_host",
          observedVersion: probe.observedVersion,
          error: "Host carries a newer provisioner than this deployment ships; left unchanged.",
        };
      }
      return { status: "stale", observedVersion: probe.observedVersion };
    }
  }
}

export async function runManagedProvisionerBundleConvergence(params: {
  supabase: Supabase | null;
  env: Record<string, string | undefined>;
  channel: ManagedHivraProvisionerChannel;
  dryRun?: boolean;
  dependencies?: Partial<Dependencies>;
}): Promise<ManagedBundleConvergenceSummary> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...params.dependencies };
  const enabled = managedBundleSyncEnabled(params.env);
  const dryRun = params.dryRun === true;
  const summary: ManagedBundleConvergenceSummary = {
    enabled,
    dryRun,
    channel: params.channel,
    requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
    hosts: [],
    synced: [],
    pending: [],
  };
  if (!enabled && !dryRun) return summary;
  if (!params.supabase) throw new Error("Database is not configured");

  const [liveComputers, placementHosts, assets] = await Promise.all([
    loadLiveComputersByHost(params.supabase, params.channel, params.env),
    loadPlacementHosts(params.supabase, params.env),
    deps.loadBundle(),
  ]);
  const expectedManifestDigest = createHash("sha256")
    .update(managedProvisionerBundleManifestFile(assets))
    .digest("hex");
  const hostIds = Array.from(new Set([...liveComputers.keys(), ...placementHosts])).sort();

  // Each probe is an SSH call with its own timeout; a few at a time, so a long
  // host list never opens every connection at once.
  const probes = await mapWithConcurrencyLimit(hostIds, PROBE_CONCURRENCY, (targetId) =>
    deps.probe(params.channel, targetId, expectedManifestDigest),
  );
  summary.hosts = hostIds.map((targetId, index) => ({
    targetId,
    liveComputers: liveComputers.get(targetId) ?? 0,
    placementHost: placementHosts.has(targetId),
    ...classify(probes[index]),
  }));

  // The host holding the most computers first: it is where the most owners
  // are blocked. Ties break by id so the order is stable between runs.
  const stale = summary.hosts
    .filter((host) => host.status === "stale")
    .sort((a, b) => b.liveComputers - a.liveComputers || a.targetId.localeCompare(b.targetId));
  let attempts = 0;
  for (const host of stale) {
    if (dryRun || summary.synced.length >= MAX_BUNDLE_SYNCS_PER_RUN || attempts >= MAX_BUNDLE_SYNC_ATTEMPTS_PER_RUN) {
      summary.pending.push(host.targetId);
      continue;
    }
    attempts += 1;
    const result = await deps.sync(params.channel, host.targetId);
    if (result.ok) {
      host.status = "synced";
      host.observedVersion = result.observedVersion;
      host.preservation = result.preservation;
      summary.synced.push(host.targetId);
    } else {
      host.status = "sync_failed";
      host.error = result.error ?? "Bundle sync failed.";
    }
  }
  return summary;
}
