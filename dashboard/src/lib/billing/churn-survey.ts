/**
 * Churn-survey contract shared by the cancel save-flow modal
 * (components/billing/CancelSaveFlow.tsx) and POST /api/billing/churn-survey.
 * Lives outside the route file because Next.js route modules may only export
 * handlers/config.
 */

import { z } from "zod";

const CHURN_SURVEY_REASONS = [
  "too_expensive",
  "not_using",
  "missing_feature",
  "something_broke",
  "other",
] as const;

export type ChurnSurveyReason = (typeof CHURN_SURVEY_REASONS)[number];

export const ChurnSurveySchema = z.object({
  reason: z.enum(CHURN_SURVEY_REASONS),
  detail: z.string().trim().max(2000).optional(),
});
