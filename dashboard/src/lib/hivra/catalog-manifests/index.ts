// Universal Catalog App & Agent Registry.
//
// Single lookup and projection layer over UNIVERSAL_CATALOG_MANIFESTS so every
// dashboard surface (agent-catalog, Launch, resource-envelope, wake profiles,
// manage capabilities, agent page, SEO) stays in lockstep without per-app code
// branches.

import type { AgentDef } from "@/lib/hivra/agent-catalog";
import type { AgentWakeProfile } from "@/lib/hivra/agent-profiles/types";
import { isUniversalCatalogEnabled } from "@/lib/hivra/universal-catalog-flag";
import { hasCurrentCatalogCertification } from "./certification";
import {
  buildCatalogAppLaunchSpec,
  CATALOG_APP_PORT_MAX,
  CATALOG_APP_PORT_MIN,
  CATALOG_APP_SLUG_RE,
  CATALOG_OSI_LICENSES,
  CatalogAppManifestSchema,
  type CatalogAppCategory,
  type CatalogAppIconKey,
  type CatalogAppJobId,
  type CatalogAppLaunchSpec,
  type CatalogAppManifest,
  type CatalogAppRuntime,
  type CatalogOsiLicense,
} from "./schema";
import {
  UNIVERSAL_CATALOG_IDS,
  UNIVERSAL_CATALOG_MANIFESTS,
  type UniversalCatalogAppId,
} from "./manifests/index";

export {
  buildCatalogAppLaunchSpec,
  CATALOG_APP_PORT_MAX,
  CATALOG_APP_PORT_MIN,
  CATALOG_APP_SLUG_RE,
  CATALOG_OSI_LICENSES,
  CatalogAppManifestSchema,
  UNIVERSAL_CATALOG_IDS,
  UNIVERSAL_CATALOG_MANIFESTS,
};
export type {
  CatalogAppCategory,
  CatalogAppIconKey,
  CatalogAppJobId,
  CatalogAppLaunchSpec,
  CatalogAppManifest,
  CatalogAppRuntime,
  CatalogOsiLicense,
  UniversalCatalogAppId,
};

const MANIFEST_BY_ID: ReadonlyMap<string, CatalogAppManifest> = new Map(
  UNIVERSAL_CATALOG_MANIFESTS.map((manifest) => [manifest.id, manifest]),
);

export function getCatalogAppManifest(id: unknown): CatalogAppManifest | undefined {
  return typeof id === "string" ? MANIFEST_BY_ID.get(id) : undefined;
}

export function isCatalogAppId(id: unknown): id is UniversalCatalogAppId {
  return typeof id === "string" && MANIFEST_BY_ID.has(id);
}

export function isCatalogAppLaunchable(manifest: CatalogAppManifest, certifier = false): boolean {
  return isUniversalCatalogEnabled() && (certifier || hasCurrentCatalogCertification(manifest));
}

/** True when this catalog app renders its own web UI behind Hivra's token gate. */
export function catalogAppHasWebSurface(manifest: CatalogAppManifest): boolean {
  return manifest.runtime.kind === "docker-web" || manifest.runtime.kind === "docker-stack" || Boolean(manifest.runtime.webService);
}

/** Loopback port the guest app listens on, or null for CLI-only apps. */
export function catalogAppHostPort(manifest: CatalogAppManifest): number | null {
  if (manifest.runtime.kind === "docker-web") return manifest.runtime.hostPort;
  if (manifest.runtime.kind === "docker-stack") return manifest.runtime.web.hostPort;
  return manifest.runtime.webService?.hostPort ?? null;
}

/** Gateway entry path opened in the agent page's DashboardView iframe. */
export const CATALOG_APP_GATEWAY_ENTRY = "/app/";

/** Project a manifest into the canonical AgentDef shape used across Launch,
 * resource-gate, Manage, and the agent page. */
export function catalogAppToAgentDef(
  manifest: CatalogAppManifest,
  enabled = isCatalogAppLaunchable(manifest),
): AgentDef {
  const hostPort = catalogAppHostPort(manifest);
  const webSurface = catalogAppHasWebSurface(manifest);
  return {
    id: manifest.id as AgentDef["id"],
    name: manifest.name,
    vendor: manifest.vendor,
    tagline: manifest.tagline,
    minPlan: manifest.minPlan,
    weight: manifest.weight,
    browser: false,
    badge: manifest.badge,
    accent: manifest.accent,
    available: enabled,
    ...(manifest.runtime.kind === "cli-web" && manifest.runtime.cliChat ? { cliKind: "generic" as const } : {}),
    surface: webSurface ? "dashboard" : "chat",
    floor: { ...manifest.floor },
    ...(hostPort !== null ? { dashboardPort: hostPort } : {}),
    ...(manifest.managedVenice ? { managedVenice: true } : {}),
    ...(manifest.llm ? { llm: manifest.llm } : {}),
  };
}

/** Trademark-safe hosting disclosure shared by Launch and Manage. */
export function catalogAppHostingDisclaimer(
  manifest: CatalogAppManifest,
  deploymentMode: "hivra-managed" | "self-managed" = "hivra-managed",
): string {
  const credentialNotice = deploymentMode === "self-managed"
    ? "Credentials may be stored on the agent computer. Whoever controls the connected host can access its infrastructure; Hivra does not become the host operator."
    : "Credentials may be stored on the agent computer. Hivra administrators retain infrastructure access on Hivra-managed hosts.";
  const upstreamMethod = manifest.runtime.kind === "docker-web" || manifest.runtime.kind === "docker-stack"
    ? `pulls the official ${manifest.name} container image${manifest.runtime.kind === "docker-stack" ? "s" : ""} (${manifest.license}) unmodified`
    : `installs the official ${manifest.name} release (${manifest.license}) unmodified`;
  const surfaceText = catalogAppHasWebSurface(manifest)
    ? `and serves ${manifest.name}'s own interface through Hivra's authenticated gateway`
    : `and connects Hivra's chat, terminal and files tabs to it`;
  const modelText = manifest.managedVenice
    ? " Models can run through Venice on Hivra credits or your own API key."
    : "";
  return `This ${upstreamMethod} on the agent's private virtual machine ${surfaceText}.${modelText} Update it with the Update button. ${credentialNotice} Hivra is an independent hosting service and isn't affiliated with or endorsed by ${manifest.vendor}.`;
}

/** Sleep/wake profile derived from the manifest's runtime shape and port. */
export function catalogAppToWakeProfile(manifest: CatalogAppManifest): AgentWakeProfile {
  const hostPort = catalogAppHostPort(manifest);
  return {
    type: manifest.id,
    busy: [],
    agentProcesses: manifest.runtime.kind === "docker-web" || manifest.runtime.kind === "docker-stack"
      ? [{ cgroup: "docker" }]
      : manifest.runtime.webService
        ? [{ cgroup: "bux-catalog-app\\.service" }]
        : [{ comm: [manifest.runtime.installer.binName] }],
    activity: [],
    schedules: [],
    channels: [],
    wake: {},
    appPorts: hostPort !== null ? [hostPort] : [],
  };
}

/** All loopback ports reserved by universal catalog manifests (for COMPUTER_PROFILE). */
export const UNIVERSAL_CATALOG_APP_PORTS: readonly number[] = UNIVERSAL_CATALOG_MANIFESTS
  .map(catalogAppHostPort)
  .filter((port): port is number => port !== null);
