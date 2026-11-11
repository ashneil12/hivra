import type { PromoReport } from "./report";

function usd(micro: number) {
  return `$${(micro / 1_000_000).toFixed(2)}`;
}

/** The plain-text body of the weekly ops_events row. */
export function summarizePromoReport(report: PromoReport): string {
  const lines = report.campaigns.map(
    (c) =>
      `${c.slug}: ${c.grants} grants (${c.grantsInWindow} this week), granted ${usd(c.grantedMicroUsd)}, ` +
      `spent ${usd(c.spentMicroUsd)}, expired ${usd(c.expiredMicroUsd)}, budget left ${usd(c.budgetLeftMicroUsd)}`
  );
  lines.push(
    `Credits-mode launches this week: ${report.creditsModeLaunchUsers} users. ` +
      `Active after 7d: ${report.promoUsers.active7.active}/${report.promoUsers.active7.eligible}, ` +
      `after 30d: ${report.promoUsers.active30.active}/${report.promoUsers.active30.eligible}. ` +
      `Paid top-up after grant: ${report.promoUsers.paidTopupAfterGrant}.`
  );
  return lines.join("\n");
}
