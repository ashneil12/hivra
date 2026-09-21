import { z } from "zod";

// This is navigation intent only. Connection authority and revision must come
// from the current, owner-scoped target lookup, never from query parameters.
export type LaunchTargetHandoff = { key: string; targetId: string | null };

export function parseLaunchTargetHandoff(values: readonly string[]): LaunchTargetHandoff | null {
  if (values.length === 0) return null;
  const parsed = values.length === 1 ? z.string().uuid().safeParse(values[0]) : null;
  return { key: JSON.stringify(values), targetId: parsed?.success ? parsed.data.toLowerCase() : null };
}
