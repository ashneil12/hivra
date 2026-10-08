// The call to action beside the keep-awake result. It changes with the result:
// when a plugged-in laptop with the command is enough, the page says so and
// only points at the survival check. When the laptop would have to stay open
// and plugged in to keep the run alive, it offers a computer that stays on.

import type { KeepAwakeResult } from "./keep-awake";
import { PLAN_LINE, agentButton, ctaAgentFor, tmuxOnHivraSentence, type CtaAgent } from "./agent-cta";
import { toolPath } from "./tool-catalog";

export type KeepAwakeCtaState = "enough" | "stays-on";

export interface KeepAwakeCta {
  state: KeepAwakeCtaState;
  agent: CtaAgent;
  text: string;
  /** The Hivra button. Null when the laptop is enough, because no product push is honest there. */
  button: { label: string; href: string } | null;
  /** Always present: the free check of the whole setup. */
  survivalCheck: { label: string; href: string };
}

export function keepAwakeCta(result: KeepAwakeResult): KeepAwakeCta {
  const agent = ctaAgentFor(result.input.command);
  const survivalCheck = {
    label: "Check the whole setup with the agent survival check",
    href: toolPath("agent-survival-check"),
  };
  // A laptop that stays plugged in and is covered by the command is enough.
  if (result.input.power === "plugged" && result.verdict.level === "works") {
    return {
      state: "enough",
      agent,
      text: "A laptop that stays plugged in, with this command running, is enough for a run you can keep an eye on. It costs nothing. The limits below still apply.",
      button: null,
      survivalCheck,
    };
  }
  return {
    state: "stays-on",
    agent,
    text: `If the laptop has to stay open and plugged in, run the agent on a computer that stays on instead. ${tmuxOnHivraSentence(agent)} ${PLAN_LINE}`,
    button: agentButton(agent),
    survivalCheck,
  };
}
