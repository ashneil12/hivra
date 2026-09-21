import { createHash } from "node:crypto";

export interface ManagedVeniceUpstreamKeyInput {
  referenceId?: string | null;
  proxyKeyId?: string | null;
  model?: string | null;
  endpoint?: string | null;
}

export interface ManagedVeniceResolvedUpstreamKey {
  key: string;
  source: "pool" | "legacy";
  index: number;
  poolSize: number;
}

function normalizeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function parseManagedVeniceInferenceKeys(
  env: Record<string, string | undefined> = process.env
): string[] {
  const raw = env.MANAGED_VENICE_INFERENCE_KEYS?.trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeKey).filter((key): key is string => Boolean(key));
    }
    if (parsed && typeof parsed === "object") {
      return Object.values(parsed as Record<string, unknown>)
        .map(normalizeKey)
        .filter((key): key is string => Boolean(key));
    }
  } catch {
    // Fall through to operator-friendly comma/newline parsing.
  }

  return raw
    .split(/[\n,]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}

function choosePoolIndex(input: ManagedVeniceUpstreamKeyInput, poolSize: number) {
  const seed = [
    input.referenceId,
    input.proxyKeyId,
    input.model,
    input.endpoint,
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\u001f");

  const digest = createHash("sha256").update(seed || "managed-venice").digest();
  return digest.readUInt32BE(0) % poolSize;
}

export function resolveManagedVeniceUpstreamKey(
  input: ManagedVeniceUpstreamKeyInput,
  env: Record<string, string | undefined> = process.env
): ManagedVeniceResolvedUpstreamKey | null {
  const pool = parseManagedVeniceInferenceKeys(env);
  if (pool.length > 0) {
    const index = choosePoolIndex(input, pool.length);
    return { key: pool[index], source: "pool", index, poolSize: pool.length };
  }

  const legacyKey = normalizeKey(env.VENICE_API_KEY);
  if (!legacyKey) return null;
  return { key: legacyKey, source: "legacy", index: 0, poolSize: 1 };
}
