// Detector for the "managed-Venice revenue stream silently went to zero" class.
// The Jun-2026 cliff (the hermesos.cloud→hivra.cloud 301 that killed every baked
// proxy URL) sat undetected for 9 days precisely because nothing watched the
// aggregate: usage_events fell from 3,000+/day to ~6/day overnight and no alert
// fired. This is the guard so it can never go dark unnoticed again.
//
// The signal is a RELATIVE collapse, not an absolute floor — "boxes exist but
// usage is zero" alone would false-positive on a legitimately idle fleet (e.g.
// after users churn). We only page when a MEANINGFUL trailing baseline collapses,
// so the detector stays silent while usage is flat-but-low and re-arms itself
// once real usage returns.

// Trailing daily average (events/day, over the baseline window) below which we
// assume there was never enough activity to call a "collapse". Keeps the
// detector quiet on brand-new or wound-down deployments.
export const MIN_BASELINE_DAILY_EVENTS = 200;

// Recent window must fall to <=10% of the baseline daily rate to count as a
// collapse. A 90% drop is far outside normal day-to-day variance for a stream
// that was doing thousands/day, but well clear of weekend/diurnal dips.
const COLLAPSE_RATIO = 0.1;

export interface UsageFlatlineInput {
  // Recorded managed-Venice usage events in the last 24h.
  recent24hEvents: number;
  // Recorded events across the trailing baseline window, EXCLUDING the last 24h.
  baselineWindowEvents: number;
  // Length of that baseline window in days (so we can derive a daily average).
  baselineWindowDays: number;
}

export interface UsageFlatlineResult {
  flatline: boolean;
  baselineDailyAvg: number;
  collapseThreshold: number;
  reason: string;
}

// Pure decision so the threshold logic is unit-testable without a database.
export function evaluateManagedVeniceUsage(input: UsageFlatlineInput): UsageFlatlineResult {
  const days = input.baselineWindowDays > 0 ? input.baselineWindowDays : 1;
  const baselineDailyAvg = input.baselineWindowEvents / days;
  const collapseThreshold = baselineDailyAvg * COLLAPSE_RATIO;

  if (baselineDailyAvg < MIN_BASELINE_DAILY_EVENTS) {
    return {
      flatline: false,
      baselineDailyAvg,
      collapseThreshold,
      reason: `baseline ${baselineDailyAvg.toFixed(1)}/day below floor ${MIN_BASELINE_DAILY_EVENTS}/day — too quiet to judge a collapse`,
    };
  }

  if (input.recent24hEvents <= collapseThreshold) {
    return {
      flatline: true,
      baselineDailyAvg,
      collapseThreshold,
      reason: `last-24h usage ${input.recent24hEvents} collapsed to <=${collapseThreshold.toFixed(1)} (10% of the ${baselineDailyAvg.toFixed(1)}/day baseline)`,
    };
  }

  return {
    flatline: false,
    baselineDailyAvg,
    collapseThreshold,
    reason: `last-24h usage ${input.recent24hEvents} healthy vs ${baselineDailyAvg.toFixed(1)}/day baseline`,
  };
}
