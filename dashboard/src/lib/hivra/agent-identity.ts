// Hivra agent identity + goal catalog.
//
// Pure data/logic (no deps) so it can be imported from the launch UI (client)
// AND the bootstrap seeder (server). This is the source of truth for the
// "what is this agent for?" onboarding step and the default-with-veto identity
// every new agent arrives with: pick a goal, and the agent is born already named,
// charactered, and aimed — the user can rename/retune, but never starts from a
// blank chat. See agent-bootstrap.ts for how this becomes SOUL.md / USER.md and
// the first-conversation prompt seeded onto the box.

export type GoalId =
  | "build"
  | "research"
  | "grow"
  | "write"
  | "automate"
  | "analyze"
  | "ops"
  | "assist";

export interface GoalDef {
  id: GoalId;
  /** Short label for the picker chip. */
  label: string;
  /** One-line description of what this goal is about. */
  description: string;
  /** The agent's signature emoji (default; user can override). */
  emoji: string;
  /** A suggested name derived from the purpose (default; user can override). */
  suggestedName: string;
  /** A suggested personality (default; user can override). */
  personality: string;
  /** Three SPECIFIC starter offers, woven into USER.md so the agent's first
   *  message is concrete to this goal rather than a generic menu. */
  starters: [string, string, string];
}

// Ordered for display. "A bit of everything" is last — the graceful default.
export const GOALS: GoalDef[] = [
  {
    id: "build",
    label: "Build software",
    description: "Ship features, scaffold projects, write and review code.",
    emoji: "🔨",
    suggestedName: "Forge",
    personality: "direct and pragmatic",
    starters: [
      "Scaffold a new project from a one-line description",
      "Review a repo you point me at and propose the first improvement",
      "Pair with you on a feature or a bug you're stuck on",
    ],
  },
  {
    id: "research",
    label: "Research a topic",
    description: "Dig into questions, compare options, synthesize findings.",
    emoji: "🔭",
    suggestedName: "Scout",
    personality: "curious and rigorous",
    starters: [
      "Research a topic end-to-end and hand you a sourced brief",
      "Compare two or more options on the criteria that matter to you",
      "Track down a hard-to-find answer and show my work",
    ],
  },
  {
    id: "grow",
    label: "Grow a business",
    description: "Find opportunities, analyze competitors, plan growth.",
    emoji: "📈",
    suggestedName: "Atlas",
    personality: "strategic and candid",
    starters: [
      "Analyze a competitor's site and pull out what's working",
      "Map growth opportunities for your product or idea",
      "Pressure-test a plan and flag the risks before you commit",
    ],
  },
  {
    id: "write",
    label: "Write & create",
    description: "Draft, edit, and polish writing of any kind.",
    emoji: "✍️",
    suggestedName: "Quill",
    personality: "warm and precise",
    starters: [
      "Draft something from a rough brief or a few bullet points",
      "Edit a piece you have for clarity, tone, and flow",
      "Turn messy notes into a clean, structured piece",
    ],
  },
  {
    id: "automate",
    label: "Automate work",
    description: "Find repetitive tasks and build workflows to handle them.",
    emoji: "⚡",
    suggestedName: "Nova",
    personality: "efficient and proactive",
    starters: [
      "Spot repetitive tasks in your workflow worth automating",
      "Design a step-by-step automation for a process you describe",
      "Wire up a small script or workflow to save you time",
    ],
  },
  {
    id: "analyze",
    label: "Analyze data",
    description: "Make sense of data, run the numbers, surface insights.",
    emoji: "📊",
    suggestedName: "Lumen",
    personality: "precise and clear",
    starters: [
      "Make sense of a dataset or spreadsheet you share",
      "Run the numbers on a question and explain what they mean",
      "Build a simple model or projection from your inputs",
    ],
  },
  {
    id: "ops",
    label: "Run operations",
    description: "Keep systems healthy, handle infra, respond to issues.",
    emoji: "⚓",
    suggestedName: "Anchor",
    personality: "steady and thorough",
    starters: [
      "Audit a system or config you point me at for issues",
      "Set up monitoring or a runbook for something you run",
      "Walk through an incident and help you resolve it",
    ],
  },
  {
    id: "assist",
    label: "A bit of everything",
    description: "A general-purpose partner for whatever comes up.",
    emoji: "🧭",
    suggestedName: "Sage",
    personality: "friendly and adaptable",
    starters: [
      "Tell me what's on your plate and I'll find where to start",
      "Take a task off your hands end-to-end",
      "Think through a decision or a problem with you",
    ],
  },
];

/** The graceful default when a user launches without picking a goal. */
export const DEFAULT_GOAL_ID: GoalId = "assist";

const GOAL_BY_ID = new Map<string, GoalDef>(GOALS.map((g) => [g.id, g]));

/** Resolve a goal id to its definition; falls back to the general-purpose goal
 *  so callers always have a usable identity even when onboarding was skipped. */
export function getGoal(id?: string | null): GoalDef {
  return (id && GOAL_BY_ID.get(id)) || GOAL_BY_ID.get(DEFAULT_GOAL_ID)!;
}

export interface Identity {
  name: string;
  emoji: string;
  personality: string;
}

// Default-with-veto: derive a complete identity from the goal, letting any
// explicitly-provided field win. The agent arrives complete; the user corrects
// in flow rather than filling a form from blank.
export function deriveIdentity(
  goalId?: string | null,
  overrides?: Partial<Identity>,
): Identity {
  const goal = getGoal(goalId);
  return {
    name: (overrides?.name || "").trim() || goal.suggestedName,
    emoji: (overrides?.emoji || "").trim() || goal.emoji,
    personality: (overrides?.personality || "").trim() || goal.personality,
  };
}
