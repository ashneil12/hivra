// Persistence for the instance-page "Standing tasks" nudge.
//
// Previously the dismissal lived in React state only, so any reload (or simply
// revisiting the instance) brought the banner straight back. We persist a
// single global flag in localStorage: once the user dismisses the nudge they
// have seen the feature, and there is no reason to re-pitch it — on this or any
// other instance.
//
// Framework-free + best-effort: a blocked or unavailable localStorage (SSR,
// private mode) never throws, it just means the choice isn't remembered. The
// instance page only renders the banner after its `loading` gate clears (well
// past hydration), so reading storage during state init is safe.

export const STANDING_TASKS_NUDGE_DISMISSED_KEY = 'hivra_standing_tasks_nudge_dismissed';

/** True when the user has previously dismissed the standing-tasks nudge. */
export function readStandingTasksNudgeDismissed(): boolean {
  try {
    return window.localStorage.getItem(STANDING_TASKS_NUDGE_DISMISSED_KEY) === '1';
  } catch {
    return false; // SSR / private mode — default to showing once.
  }
}

/** Persist the dismissal so the nudge stays hidden across reloads. */
export function dismissStandingTasksNudge(): void {
  try {
    window.localStorage.setItem(STANDING_TASKS_NUDGE_DISMISSED_KEY, '1');
  } catch {
    // Best-effort: a blocked localStorage just means it isn't remembered.
  }
}
