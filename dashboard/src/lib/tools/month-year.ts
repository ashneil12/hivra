const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * "2026-09-30" -> "September 2026". Reader copy shows when facts were checked as a month, never a day stamp
 * (Ash's date rule, 2026-10-06). Event dates that matter keep their day elsewhere.
 */
export function monthYear(iso: string): string {
  const [year, month] = iso.split("-").map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}
