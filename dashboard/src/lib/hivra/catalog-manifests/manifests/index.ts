// Universal catalog manifest registry.
//
// Entries live in one file per category group under catalog-manifests/manifests/;
// this module concatenates them in display order and validates every manifest at
// module load so malformed entries fail fast in tests and builds before reaching
// Launch or the guest provisioner.
//
// Adding a new open-source agent or app to Hivra means adding one validated
// entry to the right category file. No SQL migration and no provisioner release
// is needed once the catalog-app runner is deployed.

import { CatalogAppManifestSchema, type CatalogAppManifest } from "../schema";
import { AI_INFRA_MANIFESTS } from "./ai-infra";
import { AI_WORKSPACE_MANIFESTS } from "./ai-workspaces";
import { CODING_AGENT_MANIFESTS } from "./coding-agents";
import { DASHBOARD_MANIFESTS } from "./dashboards";
import { DEV_TOOL_MANIFESTS } from "./dev-tools";
import { MEDIA_MANIFESTS } from "./media";
import { MONITORING_OPS_MANIFESTS } from "./monitoring-ops";
import { PERSONAL_AGENT_MANIFESTS } from "./personal-agents";
import { PRODUCTIVITY_MANIFESTS } from "./productivity";

const RAW_MANIFESTS: readonly CatalogAppManifest[] = [
  ...PERSONAL_AGENT_MANIFESTS,
  ...CODING_AGENT_MANIFESTS,
  ...AI_WORKSPACE_MANIFESTS,
  ...AI_INFRA_MANIFESTS,
  ...DEV_TOOL_MANIFESTS,
  ...PRODUCTIVITY_MANIFESTS,
  ...DASHBOARD_MANIFESTS,
  ...MONITORING_OPS_MANIFESTS,
  ...MEDIA_MANIFESTS,
];

export const UNIVERSAL_CATALOG_MANIFESTS: readonly CatalogAppManifest[] = RAW_MANIFESTS.map((entry) =>
  CatalogAppManifestSchema.parse(entry),
);

export const UNIVERSAL_CATALOG_IDS = [
  "nanobot",
  "zeroclaw",
  "picoclaw",
  "opencode",
  "goose",
  "openhands",
  "aider",
  "qwen-code",
  "anythingllm",
  "qdrant",
  "chroma",
  "ollama",
  "new-api",
  "gogs",
  "drawio",
  "excalidraw",
  "mermaid-live",
  "cyberchef",
  "swagger-ui",
  "node-red",
  "kanboard",
  "kroki",
  "syncthing",
  "jenkins",
  "clickhouse",
  "appsmith",
  "dufs",
  "gotenberg",
  "memos",
  "wallos",
  "shiori",
  "actual-budget",
  "mealie",
  "vaultwarden",
  "it-tools",
  "trilium",
  "freshrss",
  "nextcloud",
  "miniflux",
  "docmost",
  "wiki-js",
  "linkwarden",
  "hedgedoc",
  "rsshub",
  "dashy",
  "homepage",
  "flame",
  "homer",
  "uptime-kuma",
  "grafana",
  "beszel",
  "openspeedtest",
  "netdata",
  "traccar",
  "umami",
  "openobserve",
  "adguard-home",
  "audiobookshelf",
  "kavita",
  "calibre-web",
  "suwayomi",
  "komga",
  "immich",
] as const;

export type UniversalCatalogAppId = (typeof UNIVERSAL_CATALOG_IDS)[number];

// The id list exists for the literal union type; keep it honest against the
// manifests so Launch profiles, route-grammar value sets and catalog lookups
// can never drift from what is actually registered.
{
  const manifestIds = UNIVERSAL_CATALOG_MANIFESTS.map((manifest) => manifest.id).sort();
  const listedIds = [...UNIVERSAL_CATALOG_IDS].sort();
  if (manifestIds.length !== listedIds.length || manifestIds.some((id, index) => id !== listedIds[index])) {
    throw new Error("UNIVERSAL_CATALOG_IDS is out of sync with UNIVERSAL_CATALOG_MANIFESTS");
  }
}
