// ram_cap_hit is a platform monitoring decision, not evidence of an OS OOM kill.
export const MEMORY_PAUSE_TITLE = "Paused for high memory use";

export function memoryPauseMessage(ramLimitMb?: number | null): string {
  const allocation = typeof ramLimitMb === "number" && Number.isFinite(ramLimitMb) && ramLimitMb > 0
    ? ` of its ${ramLimitMb >= 1024 ? `${Number((ramLimitMb / 1024).toFixed(2))} GB` : `${ramLimitMb} MB`} memory allocation`
    : " of its memory allocation";
  return `The platform paused this agent because recent monitoring showed high use${allocation}. This is a memory safeguard, not a usage-time limit or confirmation of an out-of-memory crash. Review the workload or allocated resources before restarting; it may pause again if memory use stays high.`;
}
