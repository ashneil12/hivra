const DAY_IN_MS = 24 * 60 * 60 * 1000;

export const HACKATHON_PROMO_NAME = "Hermes Agent Creative Hackathon";
const HACKATHON_PROMO_PLAN_KEY = "operator";
export const HACKATHON_PROMO_END_LABEL = "May 4";
export const HACKATHON_PROMO_END_FULL_LABEL = "May 4, 2026";
export const HACKATHON_PROMO_CUTOFF_ISO = "2026-05-04T23:59:00.000Z";
export const HACKATHON_PROMO_CTA = "Claim Hackathon Access";
export const HACKATHON_PROMO_TRIAL_DAYS = 17;

export function isHackathonPromoPlan(planKey: string) {
  return planKey === HACKATHON_PROMO_PLAN_KEY;
}

export function isHackathonPromoActive(now = new Date()) {
  return now.getTime() < new Date(HACKATHON_PROMO_CUTOFF_ISO).getTime();
}

export function getHackathonPromoTrialDays(planKey: string, now = new Date()) {
  if (!isHackathonPromoPlan(planKey) || !isHackathonPromoActive(now)) {
    return null;
  }

  return HACKATHON_PROMO_TRIAL_DAYS;
}

export function getHackathonCountdownParts(now = new Date()) {
  const cutoff = new Date(HACKATHON_PROMO_CUTOFF_ISO).getTime();
  const distance = Math.max(0, cutoff - now.getTime());

  return {
    days: Math.floor(distance / DAY_IN_MS),
    hours: Math.floor((distance % DAY_IN_MS) / (60 * 60 * 1000)),
    minutes: Math.floor((distance % (60 * 60 * 1000)) / (60 * 1000)),
    seconds: Math.floor((distance % (60 * 1000)) / 1000),
    expired: distance <= 0,
  };
}
