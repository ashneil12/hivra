// What a maker's claim on a catalog page looks like to the page that shows it.
// Types and fixed words only, so both the server and the browser can read it.

import type { LaunchProfileId } from "@/lib/launch/contracts";

/** Where the proof lives in the maker's repository, on its default branch. */
export const CLAIM_FILE_PATH = ".well-known/hivra.txt";

export type ClaimCheckResult = "verified" | "file_missing" | "line_missing" | "unreachable";

export interface MakerNumbers {
  /** The numbers cover this many days up to now. */
  days: number;
  /** People with at least one hour in which the agent was in use. */
  people: number;
  /** Launches that finished. */
  launches: number;
  /** Hours in which the agent was in use. */
  activeHours: number;
  runningNow: number;
  /** Agents launched early enough to have had two weeks, and how many of them were kept that long. */
  twoWeekLaunches: number;
  twoWeekKept: number;
}

export interface CatalogClaimView {
  profileId: LaunchProfileId;
  name: string;
  /** The repository the proof is read from (owner/name), or null when this page cannot be claimed. */
  repo: string | null;
  filePath: string;
  /** True once anyone has proved they make it. */
  claimed: boolean;
  /** The signed-in person's own claim. */
  mine: {
    status: "pending" | "verified";
    /** The line to put in the file. */
    line: string;
    lastCheck: ClaimCheckResult | null;
    checkedAt: string | null;
    verifiedAt: string | null;
  } | null;
  /** Only for the person whose claim is proven. */
  numbers: MakerNumbers | null;
}

/** The maker's own page for a catalog entry. */
export function makerPageHref(profileId: LaunchProfileId): string {
  return `/dashboard/makers/${profileId}`;
}

/** A catalog entry's page in Launch, on a fresh draft. */
export function catalogPageHref(profileId: LaunchProfileId): string {
  return `/dashboard/launch?start=1&about=${profileId}`;
}
