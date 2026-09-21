// Safe Proxmox template pruning. It only consumes an audit JSON produced by
// proxmox-template-audit.ts and refuses to destroy anything that was not
// classified SAFE_TO_DELETE.
//
// Usage:
//   npm run ops:proxmox:template-prune -- --audit /tmp/hermes-template-audit.json --dry-run
//   npm run ops:proxmox:template-prune -- --audit /tmp/hermes-template-audit.json --apply
//   npm run ops:proxmox:template-prune -- --audit /tmp/hermes-template-audit.json --apply --template 9000

import path from "path";
import * as dotenv from "dotenv";
import { readFile } from "fs/promises";

dotenv.config({ path: path.join(__dirname, "../.env.local"), quiet: true });

import {
  buildProxmoxTemplatePruneScript,
  isProxmoxProvisioningConfigured,
  runProxmoxHostScript,
  type ProxmoxTemplateAuditReport,
} from "../src/lib/services/proxmox-instance-service";

interface Args {
  auditPath: string;
  apply: boolean;
  dryRun: boolean;
  templateVmids: number[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const auditIdx = argv.indexOf("--audit");
  const auditPath = auditIdx >= 0 ? argv[auditIdx + 1] : "";
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const templateVmids: number[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--template") continue;
    const parsed = Number.parseInt(argv[i + 1] || "", 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      templateVmids.push(parsed);
    }
  }

  if (!auditPath) {
    throw new Error("Pass --audit <path-to-audit-json>.");
  }
  if (!apply && !dryRun) {
    throw new Error("Pass --dry-run to preview or --apply to prune.");
  }
  if (apply && dryRun) {
    throw new Error("Choose only one of --dry-run or --apply.");
  }

  return { auditPath, apply, dryRun, templateVmids };
}

async function loadAudit(pathname: string): Promise<ProxmoxTemplateAuditReport> {
  return JSON.parse(await readFile(pathname, "utf8")) as ProxmoxTemplateAuditReport;
}

function selectSafeTemplates(report: ProxmoxTemplateAuditReport, requestedVmids: number[]): number[] {
  const requested = new Set(requestedVmids);
  const selected = report.templates.filter((template) =>
    requested.size > 0 ? requested.has(template.vmid) : template.decision === "SAFE_TO_DELETE"
  );

  const missing = requestedVmids.filter((vmid) => !report.templates.some((template) => template.vmid === vmid));
  if (missing.length > 0) {
    throw new Error(`Requested template VMID(s) not present in audit: ${missing.join(", ")}`);
  }

  const unsafe = selected.filter((template) => template.decision !== "SAFE_TO_DELETE");
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing to prune unsafe template(s): ${unsafe
        .map((template) => `${template.vmid}=${template.decision}`)
        .join(", ")}`
    );
  }

  return selected.map((template) => template.vmid).sort((a, b) => a - b);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const report = await loadAudit(args.auditPath);
  const selectedVmids = selectSafeTemplates(report, args.templateVmids);

  console.log(`Audit generated at: ${report.generatedAt}`);
  console.log(`Selected safe template(s): ${selectedVmids.join(", ") || "(none)"}`);

  if (selectedVmids.length === 0) {
    console.log("Nothing to prune.");
    return;
  }

  if (args.dryRun) {
    console.log("Dry run only. No Proxmox templates were deleted.");
    return;
  }

  if (!isProxmoxProvisioningConfigured(process.env)) {
    throw new Error("Proxmox SSH is not configured in dashboard/.env.local.");
  }

  const result = await runProxmoxHostScript(
    buildProxmoxTemplatePruneScript(selectedVmids),
    process.env,
    { timeoutMs: 120_000 }
  );
  if (!result.ok) {
    throw new Error(result.stderr || result.error || "Proxmox template prune failed.");
  }

  console.log(result.stdout.trim());
}

main().catch((err) => {
  console.error("[template-prune] fatal:", err);
  process.exit(1);
});
