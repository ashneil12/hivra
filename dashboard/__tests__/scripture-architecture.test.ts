import fs from "node:fs";
import path from "node:path";

const WORKSPACE_ROOT = path.resolve(process.cwd(), "..");
const DASHBOARD_ROOT = path.join(WORKSPACE_ROOT, "dashboard");
const DASHBOARD_ANCHOR_SCAN_ROOTS = [
  path.join(DASHBOARD_ROOT, "src"),
  path.join(DASHBOARD_ROOT, "scripts"),
  path.join(DASHBOARD_ROOT, "docs"),
  path.join(DASHBOARD_ROOT, "supabase"),
];

const EXPECTED_DASHBOARD_ANCHORS = [
  {
    file: "dashboard/src/lib/api-response.ts",
    id: "api-order",
    reference: "1 Corinthians 14:40",
  },
  {
    file: "dashboard/src/lib/request-context.ts",
    id: "trace-lamp",
    reference: "Psalm 119:105",
  },
  {
    file: "dashboard/src/lib/ops-events.ts",
    id: "ops-honest",
    reference: "2 Corinthians 8:21",
  },
  {
    file: "dashboard/src/lib/command-output-redaction.ts",
    id: "secret-watch",
    reference: "Proverbs 4:23",
  },
  {
    file: "dashboard/src/lib/agent-gateway.ts",
    id: "gateway-way",
    reference: "Isaiah 40:3",
  },
  {
    file: "dashboard/src/lib/concurrency.ts",
    id: "workers-together",
    reference: "Ecclesiastes 4:9",
  },
  {
    file: "dashboard/src/lib/crypto.ts",
    id: "sealed-trust",
    reference: "Song of Solomon 8:6",
  },
  {
    file: "dashboard/src/lib/billing/compute-billing.ts",
    id: "just-weight",
    reference: "Proverbs 11:1",
  },
  {
    file: "dashboard/src/app/blog/page.tsx",
    id: "blog-proclaim",
    reference: "Psalm 96:3",
  },
  {
    file: "dashboard/src/app/blog/[slug]/page.tsx",
    id: "blog-scroll",
    reference: "Habakkuk 2:2",
  },
  {
    file: "dashboard/src/lib/blog-data.ts",
    id: "blog-store",
    reference: "Psalm 78:4",
  },
  {
    file: "dashboard/src/lib/blog/articles/what-is-hermes-agent.ts",
    id: "blog-teach",
    reference: "Deuteronomy 6:7",
  },
  {
    file: "dashboard/src/app/api/webhooks/stripe/route.ts",
    id: "stripe-steward",
    reference: "Luke 16:10",
  },
  {
    file: "dashboard/src/app/api/webhooks/clerk/route.ts",
    id: "clerk-gate",
    reference: "Nehemiah 7:3",
  },
  {
    file: "dashboard/src/app/api/cron/refresh-token-tiers/route.ts",
    id: "cron-season",
    reference: "Ecclesiastes 3:1",
  },
  {
    file: "dashboard/src/app/api/ops/events/route.ts",
    id: "ops-watchman",
    reference: "Ezekiel 33:7",
  },
  {
    file: "dashboard/src/app/api/csp/report/route.ts",
    id: "csp-shield",
    reference: "Psalm 5:12",
  },
  {
    file: "dashboard/src/app/api/indexnow/route.ts",
    id: "indexnow-declare",
    reference: "Isaiah 52:7",
  },
  {
    file: "dashboard/src/lib/venice/proxy-chat-core.ts",
    id: "venice-stream",
    reference: "Proverbs 18:4",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/images/generate/route.ts",
    id: "venice-image",
    reference: "Genesis 1:27",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/videos/queue/route.ts",
    id: "venice-video",
    reference: "Habakkuk 2:2",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/videos/[id]/route.ts",
    id: "venice-video-retrieve",
    reference: "Habakkuk 2:3",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/audio/speech/route.ts",
    id: "venice-speech",
    reference: "Isaiah 50:4",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/audio/transcriptions/route.ts",
    id: "venice-transcribe",
    reference: "Job 33:32",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/images/upscale/route.ts",
    id: "venice-upscale",
    reference: "Isaiah 40:31",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/images/edit/route.ts",
    id: "venice-image-edit",
    reference: "Jeremiah 18:6",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/images/multi-edit/route.ts",
    id: "venice-image-compose",
    reference: "Ecclesiastes 4:12",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/images/background-remove/route.ts",
    id: "venice-bg-remove",
    reference: "Psalm 51:7",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/augment/search/route.ts",
    id: "venice-search",
    reference: "Proverbs 25:2",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/augment/scrape/route.ts",
    id: "venice-scrape",
    reference: "Proverbs 18:15",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/embeddings/route.ts",
    id: "venice-embeddings",
    reference: "Psalm 139:23",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/audio/queue/route.ts",
    id: "venice-audio-queue",
    reference: "Psalm 96:1",
  },
  {
    file: "dashboard/src/app/api/managed-venice/v1/[...path]/route.ts",
    id: "venice-passthrough",
    reference: "John 14:6",
  },
  {
    file: "dashboard/src/app/api/upload-migration/route.ts",
    id: "migration-crossing",
    reference: "Joshua 3:4",
  },
  {
    file: "dashboard/src/lib/stripe.ts",
    id: "stripe-faithful",
    reference: "Proverbs 21:5",
  },
  {
    file: "dashboard/src/lib/stripe-webhook-events.ts",
    id: "webhook-memory",
    reference: "Deuteronomy 8:2",
  },
  {
    file: "dashboard/src/lib/clerk-request-auth.ts",
    id: "auth-known",
    reference: "John 10:14",
  },
  {
    file: "dashboard/src/lib/email/clerk-webhook-signature.ts",
    id: "signature-true",
    reference: "Proverbs 12:22",
  },
  // The "proxy-path" anchor (Proverbs 4:26) lived in
  // dashboard/src/lib/responses-proxy-request.ts, which was deleted along with
  // the retired /api/instances/[id]/responses proxy.
  {
    file: "dashboard/src/lib/chat-content.ts",
    id: "chat-words",
    reference: "Proverbs 16:24",
  },
  {
    file: "dashboard/src/lib/server-chat-stream-outcome.ts",
    id: "stream-end",
    reference: "2 Timothy 4:7",
  },
  {
    file: "dashboard/src/lib/seo-urls.ts",
    id: "seo-paths",
    reference: "Jeremiah 6:16",
  },
  {
    file: "dashboard/src/lib/billing/credits.ts",
    id: "credits-measure",
    reference: "Luke 6:38",
  },
  {
    file: "dashboard/src/lib/billing/token-holdings.ts",
    id: "token-store",
    reference: "Matthew 6:20",
  },
  {
    file: "dashboard/src/lib/billing/managed-venice-wallets.ts",
    id: "venice-wallet",
    reference: "Proverbs 3:9",
  },
  {
    file: "dashboard/src/lib/services/instance-service.ts",
    id: "instance-builder",
    reference: "Psalm 127:1",
  },
  {
    file: "dashboard/src/lib/services/proxmox-instance-service.ts",
    id: "proxmox-foundation",
    reference: "Luke 14:28",
  },
  {
    file: "dashboard/src/lib/services/cloudflare-dns.ts",
    id: "dns-name",
    reference: "Genesis 2:19",
  },
  {
    file: "dashboard/src/lib/services/profile-service.ts",
    id: "profile-branch",
    reference: "John 15:5",
  },
  {
    file: "dashboard/src/lib/recovery/recover-stuck-instances.ts",
    id: "recover-lost",
    reference: "Luke 15:4",
  },
  {
    file: "dashboard/scripts/ops-daily-sweep.ts",
    id: "daily-sweep",
    reference: "Lamentations 3:23",
  },
  {
    file: "dashboard/scripts/prune-chat-storage.ts",
    id: "prune-fruit",
    reference: "John 15:2",
  },
  {
    file: "dashboard/scripts/rotate-encryption-keys.ts",
    id: "key-season",
    reference: "Isaiah 22:22",
  },
  {
    file: "dashboard/scripts/migrate-webui-caddy-auth.ts",
    id: "migrate-pillar",
    reference: "Exodus 13:21",
  },
  {
    file: "dashboard/scripts/cleanup-orphan-caddy-sites.ts",
    id: "orphan-care",
    reference: "James 1:27",
  },
  {
    file: "dashboard/scripts/canary-webui-migration.ts",
    id: "canary-scout",
    reference: "Numbers 13:2",
  },
  {
    file: "dashboard/docs/staging-qa-runbook.md",
    id: "qa-prove",
    reference: "1 Thessalonians 5:21",
  },
  {
    file: "dashboard/docs/managed-venice-runbook.md",
    id: "runbook-write",
    reference: "Deuteronomy 31:19",
  },
  {
    file: "dashboard/supabase/migrations/20260411133000_ops_events.sql",
    id: "schema-record",
    reference: "Malachi 3:16",
  },
  {
    file: "dashboard/supabase/migrations/20260509080000_instance_deletion_archives.sql",
    id: "archive-book",
    reference: "Revelation 20:12",
  },
] as const;

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "__mocks__" ||
        entry.name === "node_modules" ||
        entry.name === ".next"
      ) {
        return [];
      }
      return listFiles(fullPath);
    }
    return /\.(ts|tsx|js|cjs|mjs|sh|md|sql|toml)$/.test(entry.name) ? [fullPath] : [];
  });
}

function anchorCommentPrefix(filePath: string): string {
  if (filePath.endsWith(".md")) return "<!-- SCRIPTURE_ANCHOR:";
  if (filePath.endsWith(".sql")) return "-- SCRIPTURE_ANCHOR:";
  if (filePath.endsWith(".sh") || filePath.endsWith(".toml")) return "# SCRIPTURE_ANCHOR:";
  return "// SCRIPTURE_ANCHOR:";
}

describe("dashboard scripture architecture anchors", () => {
  it("keeps each dashboard anchor in the intended internal file", () => {
    for (const anchor of EXPECTED_DASHBOARD_ANCHORS) {
      const source = fs.readFileSync(path.join(WORKSPACE_ROOT, anchor.file), "utf8");
      expect(source).toContain(
        `${anchorCommentPrefix(anchor.file)} ${anchor.id} | ${anchor.reference} | Verse: `
      );
    }
  });

  it("keeps dashboard anchors internal, expected, and comment-only", () => {
    const expectedFiles: Set<string> = new Set(EXPECTED_DASHBOARD_ANCHORS.map((anchor) => anchor.file));
    const scanFiles = DASHBOARD_ANCHOR_SCAN_ROOTS.flatMap(listFiles);
    const offenders = scanFiles.flatMap((filePath) => {
      const relativePath = path.relative(WORKSPACE_ROOT, filePath);
      const prefix = anchorCommentPrefix(relativePath);
      return fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(({ line }) => line.includes("SCRIPTURE_ANCHOR:"))
        .filter(({ line }) => !line.trimStart().startsWith(prefix))
        .map(({ line, lineNumber }) => `${relativePath}:${lineNumber}: ${line.trim()}`);
    });

    const misplaced = scanFiles.flatMap((filePath) => {
      const relativePath = path.relative(WORKSPACE_ROOT, filePath);
      if (expectedFiles.has(relativePath)) return [];
      if (!fs.readFileSync(filePath, "utf8").includes("SCRIPTURE_ANCHOR:")) return [];
      return [relativePath];
    });

    expect(offenders).toEqual([]);
    expect(misplaced).toEqual([]);
  });
});
