import type { DeploymentTargetDto } from "./contracts";

export type MeasuredTargetCapacity = {
  cpu: number;
  ramGb: number;
};

/** What a ready target last reported it can hold: its cores and its
 * available memory rounded down to whole GB. Missing evidence is zero, so an
 * unmeasured host never looks roomier than it is. */
export function measuredTargetCapacity(
  target: DeploymentTargetDto | null,
): MeasuredTargetCapacity {
  const availableMemoryBytes = target?.capacity.memoryBytes.available ?? null;
  return {
    cpu: target?.capacity.cpu.totalCores ?? 0,
    ramGb: availableMemoryBytes === null
      ? 0
      : Math.floor(availableMemoryBytes / 1024 ** 3),
  };
}
