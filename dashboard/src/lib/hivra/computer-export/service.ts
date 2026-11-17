import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import { log } from "@/lib/logger";
import { resolveHivraAgentExecutionContext } from "../agent-execution-context";
import { hasOwnershipBinding } from "../lifecycle-support";
import { buildComputerExportHostScript, ComputerExportError, parseComputerExportResult } from "./host";
import {
  abortMultipartUpload, completeMultipartUpload, presignExportUrl, readExportBucketConfig,
  startMultipartUpload, type ExportBucketConfig, type UploadedPart,
} from "./r2";

// Whole-computer export: the owner's home folders and agent data, packed and
// encrypted on the computer itself with the owner's passphrase, uploaded
// straight to the export bucket, then offered as a download link for a few
// days. Off unless HIVRA_COMPUTER_EXPORT_ENABLED=1 and the bucket is set.

type AgentRow = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PART_SIZE = 64 * 1024 * 1024;
const UPLOAD_LINK_SECONDS = 12 * 60 * 60;

export interface ComputerExportSettings {
  enabled: boolean;
  bucket: ExportBucketConfig | null;
  /** Largest export, in GiB, before the computer stops with "too large". */
  maxGiB: number;
  /** Days the finished file stays downloadable (the bucket's lifecycle rule must match). */
  keepDays: number;
  /** Hours between two exports of one computer. */
  cooldownHours: number;
}

function intSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function readComputerExportSettings(env: Record<string, string | undefined> = process.env): ComputerExportSettings {
  return {
    enabled: env.HIVRA_COMPUTER_EXPORT_ENABLED === "1",
    bucket: readExportBucketConfig(env),
    maxGiB: intSetting(env.HIVRA_COMPUTER_EXPORT_MAX_GIB, 20, 1, 100),
    keepDays: intSetting(env.HIVRA_COMPUTER_EXPORT_KEEP_DAYS, 7, 1, 7),
    cooldownHours: intSetting(env.HIVRA_COMPUTER_EXPORT_COOLDOWN_HOURS, 24, 0, 168),
  };
}

/** Hivra computers on Proxmox with an enforced ownership binding: the ones the host can reach safely. */
export function computerExportEligible(row: AgentRow): boolean {
  return row.computer_substrate === "proxmox-kvm" && hasOwnershipBinding(row)
    && Boolean(row.vmid) && typeof row.ip === "string";
}

export function validateExportPassphrase(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || Buffer.byteLength(value) > 1024 || /[\r\n\0]/.test(value)) {
    throw new ComputerExportError("Use a passphrase of at least 12 characters, on one line.");
  }
  return value;
}

function requireReady(settings: ComputerExportSettings): ExportBucketConfig {
  if (!settings.enabled || !settings.bucket || !supabaseAdmin) {
    throw new ComputerExportError("Computer export is not available yet.", 404);
  }
  return settings.bucket;
}

async function ownedComputer(userId: string, id: string): Promise<AgentRow> {
  if (!UUID.test(id) || !supabaseAdmin) throw new ComputerExportError("Computer not found.", 404);
  const { data, error } = await supabaseAdmin.from("hivra_agents").select("*")
    .eq("id", id).eq("user_id", userId).neq("status", "deleted").maybeSingle();
  if (error || !data) throw new ComputerExportError("Computer not found.", 404);
  if (!computerExportEligible(data)) {
    throw new ComputerExportError("Export works for Hivra cloud computers for now.", 409);
  }
  return data;
}

async function runOnComputer(userId: string, agent: AgentRow, request: Record<string, unknown>, timeoutMs: number) {
  const context = await resolveHivraAgentExecutionContext(userId, agent);
  if (!context.infrastructureBindingTagEnforced || !context.paths.vmSshKeyPath) {
    throw new ComputerExportError("The computer's identity could not be checked.", 409);
  }
  const script = buildComputerExportHostScript({
    vmid: Number(agent.vmid), ip: String(agent.ip),
    bindingTag: context.infrastructureBindingTag, vmSshKeyPath: context.paths.vmSshKeyPath,
  });
  const result = await runProxmoxHostScriptWithStdin(script, JSON.stringify(request), context.env,
    { timeoutMs, maxOutputBytes: 256 * 1024 });
  if (!result.ok) throw new ComputerExportError("The computer could not be reached. Make sure it is running and try again.", 503);
  return parseComputerExportResult(result.stdout);
}

export type ComputerExportView = {
  id: string;
  agentId: string;
  status: "running" | "ready" | "failed";
  bytesUploaded: number;
  byteCount: number | null;
  sha256: string | null;
  createdAt: string;
  expiresAt: string;
  downloadUrl: string | null;
  failure: string | null;
};

function view(row: Record<string, unknown>, extra: Partial<ComputerExportView> = {}): ComputerExportView {
  return {
    id: String(row.id), agentId: String(row.agent_id),
    status: row.status as ComputerExportView["status"],
    bytesUploaded: Number(row.byte_count ?? 0), byteCount: row.byte_count == null ? null : Number(row.byte_count),
    sha256: typeof row.sha256 === "string" ? row.sha256 : null,
    createdAt: String(row.created_at), expiresAt: String(row.expires_at),
    downloadUrl: null, failure: typeof row.failure === "string" ? row.failure : null,
    ...extra,
  };
}

export async function startComputerExport(userId: string, agentId: string, passphraseInput: unknown,
  settings = readComputerExportSettings()): Promise<ComputerExportView> {
  const bucket = requireReady(settings);
  const passphrase = validateExportPassphrase(passphraseInput);
  const agent = await ownedComputer(userId, agentId);
  if (agent.status !== "running" || agent.operation_id) {
    throw new ComputerExportError("Start the computer and wait for its current operation to finish.", 409);
  }
  const since = new Date(Date.now() - settings.cooldownHours * 3_600_000).toISOString();
  const recent = await supabaseAdmin!.from("hivra_computer_exports").select("id,status,created_at")
    .eq("agent_id", agentId).gte("created_at", since).neq("status", "failed").limit(1);
  if (recent.error) throw new ComputerExportError("Export history is unavailable.", 503);
  if ((recent.data ?? []).length > 0) {
    throw new ComputerExportError("This computer was exported recently. Use that download, or try again later.", 429);
  }

  const id = randomUUID();
  const objectKey = `exports/${agentId}/${id}.tar.gpg`;
  const partLimit = Math.ceil((settings.maxGiB * 1024 ** 3) / PART_SIZE);
  const uploadId = await startMultipartUpload(bucket, objectKey);
  const expiresAt = new Date(Date.now() + settings.keepDays * 86_400_000).toISOString();
  const insert = await supabaseAdmin!.from("hivra_computer_exports").insert({
    id, user_id: userId, agent_id: agentId, object_key: objectKey, upload_id: uploadId,
    part_size: PART_SIZE, part_limit: partLimit, status: "running", expires_at: expiresAt,
  }).select("*").single();
  if (insert.error || !insert.data) {
    await abortMultipartUpload(bucket, objectKey, uploadId).catch(() => undefined);
    throw new ComputerExportError("The export could not be recorded.", 503);
  }
  const partUrls = Array.from({ length: partLimit }, (_, i) => presignExportUrl(bucket, {
    method: "PUT", key: objectKey, expiresSeconds: UPLOAD_LINK_SECONDS,
    query: { partNumber: String(i + 1), uploadId },
  }));
  let answer: Record<string, unknown>;
  try {
    answer = await runOnComputer(userId, agent, { action: "start", exportId: id, passphrase, partSize: PART_SIZE, partUrls }, 90_000);
  } catch (error) {
    await failExport(bucket, insert.data, "The computer could not start the export.");
    throw error;
  }
  if (answer.ok !== true) {
    await failExport(bucket, insert.data, "The computer refused the export.");
    log.warn("Computer export refused by the guest", { source: "computer-export", exportId: id, reason: String(answer.error ?? "") });
    throw new ComputerExportError("The computer could not start the export.", 409);
  }
  return view(insert.data);
}

async function failExport(bucket: ExportBucketConfig, row: Record<string, unknown>, failure: string) {
  await abortMultipartUpload(bucket, String(row.object_key), String(row.upload_id)).catch(() => undefined);
  await supabaseAdmin!.from("hivra_computer_exports")
    .update({ status: "failed", failure, completed_at: new Date().toISOString() })
    .eq("id", String(row.id)).eq("status", "running");
}

function parseParts(value: unknown, limit: number): UploadedPart[] {
  if (!Array.isArray(value) || value.length > limit) throw new ComputerExportError("Invalid export progress.", 503);
  return value.map((part, i) => {
    const p = part as { partNumber?: unknown; etag?: unknown };
    if (p?.partNumber !== i + 1 || typeof p.etag !== "string") throw new ComputerExportError("Invalid export progress.", 503);
    return { partNumber: i + 1, etag: p.etag };
  });
}

/** The export's state; while running, asks the computer and completes the upload once it has finished. */
export async function getComputerExport(userId: string, exportId: string,
  settings = readComputerExportSettings()): Promise<ComputerExportView> {
  const bucket = requireReady(settings);
  if (!UUID.test(exportId)) throw new ComputerExportError("Export not found.", 404);
  const { data: row, error } = await supabaseAdmin!.from("hivra_computer_exports").select("*")
    .eq("id", exportId).eq("user_id", userId).maybeSingle();
  if (error || !row) throw new ComputerExportError("Export not found.", 404);
  const expired = Date.parse(String(row.expires_at)) <= Date.now();

  if (row.status === "ready") {
    if (expired) return view(row, { failure: "This download has expired." });
    return getReadyView(bucket, row);
  }
  if (row.status !== "running") return view(row);
  if (Date.now() - Date.parse(String(row.created_at)) > 12 * 3_600_000) {
    await failExport(bucket, row, "The export took too long and was stopped.");
    return view({ ...row, status: "failed", failure: "The export took too long and was stopped." });
  }

  const agent = await ownedComputer(userId, String(row.agent_id));
  const answer = await runOnComputer(userId, agent, { action: "status", exportId }, 60_000);
  const state = answer.state;
  const bytes = typeof answer.bytes === "number" ? answer.bytes : 0;
  if (state === "queued" || state === "running") return view(row, { bytesUploaded: bytes });
  if (state === "failed" || state === "missing") {
    const failure = state === "missing" ? "The computer lost track of this export (it may have restarted)." : "Packing or uploading failed on the computer.";
    log.warn("Computer export failed on the guest", { source: "computer-export", exportId, reason: String(answer.error ?? state) });
    await failExport(bucket, row, failure);
    return view({ ...row, status: "failed", failure });
  }
  if (state !== "uploaded" || typeof answer.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(answer.sha256)) {
    throw new ComputerExportError("Invalid export progress.", 503);
  }
  const parts = parseParts(answer.parts, Number(row.part_limit));
  await completeMultipartUpload(bucket, String(row.object_key), String(row.upload_id), parts);
  const update = await supabaseAdmin!.from("hivra_computer_exports")
    .update({ status: "ready", byte_count: bytes, sha256: answer.sha256, completed_at: new Date().toISOString() })
    .eq("id", exportId).eq("status", "running").select("*").maybeSingle();
  const ready = update.data ?? { ...row, status: "ready", byte_count: bytes, sha256: answer.sha256 };
  return getReadyView(bucket, ready);
}

function getReadyView(bucket: ExportBucketConfig, row: Record<string, unknown>): ComputerExportView {
  const seconds = Math.max(60, Math.min(604_800, Math.floor((Date.parse(String(row.expires_at)) - Date.now()) / 1000)));
  return view(row, { downloadUrl: presignExportUrl(bucket, { method: "GET", key: String(row.object_key), expiresSeconds: seconds }) });
}

/** The newest export of each of the owner's computers, for the export page. */
export async function listComputerExports(userId: string, settings = readComputerExportSettings()): Promise<ComputerExportView[]> {
  requireReady(settings);
  const { data, error } = await supabaseAdmin!.from("hivra_computer_exports").select("*")
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(20);
  if (error) throw new ComputerExportError("Export history is unavailable.", 503);
  return (data ?? []).map((row) => view(row));
}
