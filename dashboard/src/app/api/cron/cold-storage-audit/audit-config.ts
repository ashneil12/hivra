export function resolveColdStorageAuditHost(
  env: Record<string, string | undefined> = process.env
): string | null {
  return env.COLD_STORAGE_AUDIT_HOST?.trim() || null;
}
