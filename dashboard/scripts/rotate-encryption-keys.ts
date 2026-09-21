import { loadEnvConfig } from "@next/env";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  formatRotationSummary,
  runEncryptionKeyRotation,
  type ConversationRow,
  type AdditionalSecretRow,
  type AdditionalSecretSurface,
  type ChatStreamJobRow,
  type EncryptionRotationStore,
  type HermesInstanceRow,
  type InfrastructureConnectionSecretRow,
  type MessageRow,
  type VaultKeyRow,
} from "../src/lib/encryption-rotation";
import {
  formatRotationCoverage,
  inspectRotationCoverage,
  type RotationDependency,
} from "../src/lib/encryption-rotation-coverage";

// SCRIPTURE_ANCHOR: key-season | Isaiah 22:22 | Verse: I will lay the key of David's house on his shoulder.
type Args = {
  dryRun: boolean;
  batchSize: number;
  coverageOnly: boolean;
  help: boolean;
};

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: true,
    batchSize: 100,
    coverageOnly: false,
    help: argv.length === 1 && argv[0] === "--help",
  };
  if (args.help) return args;
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (seen.has(arg)) throw new Error("Repeated option; see --help");
    seen.add(arg);
    if (arg === "--dry-run") {
      continue;
    }
    if (arg === "--apply") { args.dryRun = false; continue; }
    if (arg === "--coverage-only") { args.coverageOnly = true; continue; }

    if (arg === "--batch-size") {
      const raw = argv[index + 1] ?? "";
      const value = Number(raw);
      if (!/^[1-9][0-9]{0,3}$/.test(raw) || value > 1000) {
        throw new Error("`--batch-size` must be an integer from 1 to 1000");
      }
      args.batchSize = value;
      index += 1;
      continue;
    }

    throw new Error("Unknown option; see --help");
  }
  if (seen.has("--apply") && (seen.has("--dry-run") || args.coverageOnly)) {
    throw new Error("--apply cannot be combined with a read-only mode");
  }

  return args;
}

export class SupabaseEncryptionRotationStore implements EncryptionRotationStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async countUnhandledValues(dependency: RotationDependency): Promise<number> {
    const { table, column } = dependency;
    const filtered = dependency as RotationDependency & { equals?: Record<string, string | number> };
    let query = this.supabase.from(table)
      .select(column, { count: "exact", head: true }).not(column, "is", null);
    for (const [filterColumn, value] of Object.entries(filtered.equals ?? {})) {
      query = query.eq(filterColumn, value);
    }
    const { count, error } = await query.abortSignal(AbortSignal.timeout(10_000));
    if (error || !Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error("Required dependency count unavailable");
    }
    return count as number;
  }

  async listVaultKeys(afterId: string | null, limit: number): Promise<VaultKeyRow[]> {
    let query = this.supabase
      .from("user_api_keys")
      .select("id,encrypted_key")
      .order("id", { ascending: true })
      .limit(limit);
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query.abortSignal(AbortSignal.timeout(10_000));

    if (error) throw error;
    return (data || []) as VaultKeyRow[];
  }

  private async compareAndSwap(surface: string, expectedRow: { id: string }, patch: object): Promise<boolean> {
    const { id, ...expected } = expectedRow;
    const { data, error } = await this.supabase.rpc("rewrap_legacy_encryption_row", {
      p_surface: surface, p_id: id, p_expected: expected, p_patch: patch,
    }).abortSignal(AbortSignal.timeout(10_000));
    if (error || typeof data !== "boolean") throw new Error("Legacy rewrap did not return an authoritative result");
    return data;
  }

  async updateVaultKey(expected: VaultKeyRow, patch: Partial<VaultKeyRow>): Promise<boolean> {
    return this.compareAndSwap("user_api_keys", expected, patch);
  }

  async listInfrastructureConnectionSecrets(
    afterId: string | null,
    limit: number,
  ): Promise<InfrastructureConnectionSecretRow[]> {
    let query = this.supabase
      .from("infrastructure_connection_secrets")
      .select("connection_id,encrypted_bundle,key_version")
      .order("connection_id", { ascending: true })
      .limit(limit);
    if (afterId !== null) query = query.gt("connection_id", afterId);
    const { data, error } = await query.abortSignal(AbortSignal.timeout(10_000));

    if (error) throw error;
    return (data || []) as InfrastructureConnectionSecretRow[];
  }

  async updateInfrastructureConnectionSecret(
    connectionId: string,
    expectedEncryptedBundle: string,
    patch: Partial<InfrastructureConnectionSecretRow>,
  ): Promise<boolean> {
    const replacement = patch.encrypted_bundle;
    if (typeof replacement !== "string") {
      throw new Error("Infrastructure credential rotation requires encrypted_bundle");
    }
    if (!Number.isSafeInteger(patch.key_version) || (patch.key_version as number) < 1) {
      throw new Error("Infrastructure credential rotation requires the original schema version");
    }
    const { data, error } = await this.supabase.rpc(
      "rotate_infrastructure_connection_secret",
      {
        p_connection_id: connectionId,
        p_expected_encrypted_bundle: expectedEncryptedBundle,
        p_encrypted_bundle: replacement,
        p_key_version: patch.key_version,
      },
    ).abortSignal(AbortSignal.timeout(10_000));
    if (error || typeof data !== "boolean") throw new Error("Infrastructure rewrap did not return an authoritative result");
    return data;
  }

  async listInstances(afterId: string | null, limit: number): Promise<HermesInstanceRow[]> {
    let query = this.supabase
      .from("hermes_instances")
      .select("id,api_key_encrypted,api_server_key_encrypted,honcho_api_key_encrypted,config")
      .order("id", { ascending: true })
      .limit(limit);
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query.abortSignal(AbortSignal.timeout(10_000));

    if (error) throw error;
    return (data || []) as HermesInstanceRow[];
  }

  async updateInstance(expected: HermesInstanceRow, patch: Partial<HermesInstanceRow>): Promise<boolean> {
    return this.compareAndSwap("hermes_instances", expected, patch);
  }

  private additionalSecretConfig(surface: AdditionalSecretSurface) {
    return ({
      hivra_agents_llm: { table: "hivra_agents", id: "id", column: "llm_api_key_encrypted", agentRpc: true },
      infrastructure_capacity_orders_bootstrap: { table: "infrastructure_capacity_orders", id: "id", column: "encrypted_bootstrap_bundle" },
      bankr_deposit_wallet_credentials_key: { table: "bankr_deposit_wallet_credentials", id: "id", column: "api_key_encrypted" },
      instance_bankr_wallets_key: { table: "instance_bankr_wallets", id: "id", column: "api_key_encrypted" },
    } as const)[surface];
  }

  async listAdditionalSecrets(
    surface: AdditionalSecretSurface,
    afterId: string | null,
    limit: number,
  ): Promise<AdditionalSecretRow[]> {
    const config = this.additionalSecretConfig(surface);
    let query = this.supabase.from(config.table)
      .select(`${config.id},${config.column}`)
      .order(config.id, { ascending: true })
      .limit(limit);
    if (afterId !== null) query = query.gt(config.id, afterId);
    const { data, error } = await query.abortSignal(AbortSignal.timeout(10_000));
    if (error) throw error;
    return (data || []).map((row) => ({
      id: String((row as Record<string, unknown>)[config.id]),
      encrypted_value: ((row as Record<string, unknown>)[config.column] ?? null) as string | null,
    }));
  }

  async updateAdditionalSecret(
    surface: AdditionalSecretSurface,
    expected: AdditionalSecretRow,
    encryptedValue: string,
  ): Promise<boolean> {
    const config = this.additionalSecretConfig(surface);
    const procedureName = surface === "hivra_agents_llm"
      ? "rotate_hivra_agent_llm_secret"
      : "rewrap_encryption_surface_v2";
    const args = surface === "hivra_agents_llm"
      ? { p_id: expected.id, p_expected: expected.encrypted_value, p_replacement: encryptedValue }
      : { p_surface: surface, p_id: expected.id,
          p_expected: { [config.column]: expected.encrypted_value }, p_patch: { [config.column]: encryptedValue } };
    const { data, error } = await this.supabase.rpc(procedureName, args).abortSignal(AbortSignal.timeout(10_000));
    if (error || typeof data !== "boolean") throw new Error("Additional secret rewrap did not return an authoritative result");
    return data;
  }

  async listConversations(afterId: string | null, limit: number): Promise<ConversationRow[]> {
    let query = this.supabase
      .from("hermes_conversations")
      .select("id,title")
      .order("id", { ascending: true })
      .limit(limit);
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query.abortSignal(AbortSignal.timeout(10_000));

    if (error) throw error;
    return (data || []) as ConversationRow[];
  }

  async updateConversation(expected: ConversationRow, patch: Partial<ConversationRow>): Promise<boolean> {
    return this.compareAndSwap("hermes_conversations", expected, patch);
  }

  async listMessages(afterId: string | null, limit: number): Promise<MessageRow[]> {
    let query = this.supabase
      .from("hermes_messages")
      .select("id,content,tool_calls,attachments,artifacts,metadata")
      .order("id", { ascending: true })
      .limit(limit);
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query.abortSignal(AbortSignal.timeout(10_000));

    if (error) throw error;
    return (data || []) as MessageRow[];
  }

  async updateMessage(expected: MessageRow, patch: Partial<MessageRow>): Promise<boolean> {
    return this.compareAndSwap("hermes_messages", expected, patch);
  }

  async listChatStreamJobs(afterId: string | null, limit: number): Promise<ChatStreamJobRow[]> {
    let query = this.supabase.from("hermes_chat_stream_jobs")
      .select("id,stream_request,fallback_request")
      .order("id", { ascending: true })
      .limit(limit);
    if (afterId !== null) query = query.gt("id", afterId);
    const { data, error } = await query.abortSignal(AbortSignal.timeout(10_000));
    if (error) throw error;
    return (data || []) as ChatStreamJobRow[];
  }

  async updateChatStreamJob(expected: ChatStreamJobRow, patch: Partial<ChatStreamJobRow>): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("rewrap_encryption_surface_v2", {
      p_surface: "hermes_chat_stream_jobs",
      p_id: expected.id,
      p_expected: { stream_request: expected.stream_request, fallback_request: expected.fallback_request },
      p_patch: patch,
    }).abortSignal(AbortSignal.timeout(10_000));
    if (error || typeof data !== "boolean") throw new Error("Chat stream rewrap did not return an authoritative result");
    return data;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { dryRun, batchSize, coverageOnly, help } = parseArgs(argv);
  if (help) {
    console.log([
      "Usage: npm run rotate:encryption-keys -- [--dry-run | --coverage-only | --apply] [--batch-size 1..1000]",
      "Default: read-only inspection of legacy encrypted rows and known unhandled dependencies.",
      "--coverage-only: bounded count-only reads; does not load ciphertext or require encryption keys.",
      "--apply: partial legacy rewrap only; blocked by present/unknown unhandled dependencies.",
      "Legacy row writes use compare-and-swap and a stable cursor; concurrent conflicts need fresh inspection.",
      "No mode proves full rotation, backup recovery, or safe retirement of an old key.",
    ].join("\n"));
    return 0;
  }
  loadEnvConfig(process.cwd());
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const store = new SupabaseEncryptionRotationStore(supabase);
  if (coverageOnly) {
    const coverage = await inspectRotationCoverage((dependency) => store.countUnhandledValues(dependency));
    console.log(formatRotationCoverage(coverage));
    return coverage.blocksApply ? 2 : 0;
  }
  const summary = await runEncryptionKeyRotation(store, {
    dryRun,
    batchSize,
    logger: console.log,
  });

  console.log(formatRotationSummary(summary));

  return summary.failures.length > 0 ? 1 : summary.coverage.blocksApply ? 2 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    // Database errors can contain submitted ciphertext, URLs or row contents.
    console.error("Encryption inspection/rewrap failed. Check configuration and --help; retain all recovery keys.");
    process.exitCode = 1;
  });
}
