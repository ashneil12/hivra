// Read-only Proxmox template audit. Produces a report that says which
// templates must be kept as linked-clone parents and which are safe prune
// candidates. This script never destroys anything.
//
// Usage:
//   npm run ops:proxmox:template-audit
//   npm run ops:proxmox:template-audit -- --out /tmp/hermes-template-audit.json

import path from "path";
import * as dotenv from "dotenv";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

import {
  buildProxmoxTemplateAuditScript,
  isProxmoxProvisioningConfigured,
  parseProxmoxTemplateAuditOutput,
  runProxmoxHostScript,
} from "../src/lib/services/proxmox-instance-service";

interface Args {
  outPath: string | null;
}

interface InstanceTemplateReference {
  id: string;
  name: string | null;
  status: string | null;
  proxmox_template_vmid?: number | null;
  config?: Record<string, unknown> | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  return {
    outPath: outIdx >= 0 ? argv[outIdx + 1] || null : null,
  };
}

function optionalPositiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function createSupabaseOrNull() {
  const url = resolveSupabaseUrl();
  const key = resolveSupabaseServiceRoleKey();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function readSupabaseProjectRef(): string | null {
  try {
    return readFileSync(path.join(__dirname, "../supabase/.temp/project-ref"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function resolveSupabaseUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (configured) return configured;

  const projectRef = readSupabaseProjectRef();
  return projectRef ? `https://${projectRef}.supabase.co` : null;
}

function resolveSupabaseServiceRoleKey(): string | null {
  const configured = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (configured) return configured;

  const projectRef = readSupabaseProjectRef();
  if (!projectRef) return null;

  try {
    const raw = execFileSync(
      "supabase",
      ["projects", "api-keys", "--project-ref", projectRef, "--output", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const keys = JSON.parse(raw) as Array<{ name?: string; type?: string; api_key?: string }>;
    return (
      keys.find((entry) => entry.type === "secret")?.api_key ||
      keys.find((entry) => entry.name === "service_role")?.api_key ||
      null
    );
  } catch {
    return null;
  }
}

async function loadDbTemplateVmids(): Promise<number[]> {
  const supabase = createSupabaseOrNull();
  if (!supabase) return [];

  const baseQuery = supabase
    .from("hermes_instances")
    .select("id, name, status, proxmox_template_vmid, config")
    .eq("infrastructure_provider", "proxmox")
    .not("status", "in", '("deleted")');

  const { data, error } = await baseQuery;
  if (error) {
    const fallback = await supabase
      .from("hermes_instances")
      .select("id, name, status, config")
      .eq("infrastructure_provider", "proxmox")
      .not("status", "in", '("deleted")');
    if (fallback.error) {
      console.warn(`[template-audit] Supabase provenance query failed: ${fallback.error.message}`);
      return [];
    }
    return collectDbTemplateVmids((fallback.data || []) as InstanceTemplateReference[]);
  }

  return collectDbTemplateVmids((data || []) as InstanceTemplateReference[]);
}

function collectDbTemplateVmids(rows: InstanceTemplateReference[]): number[] {
  const vmids = new Set<number>();
  for (const row of rows) {
    if (typeof row.proxmox_template_vmid === "number" && row.proxmox_template_vmid > 0) {
      vmids.add(row.proxmox_template_vmid);
      continue;
    }
    const infrastructure = row.config?.infrastructure;
    if (typeof infrastructure === "object" && infrastructure) {
      const templateVmid = (infrastructure as Record<string, unknown>).templateVmid;
      if (typeof templateVmid === "number" && templateVmid > 0) {
        vmids.add(templateVmid);
      }
    }
  }
  return Array.from(vmids).sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!isProxmoxProvisioningConfigured(process.env)) {
    throw new Error("Proxmox SSH is not configured in dashboard/.env.local.");
  }

  const currentTemplateVmid = optionalPositiveInt(process.env.PROXMOX_TEMPLATE_ID);
  const dbTemplateVmids = await loadDbTemplateVmids();
  const hostResult = await runProxmoxHostScript(
    buildProxmoxTemplateAuditScript(),
    process.env,
    { timeoutMs: 60_000 }
  );

  if (!hostResult.ok) {
    throw new Error(hostResult.stderr || hostResult.error || "Proxmox template audit failed.");
  }

  const report = parseProxmoxTemplateAuditOutput(hostResult.stdout, {
    currentTemplateVmid,
    dbTemplateVmids,
  });

  console.log("=== Proxmox template audit ===");
  console.log(`current template: ${report.currentTemplateVmid ?? "(not set)"}`);
  console.log(`db provenance templates: ${report.dbTemplateVmids.join(", ") || "(none recorded)"}`);
  console.log("");

  if (report.templates.length === 0) {
    console.log("No Proxmox templates found.");
  } else {
    for (const template of report.templates) {
      const deps = template.dependentVmids.length
        ? ` deps=${template.dependentVmids.join(",")}`
        : "";
      console.log(
        `${template.decision.padEnd(18)} vmid=${template.vmid} name=${template.name}${deps} reason=${template.reasons.join("; ")}`
      );
    }
  }

  const safe = report.templates.filter((template) => template.decision === "SAFE_TO_DELETE");
  console.log("");
  console.log(`safe prune candidates: ${safe.map((template) => template.vmid).join(", ") || "(none)"}`);

  if (args.outPath) {
    await mkdir(dirname(args.outPath), { recursive: true });
    await writeFile(args.outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`wrote ${args.outPath}`);
  }
}

main().catch((err) => {
  console.error("[template-audit] fatal:", err);
  process.exit(1);
});
