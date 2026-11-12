// The agent tools' catalog entries, one file per tool. Imported by tool-catalog.ts, which adds them
// to TOOL_ENTRIES only while NEXT_PUBLIC_HIVRA_AGENT_TOOLS_ENABLED is on. Entry files import types
// from ../tool-catalog (type-only, erased at build) and never its values, so there is no cycle.

import type { ToolEntry } from "../tool-catalog";
import { AGENT_PICKER_ENTRY } from "./agent-picker-entry";
import { AGENT_RUNNING_COST_ENTRY } from "./agent-running-cost-entry";
import { AGENT_MODEL_FINDER_ENTRY } from "./agent-model-finder-entry";
import { AGENT_JOB_LIBRARY_ENTRY } from "./agent-job-library-entry";
import { BOT_CONNECT_WIZARD_ENTRY } from "./bot-connect-wizard-entry";
import { AGENT_SECURITY_CHECK_ENTRY } from "./agent-security-check-entry";
import { SOUL_MD_BUILDER_ENTRY } from "./soul-md-builder-entry";

export const AGENT_TOOL_ENTRIES: ToolEntry[] = [
  AGENT_PICKER_ENTRY,
  AGENT_RUNNING_COST_ENTRY,
  AGENT_MODEL_FINDER_ENTRY,
  AGENT_JOB_LIBRARY_ENTRY,
  BOT_CONNECT_WIZARD_ENTRY,
  AGENT_SECURITY_CHECK_ENTRY,
  SOUL_MD_BUILDER_ENTRY,
];
