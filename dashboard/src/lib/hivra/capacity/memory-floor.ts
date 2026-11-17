/**
 * The memory floor of one computer: the least memory the host may ever leave
 * it with (the VM's `balloon` minimum). The host only takes memory above the
 * floor, and only when the host itself is short.
 *
 * The floor follows what the computer was measured to use, without its file
 * cache: twice its peak, plus a fixed margin (a lower factor was seen to push
 * a test computer into swap). A computer that
 * uses most of its memory keeps all of it. Pure: no clock, no I/O.
 */

/** No computer is ever left with less than this. */
export const MEMORY_FLOOR_MIN_MB = 1024;
/** Fixed margin on top of the scaled peak. */
export const MEMORY_FLOOR_MARGIN_MB = 512;
/** The measured peak is multiplied by this. */
export const MEMORY_FLOOR_PEAK_FACTOR = 2;
/** A floor at or above this share of the computer's memory is not worth setting: it keeps everything. */
export const MEMORY_FLOOR_KEEP_ALL_SHARE = 0.9;
/** Fewer samples than this, or a shorter span, is not enough to judge a peak. */
export const MEMORY_FLOOR_MIN_SAMPLES = 100;
export const MEMORY_FLOOR_MIN_SPAN_HOURS = 24;
/** Floors are whole steps of this size. */
const STEP_MB = 64;

export type MemoryFloorInput = {
  /** The computer's configured memory (the VM's `memory`). */
  memoryMb: number;
  /** The highest memory in use without file cache that was measured, or null when never measured. */
  peakUsedMb: number | null;
  samples: number;
  /** Hours between the first and the last sample. */
  spanHours: number;
};

export type MemoryFloorVerdict = {
  /** The floor to set. Equal to memoryMb when the computer keeps everything. */
  floorMb: number;
  reason: "measured" | "keeps_all" | "too_small" | "not_enough_samples" | "invalid";
};

/** The floor for one computer. Anything unknown or odd keeps the computer's full memory. */
export function memoryFloorFor(input: MemoryFloorInput): MemoryFloorVerdict {
  const memoryMb = Math.floor(input.memoryMb);
  if (!Number.isFinite(memoryMb) || memoryMb <= 0) return { floorMb: 0, reason: "invalid" };
  const keepAll = (reason: MemoryFloorVerdict["reason"]): MemoryFloorVerdict => ({ floorMb: memoryMb, reason });
  if (memoryMb <= MEMORY_FLOOR_MIN_MB) return keepAll("too_small");
  const peak = input.peakUsedMb;
  if (peak === null || !Number.isFinite(peak) || peak <= 0 || peak > memoryMb * 1.05) return keepAll("not_enough_samples");
  if (!(input.samples >= MEMORY_FLOOR_MIN_SAMPLES) || !(input.spanHours >= MEMORY_FLOOR_MIN_SPAN_HOURS)) {
    return keepAll("not_enough_samples");
  }
  const wanted = Math.max(MEMORY_FLOOR_MIN_MB, peak * MEMORY_FLOOR_PEAK_FACTOR + MEMORY_FLOOR_MARGIN_MB);
  const floorMb = Math.ceil(wanted / STEP_MB) * STEP_MB;
  if (floorMb >= memoryMb * MEMORY_FLOOR_KEEP_ALL_SHARE) return keepAll("keeps_all");
  return { floorMb, reason: "measured" };
}
