/**
 * Rotate a work list by the scan-tick bucket so budget-bounded loops walk
 * their tail across passes: a fixed order would starve whichever items
 * land outside the window every tick — their incidents could then never
 * open or resolve — while the rotated order periodically brings every
 * item inside it.
 *
 * Shared by every scan/sweep that bounds per-tick work below the full
 * candidate set (the customer-incident scan's probe/report/resolve
 * windows, the surface-watchdog sweep's 500-box window): the bound stays
 * per-run, but which slice lands inside it moves with the tick.
 */
export function rotateByScanTick<T>(items: T[], scanTick: number): T[] {
  return items.length > 1
    ? [
        ...items.slice(scanTick % items.length),
        ...items.slice(0, scanTick % items.length),
      ]
    : items;
}
