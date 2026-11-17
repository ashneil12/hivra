// What the memory Worker (services/memory-worker) allows and what was
// measured on it. Kept in one place so the public page and the dashboard say
// the same thing. The limits mirror the Worker's wrangler.toml.

export const MEMORY_MAX_ITEMS = 10_000;
export const MEMORY_MAX_CHARACTERS = 4_000;

/** Share of questions whose answer was in the first ten results, LoCoMo benchmark, 17 Nov 2026. */
export const MEMORY_RECALL_AT_10 = { meaning: 76, keywordOnly: 64 } as const;

/** Measured against the live service, 17 Nov 2026. */
export const MEMORY_TYPICAL_MS = 220;

/** Where a public "get started" link goes: sign up (straight through when signed in), then the memory page. */
export const MEMORY_START_HREF = "/sign-up?next=memory";
