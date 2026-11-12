// Off-by-default switch for the "run Claude and Gemini managed agents on your own
// computer" guide. It stays off until both workers have been run on a real Hivra
// computer. NEXT_PUBLIC so the value is inlined at build time; read it by its
// literal name.

export const MANAGED_AGENTS_GUIDE_SLUG = "run-managed-agents-on-your-own-computer";

export function isManagedAgentsGuideEnabled(
  value: string | undefined = process.env.NEXT_PUBLIC_HIVRA_MANAGED_AGENTS_GUIDE,
): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}
