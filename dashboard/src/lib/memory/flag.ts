/**
 * Hivra Memory (free cloud memory for any agent) is a preview: the public
 * /memory page, /dashboard/memory and /api/memory all 404 unless this is on.
 */
export function isHivraMemoryEnabled(value: string | undefined = process.env.NEXT_PUBLIC_HIVRA_MEMORY): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}
