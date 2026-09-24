import "server-only";

// Revisions of each agent's Computer Contract (hivra_computer_contracts,
// service role only). A new revision is minted only when the rendered input
// changes; delivery state moves only on a receipt for that revision's exact
// bytes. When the table is not deployed yet every reader returns null and
// the caller shows the contract as unavailable instead of failing the page.

import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import {
  COMPUTER_CONTRACT_TEMPLATE_VERSION,
  renderComputerContract,
  type ComputerContractInput,
} from "@/lib/agent-computers/computer-contract";
import {
  canonicalComputerContractInput,
  type ComputerContractChannel,
} from "@/lib/agent-computers/computer-contract-input";

export type ComputerContractDeliveryState = "pending" | "delivered" | "sent" | "conflict";

export interface ComputerContractRow {
  id: string;
  agent_id: string;
  user_id: string;
  revision: number;
  template_version: number;
  channel: ComputerContractChannel;
  input: ComputerContractInput;
  input_sha256: string;
  content: string;
  content_sha256: string;
  rendered_at: string;
  delivery_state: ComputerContractDeliveryState;
  delivered_at: string | null;
  receipt: Record<string, unknown> | null;
  checked_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
}

const TABLE = "hivra_computer_contracts";
const SELECT = "id,agent_id,user_id,revision,template_version,channel,input,input_sha256,content,content_sha256,rendered_at,delivery_state,delivered_at,receipt,checked_at,last_attempt_at,last_error";
const LOG_SOURCE = "hivra/computer-contract-store";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function db() {
  if (!supabaseAdmin) throw new Error("Database not configured");
  return supabaseAdmin;
}

/** PostgREST's "relation is not in the schema cache" and Postgres' own. */
function tableMissing(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

/** Newest first. null when the table is not deployed or unreadable. */
export async function loadComputerContracts(userId: string, agentId: string, limit = 10): Promise<ComputerContractRow[] | null> {
  const { data, error } = await db().from(TABLE).select(SELECT)
    .eq("agent_id", agentId).eq("user_id", userId)
    .order("revision", { ascending: false }).limit(limit);
  if (error) {
    if (!tableMissing(error)) log.warn("computer contract read failed", { source: LOG_SOURCE, failureType: "computer_contract_read_failed", agentId, code: error.code });
    return null;
  }
  return (data ?? []) as unknown as ComputerContractRow[];
}

/**
 * The current revision for this input: the latest row when its input is
 * unchanged, otherwise a new revision rendered with the next number. Two
 * concurrent callers race on the unique (agent, revision) key; the loser
 * re-reads and returns the winner's row.
 */
export async function ensureComputerContractRevision(input: {
  userId: string;
  agentId: string;
  channel: ComputerContractChannel;
  contract: ComputerContractInput;
}): Promise<{ rows: ComputerContractRow[]; latest: ComputerContractRow } | null> {
  const inputSha256 = sha256Hex(canonicalComputerContractInput(input.contract));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rows = await loadComputerContracts(input.userId, input.agentId);
    if (!rows) return null;
    const latest = rows[0];
    if (latest && latest.input_sha256 === inputSha256 && latest.channel === input.channel
      && latest.template_version === COMPUTER_CONTRACT_TEMPLATE_VERSION) {
      return { rows, latest };
    }
    const revision = (latest?.revision ?? 0) + 1;
    const content = renderComputerContract(input.contract, revision);
    const { data, error } = await db().from(TABLE).insert({
      agent_id: input.agentId,
      user_id: input.userId,
      revision,
      template_version: COMPUTER_CONTRACT_TEMPLATE_VERSION,
      channel: input.channel,
      input: JSON.parse(canonicalComputerContractInput(input.contract)),
      input_sha256: inputSha256,
      content,
      content_sha256: sha256Hex(content),
    }).select(SELECT).single();
    if (!error && data) {
      const row = data as unknown as ComputerContractRow;
      return { rows: [row, ...rows], latest: row };
    }
    if (error?.code !== "23505") {
      if (!tableMissing(error)) log.warn("computer contract revision was not stored", { source: LOG_SOURCE, failureType: "computer_contract_insert_failed", agentId: input.agentId, code: error?.code });
      return null;
    }
  }
  return null;
}

async function update(row: ComputerContractRow, patch: Partial<ComputerContractRow>): Promise<ComputerContractRow> {
  const { data, error } = await db().from(TABLE).update(patch)
    .eq("id", row.id).eq("agent_id", row.agent_id).eq("user_id", row.user_id)
    .select(SELECT).single();
  if (error || !data) {
    log.warn("computer contract state was not recorded", { source: LOG_SOURCE, failureType: "computer_contract_update_failed", agentId: row.agent_id, code: error?.code });
    return { ...row, ...patch };
  }
  return data as unknown as ComputerContractRow;
}

export function recordComputerContractAttempt(row: ComputerContractRow, at: Date) {
  return update(row, { last_attempt_at: at.toISOString() });
}

export function recordComputerContractError(row: ComputerContractRow, error: string) {
  return update(row, { last_error: error });
}

/** Only a receipt for this revision's exact bytes may call this. */
export function recordComputerContractDelivered(row: ComputerContractRow, state: "delivered" | "sent", receipt: Record<string, unknown>, at: Date) {
  return update(row, { delivery_state: state, delivered_at: at.toISOString(), checked_at: at.toISOString(), receipt, last_error: null });
}

export function recordComputerContractChecked(row: ComputerContractRow, at: Date) {
  return update(row, { checked_at: at.toISOString(), last_error: null });
}

/** A delivered revision read back unchanged; its receipt and time stay. */
export function recordComputerContractIntact(row: ComputerContractRow, at: Date) {
  return update(row, { delivery_state: "delivered", checked_at: at.toISOString(), last_error: null });
}

/** The computer's copy is not one Hivra wrote; nothing is overwritten. */
export function recordComputerContractConflict(row: ComputerContractRow, at: Date) {
  return update(row, { delivery_state: "conflict", checked_at: at.toISOString(), last_error: "edited_on_computer" });
}
