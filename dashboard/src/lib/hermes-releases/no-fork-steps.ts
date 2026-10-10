import type { NoForkMigrationPhase } from "@/lib/services/no-fork-migration-builder";

/** What the box's status file means in plain English, with the five steps the card lists. */
export const NOFORK_STEPS: ReadonlyArray<{ phase: NoForkMigrationPhase; label: string }> = [
  { phase: "preflight", label: "Checking your agent is ready" },
  { phase: "snapshot", label: "Backing up everything you own" },
  { phase: "switching", label: "Installing the new version" },
  { phase: "verifying", label: "Checking your chats, memory, skills and files are all still there" },
  { phase: "finishing", label: "Turning on updates straight from Hermes" },
];
