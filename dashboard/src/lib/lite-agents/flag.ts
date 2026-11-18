// Off-by-default switch for the free Lite cloud agent. Client-safe: the
// NEXT_PUBLIC value is inlined at build time, so read it by its literal name.

export function isFreeCloudAgentEnabled(
  value: string | undefined = process.env.NEXT_PUBLIC_HIVRA_FREE_CLOUD_AGENT,
): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}
