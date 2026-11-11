import { dropContextWindow, type ContextUsage } from "./contextUsage";
import { listTitle } from "../../../shared/text/plainTitle";
import type { UserQuestionPrompt } from "./userQuestion";
import type { ProviderErrorClass } from "../../../integrations/harness/core/types";
import type { HandoffComposerCard } from "./handoff";
import type { InboxComposerCard } from "../../inbox/model/githubTasks";
import type { InboxAskContext } from "../../inbox/model/inboxAsk";
import type { NoteCardMeta, NoteComposerCard } from "../../notes";
import type { OrchestrationProposal } from "../../orchestration/model/orchestrationPlan";
import type { LinkedWorkItemUpdateCard } from "../../inbox/model/linkedWorkItemActivity";
import {
  defaultSessionChoice,
  folderDefaultChoice,
  firstEnabledHarness,
  preferredModelId,
  preferredModelSettings,
  resolveModel,
} from "./models";
import { loadProjectProviderSettings } from "./projectProviders";

export type HarnessId =
  | "claude"
  | "codex"
  | "cursor"
  | "grok"
  | "opencode"
  | "pi"
  | "omp"
  | "fx"
  | "antigravity"
  | "devin";

export const HARNESSES: HarnessId[] = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "pi",
  "omp",
  "fx",
  "antigravity",
  "devin",
];

export type BlockRole =
  | "user"
  | "assistant"
  | "image"
  | "reasoning"
  | "tool"
  | "approval"
  | "tasks"
  | "plan"
  | "system"
  | "handoff";

/** A session created by a Mono during this conversation turn. */
export type MonoSpawnedSession = {
  sessionId: string;
  cwd: string;
  title: string;
  harness: HarnessId;
  model: string;
  /** The reasoning effort it runs at, as the picker words it, when its model offers one. */
  effort?: string;
};

export type TaskListItemStatus =
  "pending" | "in_progress" | "completed" | "cancelled";

export type TaskListItem = {
  /** Stable provider identity, when available, for merging status-only updates. */
  id?: string;
  text: string;
  status: TaskListItemStatus;
};

export type TaskListMeta = {
  /** Provider identity for replacing later snapshots of the same list. */
  key?: string;
  /** Provider conversation that produced this list, when the provider scopes task ids to one. */
  providerSessionId?: string;
  explanation?: string;
  items: TaskListItem[];
};

/** One-shot behavior selected in the composer for the next harness turn. */
export type TurnIntent = "default" | "plan" | "build" | "orchestrate";
export type EditedResendRejection = {
  /** The provider removed the old turn, so retry as a normal unsent prompt. */
  providerRewound: boolean;
};
export type ComposerTurnOptions = {
  intent?: TurnIntent;
  resendEdited?: boolean;
  /** Restore an edited prompt when the resend rejects asynchronously. */
  onResendRejected?: (recovery: EditedResendRejection) => void;
  /** Promote an existing unsent transcript block instead of appending a turn. */
  draftBlockId?: string;
};

export type PlanStatus = "streaming" | "ready" | "building" | "built";

export type PlanBlockMeta = {
  /** Provider or turn identity used to merge streamed snapshots. */
  key?: string;
  status: PlanStatus;
  /** Provider-authored plan before any user edits. */
  originalText?: string;
  /** Exact markdown the user approved with Build. */
  approvedText?: string;
  edited?: boolean;
};

export type ModelTarget = {
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
};

export type PlanBuildTarget = ModelTarget;

export type HandoffStatus = "preparing" | "ready";

export type HandoffMeta = {
  from: HarnessId;
  to: HarnessId;
  status: HandoffStatus;
  /** Inject this brief into prompts to `to` until that harness accepts a turn. */
  pending?: boolean;
};

/** One persisted question/answer in a completed turn's side conversation. */
export type BtwMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  /** Rich harness activity for assistant replies, when available. */
  blocks?: Block[];
};

export type BtwThreadStatus = "running" | "ready" | "error";

/** Independent, read-only "by the way" conversation anchored to a turn. */
export type BtwThread = {
  id: string;
  sourceEndBlockId: string;
  createdAt: number;
  updatedAt: number;
  status: BtwThreadStatus;
  messages: BtwMessage[];
  /** Provider that answered this side thread. */
  harness?: HarnessId;
  /** Selected harness model for this side thread; absent means session default. */
  model?: string;
  /** Provider settings selected for this side thread's model. */
  modelSettings?: Record<string, string>;
  /** Provider-specific side-thread id when the text runner supports resume. */
  providerThreadId?: string;
  error?: string;
  /** Live harness blocks for the in-flight reply; not persisted. */
  pendingBlocks?: Block[];
};

/** Compact transcript card for a second-opinion or split-pane handoff turn. */
export type SecondOpinionMeta = {
  from: HarnessId;
  to: HarnessId;
  request?: string;
  files?: number;
  /** Split-pane continue. Default is a second-opinion review. */
  kind?: "handoff";
};

/** A mid-turn interjection the harness asked to surface, e.g. OMP advisor notes. */
export type InterjectionSeverity = "nit" | "concern" | "blocker";

export type InterjectionMeta = {
  customType: string;
  /** Highest severity among this interjection's retained notes, when any is known. */
  severity?: InterjectionSeverity;
};

export type ToolPreviewKind = "read" | "write" | "shell" | "search";

export type ToolPreviewLineKind = "add" | "del" | "context";

export type ToolPreviewLine = {
  number?: number;
  kind: ToolPreviewLineKind;
  text: string;
};

export type ToolPreview = {
  kind: ToolPreviewKind;
  title?: string;
  path?: string;
  fileName?: string;
  startLine?: number;
  additions?: number;
  deletions?: number;
  /** Write supplied new contents without the previous file to compare. */
  contentOnly?: boolean;
  query?: string;
  lines?: ToolPreviewLine[];
  output?: string;
};

/** One thing a subagent did, mirrored into the parent transcript. */
export type AgentStepKind = "tool" | "message" | "reasoning";

export type AgentStep = {
  /** Provider step identity, so repeats merge instead of stacking up. */
  id: string;
  kind: AgentStepKind;
  /** Tool label, or the prose the subagent wrote. */
  text: string;
  toolKind?: string;
  status?: string;
  detail?: string;
  /** Large output left in storage on load; see `loadToolDetail`. */
  detailOmitted?: boolean;
  preview?: ToolPreview;
};

/**
 * The inside of a delegated run: what the subagent is called, and the trail it
 * left. Held on the parent Agent tool block so the transcript can open it
 * without a second session.
 */
export type AgentRunMeta = {
  /** What the subagent is called, e.g. "Correctness review". */
  name: string;
  /** Provider agent type, e.g. "code-reviewer". */
  agentType?: string;
  /** Model reported for the child, which may differ from its parent. */
  model?: string;
  steps: AgentStep[];
};

export type AttachmentKind = "image" | "audio" | "file";

export type GeneratedImageMeta = {
  path: string;
  name: string;
  mimeType: string;
  size: number;
  alt?: string;
};

export type Attachment = {
  /** Live transcript only; deliberately excluded from persisted attachments. */
  copyFromPath?: boolean;
  id: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  /** Absolute path when the file lives on disk. */
  path?: string;
  /** Base64 payload for vision images (and pasted blobs) sent to the harness. */
  data?: string;
  /** Object URL for in-session thumbnails. Not persisted. */
  previewUrl?: string;
};

export type MonoSessionCompletion = {
  sessionId: string;
  title: string;
  status: "completed" | "failed" | "cancelled";
  /** A single report covering several sessions launched in one Mono turn. */
  sessionCount?: number;
  /**
   * Not a report: a worker the Mono delegated to asked it a question (delegationQuestions.ts). It waits for an idle
   * Mono like a report and is withdrawn once the question is answered.
   */
  question?: true;
};

/**
 * A hidden app turn from a group room or from another Mono (hub rooms, docs/leadership/ROOM.md): the chat shows it as
 * one quiet line ("Leadership team · Answered Ash", "From frank"), never as Ash's words.
 */
export type MonoNote = {
  /** room: the room woke this Mono (its reply is a room post); message: another Mono's private message (mono_message). */
  kind: "room" | "message";
  /** The room's name, or the sending Mono's name. */
  from: string;
  /** The room id, or the sending Mono's id. */
  ref?: string;
  /** One line for the card: what the room asked, or the message's first line. */
  line?: string;
};

/**
 * A `[MonoCode check]` turn: the checker's private note to the chat that owns one of Ash's messages
 * (hub/model/hubChecks.ts). The chat shows it as a quiet collapsed card, never as Ash's words.
 */
export type MonoCheck = {
  /** The check's id in Ash OS (`ck_...`), which the owner answers with ash_record. */
  id: string;
  /** The message it is about. */
  dumpId?: string;
  /** What the checker noticed, for the card. */
  finding?: string;
};

export type QueuedMessage = {
  id: string;
  /** User bubble already shown optimistically in a Mono's conversation. */
  blockId?: string;
  text: string;
  attachments: Attachment[];
  noteCard?: NoteComposerCard;
  handoffCard?: HandoffComposerCard;
  intent?: TurnIntent;
  /** An app notification that must wait for an idle Mono, never steer its work. */
  monoSessionCompletion?: MonoSessionCompletion;
  /**
   * A brief another chat sent through the app (sessions.send, a Lead brief): the request id its user bubble carries
   * once it is sent, so the sender's row can tell it went in, and a retried send finds it waiting.
   */
  appRequestId?: string;
  /** The sender asked for it to wait behind the current work: sent as its own turn once the chat is idle, never steered. */
  waitForIdle?: boolean;
  /**
   * r86 (s14 r85 run 1: Ash answered a held worker while its Lead was mid-turn; the Lead decided without him and started
   * a second worker before the note went in): the one app note that may cut into a busy chat's turn, ahead of the other
   * app deliveries. Only Ash's answer to a held question carries it.
   */
  steerWhenBusy?: boolean;
  /** A room's wake or another Mono's message: goes in hidden, as a quiet line, and never shows as a pending bubble. */
  monoNote?: MonoNote;
  /** Delivery failed; the message remains available to retry or edit. */
  error?: string;
};

/** Claude Code's /goal as the chat shows it (claudeGoal.ts): the finish line and how the checks went. */
export type SessionGoal = {
  objective: string;
  /** Checks Claude Code's evaluator has made so far. */
  checks: number;
  /** What the last check that said "not yet" gave as its reason. */
  lastCheck?: string;
  /**
   * active: Claude keeps going until a check passes; paused: the CLI ended the turn at its own cap, the goal waits for
   * the next turn; met: a check passed; cleared: someone cleared it; stopped: MonoCode cleared it after its cap.
   */
  status: "active" | "paused" | "met" | "cleared" | "stopped";
  setAt: number;
  /**
   * The Claude conversation the goal was set in. `--resume` of that conversation keeps it; any other conversation
   * never had it, so MonoCode sets it there again.
   */
  providerSessionId?: string;
};

export type MessageQueueStatus = "active" | "paused" | "resuming";

/** The provider stopped the last turn at a usage limit. */
export type UsageLimit = {
  /** Epoch ms when the provider's window resets, once known. */
  resetsAt?: number;
  /** Send a continue turn once the window resets. */
  resumeAtReset?: boolean;
  /** When to send it, when later than the reset (auto-resume spreads chats out; features/autopilot/model/limitResume). */
  resumeAt?: number;
  /** Armed by auto-resume rather than by the user's own toggle. */
  auto?: boolean;
};

/** Provider/model provenance captured when a user turn is submitted. */
export type TurnModel = {
  harness: HarnessId;
  id: string;
  name: string;
};

/** Provider-reported token accounting for one user turn. */
export type TurnMetrics = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Provider-normalized share of input served from cache, as a percentage. */
  cacheHitPercent?: number;
};

/**
 * What a tool approval would run, from the provider's own permission request: the tool's name as the provider calls
 * it (Bash, Read, Edit, mcp__x__y), a shell tool's command in full, and the files an edit writes.
 */
export type ApprovalCall = {
  tool: string;
  command?: string;
  paths?: string[];
};

export type Block = {
  id: string;
  role: BlockRole;
  text: string;
  image?: GeneratedImageMeta;
  attachments?: Attachment[];
  streaming?: boolean;
  /** Epoch ms when this user turn started. */
  startedAt?: number;
  /** How long the agent worked on this user turn, in ms. */
  durationMs?: number;
  /** Epoch ms when this message joined a turn that was already running. */
  sentAt?: number;
  /** Stable model label for this turn. Present on newly created user blocks. */
  turnModel?: TurnModel;
  /** Provider turn boundary used to replace this user message, when known. */
  providerTurnId?: string;
  /** User turn saved to the session but not submitted to the harness yet. */
  draft?: boolean;
  /** This user turn activated MonoCode app access for its thread. */
  monocode?: boolean;
  /** The Plan or Orchestrator mode this user turn was sent in. */
  intent?: Extract<TurnIntent, "plan" | "orchestrate">;
  /** Stable CLI request that submitted this turn, for safe retries. */
  appRequestId?: string;
  /** Provider-reported token metrics for this user turn, when available. */
  turnMetrics?: TurnMetrics;
  tool?: {
    callId?: string;
    title?: string;
    kind?: string;
    status?: string;
    detail?: string;
    /** Large output left in storage on load; see `loadToolDetail`. */
    detailOmitted?: boolean;
    preview?: ToolPreview;
    /** Every file in a multi-file edit, retained for checkpoint recovery. */
    paths?: string[];
    /** Left running by the agent when it yielded; the turn waits on it. */
    background?: boolean;
    /** The command a shell call runs, when the provider said. */
    command?: string;
    /** Epoch ms the app first saw this call (saved, so the live step's timer survives a reload). */
    startedAt?: number;
    /** Epoch ms of the last event about this call: a change, or the provider's heartbeat that it still runs. */
    updatedAt?: number;
  };
  approval?: {
    requestId: number;
    decided?: "allow" | "deny" | "cancelled";
    /** Exactly what it would run, when the provider says (autopilot judges approvals on it). */
    call?: ApprovalCall;
  };
  /** Inner activity of a delegated run. Present on Agent/Task tool blocks. */
  agentRun?: AgentRunMeta;
  /** A workflow run's phases and agents. Present on the tool block that launched it. */
  workflowRun?: import("./workflowRun").WorkflowRunMeta;
  taskList?: TaskListMeta;
  plan?: PlanBlockMeta;
  orchestration?: OrchestrationProposal;
  /** Parent conversation for an internal orchestration worker. */
  orchestrationLeadId?: string;
  /**
   * A turn the app wrote on the user's behalf to keep an orchestration moving.
   * The harness needs it; the transcript hides it, so a run reads as one
   * conversation rather than the user narrating their own agents.
   */
  internal?: boolean;
  /** Hidden app prompt that starts a separate completion report in a Mono chat. */
  monoSessionCompletion?: MonoSessionCompletion;
  /** Hidden app prompt that hands this chat a checker's note (an internal user turn). */
  monoCheck?: MonoCheck;
  /** Hidden app prompt from a room or another Mono (an internal user turn), shown as a quiet line. */
  monoNote?: MonoNote;
  /** Accepted session launches, kept on the originating user turn. */
  monoSpawnedSessions?: MonoSpawnedSession[];
  handoff?: HandoffMeta;
  secondOpinion?: SecondOpinionMeta;
  /** Independent read-only side conversations anchored to this user turn. */
  btwThreads?: BtwThread[];
  noteCard?: NoteCardMeta;
  /** Saved artifacts attached to this turn; their bodies live outside chat. */
  artifactCards?: import("../../artifacts/artifacts").ArtifactCard[];
  /** Exact CI repair instructions and evidence supplied with this user turn. */
  ciContext?: string;
  /** Mid-turn interjection chrome; system blocks only. Body lives in text. */
  interjection?: InterjectionMeta;
  /**
   * A system row the reader must not miss — an error or an interruption —
   * rather than turn chrome like a status ping. Never folds into the trail.
   */
  notice?:
    | "error"
    | "interrupt"
    /** The app restarted three times under this turn, so it stopped resuming it (`inFlight.ts`); Needs you. */
    | "resume-stopped"
    /** The provider's saved conversation was gone; a fresh one started from the chat's brief (`claude.ts`). */
    | "recovered"
    /** A Lead said the job is done while work it delegated still runs (`monos/model/leadFlow.ts`). */
    | "still-running"
    /** The chat moved to (or started on) another account of its provider because one hit its limit (E5, accountWaterfall.ts). */
    | "account-moved"
    /** Ash wrote to a chat that is held on his OK for a tool call: it can't answer until he decides (approvalWait.ts). */
    | "waiting-on-you";
  /** An agent-to-agent note on a system block (who messaged whom, got stuck, reported; monos/model/agentNotes.ts). */
  agentNote?: import("../../monos/model/agentNotes").AgentNote;
  /** On a still-running note: the tasks it named, and the brief that stays open (one note per task and per brief). */
  stillRunning?: { taskIds: string[]; briefId?: string };
  /** On an interrupt note: the ship (update) whose restart cut the turn. Its receipt rides on the resume note. */
  shipUpdate?: string;
  /**
   * On an error notice: why the provider failed the turn, when the adapter could tell (a 402 is billing, a 529 an
   * overload), whether trying again can work, and when a refused usage window resets. What makes the failure a state
   * the Monos rail, Today and Being built show (monos/model/turnFailure.ts), not just a line in the chat.
   */
  failure?: {
    errorClass?: ProviderErrorClass;
    retryable?: boolean;
    resetsAt?: number;
    at?: number;
  };
  statusKey?: string;
  /** Posted to a Mono's chat by one of its habits, outside any turn. */
  monoHabit?: { id: string; name: string; at: number };
  /** A card a Mono put in its chat; see `features/monos/model/monoCards`. */
  monoCard?: import("../../monos/model/monoCards").MonoCard;
  /**
   * The emoji a Mono answered this user message with. Drawn from its reply
   * when the chat renders; see `features/monos/model/monoReaction`.
   */
  monoReaction?: string;
};

export type RuntimeMode =
  "supervised" | "auto-accept-edits" | "auto" | "full-access";

/** One GitHub issue or pull request associated with a coding session. */
export type LinkedWorkItem = {
  kind: "issue" | "pr";
  repo: string;
  number: number;
  url: string;
};

export const RUNTIME_MODES: RuntimeMode[] = [
  "supervised",
  "auto-accept-edits",
  "auto",
  "full-access",
];

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "supervised";

export const RUNTIME_MODE_LABEL: Record<RuntimeMode, string> = {
  supervised: "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export const RUNTIME_MODE_HINT: Record<RuntimeMode, string> = {
  supervised: "Ask before commands and file changes.",
  "auto-accept-edits": "Auto-approve edits, ask before other actions.",
  auto: "An AI reviewer can approve or deny actions.",
  "full-access":
    "Allow commands, edits, and supported MCP confirmations in non-plan turns without prompts.",
};

export type WorkspaceMode = "current" | "worktree";

/** One piece of background work a turn left running (a subagent, a backgrounded shell, a monitor, a task). */
export type CutWork = {
  /** "ask": r99, the chat's own question to Ash (AskUserQuestion) that a quit closed; the resume asks it again. */
  kind: "subagent" | "shell" | "monitor" | "task" | "ask";
  /** What it was doing, with the id to resume or restart it by. */
  label: string;
  id: string;
};

export type Session = {
  /** Saved and accessible by id, but omitted from the normal session sidebar. */
  sidebarHidden?: boolean;
  /** Receipt for an acknowledged floating-composer handoff. */
  quickLaunchAccepted?: boolean;
  /** Internal worker: displayed in its lead's panel rather than a workspace tab. */
  orchestrationLeadId?: string;
  /** Temporary Inbox conversation: shares the runtime, never saved as a session. */
  inboxAsk?: InboxAskContext;
  id: string;
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  runtimeMode: RuntimeMode;
  title: string;
  /** Project / working directory for this session. */
  cwd: string;
  blocks: Block[];
  /** Mono-only database window. Older blocks are fetched separately by the viewer. */
  monoTranscript?: { before: number | null; firstBlockId: string | null };
  /** True while a harness turn is in flight. */
  busy?: boolean;
  /** The provider has accepted this turn and can take live follow-ups. */
  turnReady?: boolean;
  /**
   * What the live turn is waiting on after the agent yielded with work still
   * running in the background. In-memory only.
   */
  backgroundTasks?: string[];
  /**
   * Everything the live turn has running in the background (subagents, backgrounded shells, monitors), with the ids
   * to restart them by. Saved with the in-flight row, so a resume after a quit or crash says what was cut.
   * In-memory only otherwise.
   */
  cutWork?: CutWork[];
  /**
   * Claude Code's /goal for this chat, while one is set or just ended. Saved with the chat while it is still open
   * (active or paused), so a restart brings back its Goal row and the harness carries on with it; a met, cleared or
   * stopped goal is never saved, so it never comes back.
   */
  goal?: SessionGoal;
  /**
   * How many times this turn has resumed itself after a restart without finishing (`inFlight.ts`). Saved with the
   * in-flight row; any turn that isn't an automatic resume starts again from none. In-memory only otherwise.
   */
  autoResumes?: number;
  /** Follow-ups retained until they have been delivered. */
  queuedMessages?: QueuedMessage[];
  /** Paused after user stops current turn; resuming waits for continued turn. */
  queueStatus?: MessageQueueStatus;
  /** Prevent auto-dispatch while this queued row is being edited. In-memory only. */
  editingQueuedMessageId?: string;
  /** Pending delivery locks this row against edits and deletion. Not persisted. */
  sendingQueuedMessageId?: string;
  /** Last turn hit a provider usage limit; cleared by the next send. In-memory only. */
  usageLimit?: UsageLimit;
  /**
   * Lives only in memory: never saved, never listed with the project's chats.
   * A Mono's habit runs are, and disappear when the run ends.
   */
  ephemeral?: boolean;
  /** Provider-side conversation id (Cursor ACP session id). */
  providerSessionId?: string;
  /** Named local credential profile used by Claude or Codex. */
  providerAccountId?: string;
  /** Context-window level reported by the harness. Absent until it reports. */
  context?: ContextUsage;
  /**
   * Composer switched providers, but the previous child is still live.
   * Handoff runs on the next send, not on picker change.
   */
  pendingSwitch?: PendingHarnessSwitch;
  /** Last known branch in the session's working copy. */
  branch?: string;
  /** Selected working copy; cwd remains the project identity. */
  worktreeCwd?: string;
  /** Blank-composer choice; consumed when the first turn starts. */
  workspaceMode?: WorkspaceMode;
  /** Base ref for a worktree that will be created on first send. */
  worktreeBase?: string;
  /** Internal guard while the first turn creates its selected worktree. */
  worktreePreparing?: boolean;
  /** Select a working copy before continuing after the previous one was deleted. */
  worktreeRemoved?: boolean;
  /** One-shot composer text when opening a session from Inbox. */
  composerSeed?: string;
  /** Inbox issue/PR chip shown above the composer. In-memory, one-shot. */
  inboxCard?: InboxComposerCard;
  /** GitHub issue or pull request shown on the persisted session card. */
  linkedWorkItem?: LinkedWorkItem;
  /** Automation that created or last launched this session. */
  automationId?: string;
  /** New linked-item activity shown above the composer. In-memory, one-shot. */
  linkedWorkItemUpdateCard?: LinkedWorkItemUpdateCard;
  /** Note chip shown above the composer. In-memory, one-shot. */
  noteCard?: NoteComposerCard;
  /** Handoff chip shown above the composer. In-memory, one-shot. */
  handoffCard?: HandoffComposerCard;
  /**
   * Live clarifying questions from AskUserQuestion / ask_question / etc.
   * In-memory; request ids do not survive restarts.
   */
  pendingQuestion?: UserQuestionPrompt;
};

export type PendingHarnessSwitch = {
  from: HarnessId;
  fromModel: string;
  fromSettings: Record<string, string>;
  fromProviderSessionId?: string;
  fromProviderAccountId?: string;
  /** The outgoing provider is exhausted; build the recap from the transcript. */
  skipOutgoingRecap?: boolean;
};

export const HARNESS_LABEL: Record<HarnessId, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  fx: "fx",
  antigravity: "antigravity",
  devin: "devin",
};

export const HARNESS_TITLE: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok Build",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "omp",
  fx: "fx",
  antigravity: "Antigravity",
  devin: "Devin",
};

/** fx ACP rejects attachment prompt blocks. */
export function harnessSupportsAttachments(id: HarnessId): boolean {
  return id !== "fx";
}

export function newSession(
  harness: HarnessId = "claude",
  cwd = "~",
  model?: string,
  runtimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE,
  modelSettings?: Record<string, string>,
): Session {
  const resolved = resolveModel(harness, model ?? preferredModelId(harness));
  return {
    id: crypto.randomUUID(),
    harness,
    model: resolved.id,
    modelSettings: preferredModelSettings(resolved, modelSettings),
    runtimeMode,
    title: HARNESS_LABEL[harness],
    cwd,
    blocks: [],
  };
}

/** New conversation using the Providers defaults. */
export function newDefaultSession(
  cwd = "~",
  runtimeMode: RuntimeMode = DEFAULT_RUNTIME_MODE,
): Session {
  const choice = defaultSessionChoice(cwd);
  return withChoiceSettings(newSession(choice.harness, cwd, choice.model, runtimeMode), choice.modelSettings);
}

/** A folder default's own settings (the coding team's High) win over the last chat's. */
function withChoiceSettings(session: Session, settings: Record<string, string> | undefined): Session {
  return settings ? { ...session, modelSettings: { ...session.modelSettings, ...settings } } : session;
}

/**
 * Provider and model a seeded session should use in `cwd`. The project's own
 * default provider and model win over the seed; when the project has neither,
 * the seed's provider and model are carried. A provider the project hides is
 * swapped for its first enabled one.
 */
function projectSessionChoice(
  seed: Pick<Session, "harness" | "model"> | undefined,
  cwd: string,
): { harness: HarnessId; model?: string } {
  const project = loadProjectProviderSettings(cwd);
  const seedHarness = seed?.harness ?? "claude";
  const harness = firstEnabledHarness(
    cwd,
    project.defaultHarness ?? seedHarness,
  );
  const model =
    project.models?.[harness] ??
    (project.defaultHarness === harness ? project.defaultModel : undefined) ??
    (project.defaultHarness == null && harness === seedHarness
      ? seed?.model
      : undefined);
  return { harness, model };
}

/**
 * New conversation for a project. The project's default provider and model win
 * over the seed's; a provider the project has hidden is swapped for its first
 * enabled one.
 */
export function newSessionForProject(
  seed: Session | undefined,
  cwd: string,
): Session {
  // The hub's coding-team default (E7) wins over the seed when the project has no default of its own.
  const folder = folderDefaultChoice(cwd);
  if (folder) return withChoiceSettings(newSession(folder.harness, cwd, folder.model, seed?.runtimeMode), folder.modelSettings);
  const { harness, model } = projectSessionChoice(seed, cwd);
  const carriesSeed =
    model != null && model === seed?.model && harness === seed?.harness;
  return newSession(
    harness,
    cwd,
    model,
    seed?.runtimeMode,
    carriesSeed ? seed?.modelSettings : undefined,
  );
}

/**
 * Retarget an existing session (typically a blank one) to a project, adopting
 * that project's provider defaults while keeping its id, blocks and composer
 * seed.
 */
export function retargetSessionToProject(
  session: Session,
  cwd: string,
): Session {
  const { harness, model } = projectSessionChoice(session, cwd);
  const resolved = resolveModel(harness, model ?? preferredModelId(harness));
  const carriesSeed =
    model != null && model === session.model && harness === session.harness;
  return {
    ...session,
    cwd,
    harness,
    model: resolved.id,
    modelSettings: preferredModelSettings(
      resolved,
      carriesSeed ? session.modelSettings : undefined,
    ),
    title: HARNESS_LABEL[harness],
    ...(harness === session.harness
      ? {}
      : { providerSessionId: undefined, providerAccountId: undefined }),
    // The account was chosen for the old project. The new project reads its
    // own stored choice, so a stamp carried over would show the wrong account.
    ...(cwd === session.cwd ? {} : { providerAccountId: undefined }),
    ...(resolved.id === session.model
      ? {}
      : { context: dropContextWindow(session.context) }),
  };
}

/** New conversation carrying another session's harness, model and settings. */
export function newSessionLike(
  seed: Session | undefined,
  cwd: string,
): Session {
  return newSession(
    seed?.harness ?? "claude",
    cwd,
    seed?.model,
    seed?.runtimeMode,
    seed?.modelSettings,
  );
}

/** First line of a prompt, truncated for the tab strip. */
export function titleFromPrompt(
  prompt: string,
  harness: HarnessId,
  attachments: Attachment[] = [],
): string {
  // r51: a title is plain text, never the prompt's markdown.
  // A Hub turn's tag can be its whole first line ("[MonoCode brief from …]"), so the title is the first line with words.
  const line = prompt.trim().split(/\r?\n/).map((part) => listTitle(part)).find(Boolean) ?? "";
  const fromFiles =
    !line && attachments.length > 0
      ? attachments
          .map((file) => file.name)
          .filter(Boolean)
          .slice(0, 3)
          .join(", ")
      : "";
  const seed = line || fromFiles;
  if (!seed) return HARNESS_LABEL[harness];
  const max = 72;
  const short = seed.length > max ? `${seed.slice(0, max - 1)}…` : seed;
  return formatSessionTitle(harness, short);
}

export function formatSessionTitle(harness: HarnessId, title: string): string {
  // r51: a generated title can carry markdown too; r52: and a Hub turn's [MonoCode …] tag, or a label already.
  const trimmed = listTitle(title);
  if (!trimmed) return HARNESS_LABEL[harness];
  return `${HARNESS_LABEL[harness]} · ${trimmed}`;
}

/** True when the stored title is still a placeholder the LLM may replace. */
export function canReplaceSessionTitle(
  current: string,
  harness: HarnessId,
  seed: string,
): boolean {
  return (
    current === seed ||
    current === HARNESS_LABEL[harness] ||
    current === HARNESS_TITLE[harness]
  );
}

export function hasPendingApproval(blocks: Block[]): boolean {
  return blocks.some((block) => block.approval && !block.approval.decided);
}

/**
 * r80 (c02): a permission card only waits on Ash while its turn runs. Once the turn is over (the CLI closed the request
 * when its stream ended, or the app restarted), an undecided card is history, not a "Needs you".
 */
export function sessionNeedsInput(session: Session): boolean {
  return (
    !session.worktreeRemoved &&
    ((session.busy !== false && hasPendingApproval(session.blocks)) || session.pendingQuestion != null)
  );
}

/** The single unsent user turn held by a session, when present. */
export function sessionDraftBlock(
  session: Pick<Session, "blocks">,
): Block | undefined {
  return session.blocks.find((block) => block.role === "user" && block.draft);
}

/** Remove one saved draft without disturbing the conversation before it. */
export function removeSessionDraft(
  session: Session,
  draftBlockId: string,
): Session | undefined {
  const draft = session.blocks.find(
    (block) =>
      block.id === draftBlockId && block.role === "user" && block.draft,
  );
  if (!draft) return undefined;
  const blocks = session.blocks.filter((block) => block.id !== draftBlockId);
  const draftTitle = titleFromPrompt(
    draft.text,
    session.harness,
    draft.attachments,
  );
  return {
    ...session,
    blocks,
    title:
      blocks.length === 0 && session.title === draftTitle
        ? HARNESS_LABEL[session.harness]
        : session.title,
  };
}

/**
 * Title without the harness prefix stored for the tab strip. r102 (12, Critiquito): an untitled chat is named by its
 * first ask's short title (`firstAsk`) rather than "New session", when there is one.
 */
export function sessionDisplayTitle(title: string, harness: HarnessId, firstAsk?: string): string {
  const untitled = () => (firstAsk ? shortAskTitle(firstAsk) : "") || "New session";
  if (title === HARNESS_LABEL[harness] || title === HARNESS_TITLE[harness]) {
    return untitled();
  }
  // r51: a title saved with markdown before this shows plain; r52: without its label or a [MonoCode …] tag either.
  return listTitle(title) || untitled();
}

/** A short title from an ask: its first line with words, cut to the first sentence and at most 48 characters. */
export function shortAskTitle(text: string): string {
  const line = text.trim().split(/\r?\n/).map((part) => listTitle(part)).find(Boolean) ?? "";
  const sentence = (line.match(/^.+?[.?!](?=\s|$)/)?.[0] ?? line).replace(/[.!]$/, "").trim();
  const max = 48;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > 24 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

/** The text of a chat's first message from Ash, for `sessionDisplayTitle`'s fallback. */
export function firstAskOf(session: { blocks?: readonly { role: string; text?: string }[] }): string | undefined {
  return session.blocks?.find((block) => block.role === "user" && block.text?.trim())?.text;
}

/** Working copy the agent and session git UIs should use. */
export function sessionWorkCwd(session: {
  cwd: string;
  worktreeCwd?: string;
}): string {
  return session.worktreeCwd || session.cwd;
}
