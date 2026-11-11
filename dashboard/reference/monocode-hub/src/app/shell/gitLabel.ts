/**
 * The branch line on a session card: "repo/branch", or just one of them. r94 (Critiquito c, s15 3cde: the Sessions panel
 * read "Tally · mc-30bae317/mc/ill-look-at-the-board-heading-…"): a worker's checkout the app made ("mc-<hex>" folder,
 * "mc/<slug>" branch) is an id, not a name Ash gave anything, so the card shows the project alone instead.
 */
const APP_CHECKOUT = /^mc-[0-9a-f]{6,}$/i;
const APP_BRANCH = /^mc\//i;

export function formatGitLabel(repo?: string, branch?: string): string {
  if ((repo && APP_CHECKOUT.test(repo)) || (branch && APP_BRANCH.test(branch))) return "";
  if (repo && branch) return `${repo}/${branch}`;
  return branch || repo || "";
}
