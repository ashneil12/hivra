import type { ComparePage } from "./types";
import { GENERAL_COMPARISONS } from "./general-comparisons";
import { HOST_COMPARISONS } from "./host-comparisons";

/** Every /compare/[slug] page, keyed by slug. */
export const COMPARE_PAGES: Record<string, ComparePage> = { ...GENERAL_COMPARISONS, ...HOST_COMPARISONS };

export const COMPARE_PAGE_SLUGS = Object.keys(COMPARE_PAGES);
