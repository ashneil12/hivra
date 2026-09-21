'use client';

// WORKFLOWS — a managed, run-anytime list in the command panel.
//
// Replaces the old dismissible "Workflows of the week" chat banner. This is a
// permanent, side-docked list the user OWNS: a few starter templates seeded on
// first use (kept because they're a good starting point), plus any workflows the
// user creates themselves. Each row runs with one tap (injects its prompt into
// the chat composer via the parent's sender), can be HIDDEN (archived, not
// destroyed — restorable from the "Hidden" drawer), and — for the starter
// templates — reveals a sample result on demand (no always-on preview).
//
// Hiding, not deleting, is the default: a workflow the user tucks away stays in
// storage (marked `hidden`) so they can bring it back. A deliberate permanent
// delete lives only inside the Hidden drawer, so the main list can never lose a
// workflow by a single mistaken tap.
//
// Persisted per-browser to localStorage so a user's list (adds, hides, restores,
// and deletes) sticks.

import { useCallback, useState } from 'react';
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  EyeOff,
  FileSpreadsheet,
  Globe,
  Mail,
  Megaphone,
  Play,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Swords,
  Table2,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { captureClient } from '@/lib/telemetry/posthog-client';

const WORKFLOWS_KEY = 'hivra_workflows';

/**
 * Public feature flag for the one-tap workflow injection. The run relies on a
 * box-side `hermes-dashboard:send-message` handler; until that's rolled to the
 * image, tapping "Run" would silently no-op, so the parent hides the whole
 * section unless this is "true" (NEXT_PUBLIC_WORKFLOWS_RUN_ENABLED).
 */
export function isWorkflowsRunFlagOn(): boolean {
  return process.env.NEXT_PUBLIC_WORKFLOWS_RUN_ENABLED === 'true';
}

/** A workflow the user can run/manage. Only these fields are persisted. */
export interface StoredWorkflow {
  id: string;
  title: string;
  prompt: string;
  /**
   * Hidden (archived) workflows stay in storage but drop out of the visible
   * list — restorable from the "Hidden" drawer. Absent/false means visible, so
   * lists saved before this field existed read back as visible.
   */
  hidden?: boolean;
}

/** Extra, non-persisted metadata for the seeded starter templates (by id). */
interface TemplateMeta {
  apps: LucideIcon[];
  /** One-line payoff shown under the title. */
  outcome: string;
  /** A mock finished-result line, revealed only on demand. */
  sample: string;
}

const TEMPLATE_META: Record<string, TemplateMeta> = {
  'weekly-metrics-brief': {
    apps: [BarChart3, Table2, Mail],
    outcome: 'Your whole business in one Monday-morning readout.',
    sample: 'Revenue: $42,100  (+23% vs last week) · Signups: 312 · Churn: 1.8%',
  },
  'competitor-teardown': {
    apps: [Swords, Globe, Search],
    outcome: 'Know exactly where a rival is beating you — and the gap to close.',
    sample: "Top gap: their pricing page converts ~2x better · 3 features you're missing",
  },
  'content-repurposing': {
    apps: [Megaphone, FileSpreadsheet, Mail],
    outcome: 'Turn one post into a week of content across every channel.',
    sample: '1 blog post → 5 LinkedIn posts · 8 tweets · 1 newsletter · 3 hooks',
  },
  'inbox-triage': {
    apps: [Mail, Sparkles, Search],
    outcome: 'Clear your inbox to zero with replies already written.',
    sample: '14 emails triaged · 6 drafted replies ready · 2 flagged as urgent',
  },
};

const DEFAULT_WORKFLOWS: StoredWorkflow[] = [
  {
    id: 'weekly-metrics-brief',
    title: 'Weekly metrics brief',
    prompt:
      "Put together a weekly metrics brief for my business. Pull the key numbers — revenue, new signups, active users, and churn — compare each to the previous week with the percentage change, call out the single biggest mover and why it likely moved, and end with the one metric I should watch this week. Keep it to a tight, skimmable readout I could send to my team on a Monday morning.",
  },
  {
    id: 'competitor-teardown',
    title: 'Competitor teardown',
    prompt:
      "Run a competitor teardown. Pick my closest competitor (ask me for their URL if you need it), then analyze their positioning, pricing, top features, and messaging. Give me a side-by-side of where they beat me and where I beat them, the 3 highest-leverage gaps to close, and one concrete change I could ship this week to win deals against them.",
  },
  {
    id: 'content-repurposing',
    title: 'Content repurposing',
    prompt:
      "Take my latest piece of content (ask me to paste it or give a link) and repurpose it into a full week of posts: 5 LinkedIn posts, 8 short tweets, a 1-email newsletter, and 3 scroll-stopping hooks. Keep my voice, lead each one with the strongest idea, and make every piece able to stand on its own.",
  },
  {
    id: 'inbox-triage',
    title: 'Inbox triage + drafts',
    prompt:
      "Help me triage my inbox. Group my unread emails into urgent / needs-a-reply / FYI / can-ignore, flag anything time-sensitive, and draft a ready-to-send reply for each one that actually needs a response — matched to my tone. List them so I can approve and send in one pass.",
  },
];

function isValidWorkflow(w: unknown): w is StoredWorkflow {
  if (typeof w !== 'object' || w === null) return false;
  const o = w as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.title === 'string' &&
    typeof o.prompt === 'string' &&
    (o.hidden === undefined || typeof o.hidden === 'boolean')
  );
}

/** The user's saved workflow list — seeded with the starter templates on first use. */
function readWorkflows(): StoredWorkflow[] {
  try {
    const raw = window.localStorage.getItem(WORKFLOWS_KEY);
    if (raw === null) return DEFAULT_WORKFLOWS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isValidWorkflow) : DEFAULT_WORKFLOWS;
  } catch {
    return DEFAULT_WORKFLOWS; // SSR / private mode — show the starters.
  }
}

function writeWorkflows(list: StoredWorkflow[]): void {
  try {
    window.localStorage.setItem(WORKFLOWS_KEY, JSON.stringify(list));
  } catch {
    // Best-effort: a blocked localStorage just means the list isn't remembered.
  }
}

const KICKER: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color: 'var(--text-muted)',
  fontWeight: 700,
};

export interface WorkflowsPanelProps {
  /** Inject a workflow's prompt into the composer. Returns true when dispatched. */
  onRunWorkflow: (prompt: string) => boolean;
}

export function WorkflowsPanel({ onRunWorkflow }: WorkflowsPanelProps) {
  const [workflows, setWorkflows] = useState<StoredWorkflow[]>(readWorkflows);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [ran, setRan] = useState<string | null>(null);
  // Start the drawer expanded only when the list mounts fully hidden, so the
  // "restore one below" empty-state copy is literally true on load.
  const [showHidden, setShowHidden] = useState(
    () => workflows.length > 0 && workflows.every((w) => w.hidden),
  );

  // Split into what shows on the list vs what's tucked away in the Hidden drawer.
  const visible = workflows.filter((w) => !w.hidden);
  const hiddenWorkflows = workflows.filter((w) => w.hidden);

  const persist = useCallback((next: StoredWorkflow[]) => {
    setWorkflows(next);
    writeWorkflows(next);
  }, []);

  const run = useCallback(
    (wf: StoredWorkflow) => {
      const sent = onRunWorkflow(wf.prompt);
      if (sent) {
        captureClient('workflow_run', { surface: 'command_panel', workflow: wf.id });
        setRan(wf.id);
        window.setTimeout(() => setRan((cur) => (cur === wf.id ? null : cur)), 2200);
      }
    },
    [onRunWorkflow],
  );

  const setHidden = useCallback(
    (id: string, hidden: boolean) => {
      persist(workflows.map((w) => (w.id === id ? { ...w, hidden } : w)));
    },
    [workflows, persist],
  );

  // Hide (archive): the workflow leaves the list but stays in storage, so it can
  // be brought back from the Hidden drawer. This is the default, non-destructive
  // action on each row.
  const hide = useCallback(
    (id: string) => {
      setHidden(id, true);
      captureClient('workflow_hidden', { surface: 'command_panel', workflow: id });
    },
    [setHidden],
  );

  const restore = useCallback(
    (id: string) => {
      setHidden(id, false);
      // Collapse the drawer if this empties it, so its open state can't linger
      // and auto-reveal the next time a workflow is hidden.
      if (hiddenWorkflows.length <= 1) setShowHidden(false);
      captureClient('workflow_restored', { surface: 'command_panel', workflow: id });
    },
    [setHidden, hiddenWorkflows.length],
  );

  // Permanent delete — only reachable (behind a confirm) from inside the Hidden
  // drawer, so the main list can never lose a workflow to a single tap.
  const destroy = useCallback(
    (id: string) => {
      persist(workflows.filter((w) => w.id !== id));
      if (hiddenWorkflows.length <= 1) setShowHidden(false);
      captureClient('workflow_deleted', { surface: 'command_panel', workflow: id });
    },
    [workflows, persist, hiddenWorkflows.length],
  );

  const addWorkflow = useCallback(
    (title: string, prompt: string) => {
      const t = title.trim();
      const p = prompt.trim();
      if (!t || !p) return;
      const id = `custom_${Date.now().toString(36)}`;
      persist([...workflows, { id, title: t, prompt: p }]);
      captureClient('workflow_created', { surface: 'command_panel' });
      setCreating(false);
    },
    [workflows, persist],
  );

  const toggleSample = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      {visible.length === 0 ? (
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {workflows.length === 0
            ? 'No workflows yet — create one below to run it any time.'
            : 'Every workflow is hidden — restore one below or create a new one.'}
        </span>
      ) : (
        visible.map((wf) => (
          <WorkflowRow
            key={wf.id}
            wf={wf}
            meta={TEMPLATE_META[wf.id]}
            justRan={ran === wf.id}
            sampleOpen={expanded.has(wf.id)}
            onRun={() => run(wf)}
            onHide={() => hide(wf.id)}
            onToggleSample={() => toggleSample(wf.id)}
          />
        ))
      )}

      {creating ? (
        <CreateWorkflowForm onAdd={addWorkflow} onCancel={() => setCreating(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          data-testid="workflow-create-open"
          className="mono"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            justifySelf: 'start',
            border: '1px dashed var(--etched-border)',
            background: 'transparent',
            color: 'var(--text-secondary)',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontWeight: 700,
            padding: '8px 11px',
            cursor: 'pointer',
          }}
        >
          <Plus size={12} /> New workflow
        </button>
      )}

      {hiddenWorkflows.length > 0 ? (
        <HiddenWorkflowsDrawer
          hidden={hiddenWorkflows}
          open={showHidden}
          onToggle={() => setShowHidden((v) => !v)}
          onRestore={restore}
          onDelete={destroy}
        />
      ) : null}
    </div>
  );
}

function WorkflowRow({
  wf,
  meta,
  justRan,
  sampleOpen,
  onRun,
  onHide,
  onToggleSample,
}: {
  wf: StoredWorkflow;
  meta?: TemplateMeta;
  justRan: boolean;
  sampleOpen: boolean;
  onRun: () => void;
  onHide: () => void;
  onToggleSample: () => void;
}) {
  return (
    <div
      data-testid={`workflow-row-${wf.id}`}
      style={{
        border: '1px solid var(--etched-border)',
        background: 'rgba(255,255,255,0.02)',
        padding: '10px 11px',
        display: 'grid',
        gap: 8,
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span
          className="mono"
          style={{ fontSize: 12, fontWeight: 800, color: 'var(--ink-black)', flex: '1 1 auto', minWidth: 0 }}
        >
          {wf.title}
        </span>
        {meta ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
            {meta.apps.map((Icon, i) => (
              <Icon key={i} size={12} strokeWidth={2} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
            ))}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onHide}
          aria-label={`Hide ${wf.title}`}
          title="Hide — stays in your Hidden list, restore any time"
          data-testid={`workflow-hide-${wf.id}`}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, display: 'inline-flex', flexShrink: 0 }}
        >
          <EyeOff size={13} />
        </button>
      </div>

      {meta ? (
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{meta.outcome}</span>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={onRun}
          data-testid={`workflow-run-${wf.id}`}
          className="mono"
          style={{
            border: '1px solid var(--ink-black)',
            background: justRan ? 'transparent' : 'var(--ink-black)',
            color: justRan ? 'var(--ink-black)' : 'var(--bg-surface)',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontWeight: 800,
            padding: '7px 11px',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {justRan ? <Sparkles size={11} /> : <Play size={11} />} {justRan ? 'Sent to chat' : 'Run'}
        </button>
        {meta ? (
          <button
            type="button"
            onClick={onToggleSample}
            data-testid={`workflow-sample-${wf.id}`}
            className="mono"
            style={{
              marginLeft: 'auto',
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              fontSize: 9.5,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: 700,
              cursor: 'pointer',
              padding: 2,
            }}
          >
            {sampleOpen ? 'Hide sample' : 'Sample'}
          </button>
        ) : null}
      </div>

      {meta && sampleOpen ? (
        <div
          aria-hidden="true"
          style={{
            border: '1px dashed var(--etched-border)',
            background: 'rgba(212, 175, 55, 0.06)',
            padding: '7px 9px',
            display: 'grid',
            gap: 4,
          }}
        >
          <span className="mono" style={{ ...KICKER, fontSize: 8.5, letterSpacing: '0.14em' }}>
            Sample result
          </span>
          <span className="mono" style={{ fontSize: 11, color: 'var(--ink-black)', lineHeight: 1.45 }}>
            {meta.sample}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Collapsible "Hidden" drawer — where archived workflows live. Restore brings a
 * workflow back to the main list; the (deliberately secondary) Delete is the
 * only permanent-removal path, kept out of the main list so no single tap can
 * destroy a workflow.
 */
function HiddenWorkflowsDrawer({
  hidden,
  open,
  onToggle,
  onRestore,
  onDelete,
}: {
  hidden: StoredWorkflow[];
  open: boolean;
  onToggle: () => void;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="workflow-hidden-toggle"
        className="mono"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          justifySelf: 'start',
          border: 'none',
          background: 'transparent',
          color: 'var(--text-muted)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontWeight: 700,
          padding: '4px 2px',
          cursor: 'pointer',
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Hidden ({hidden.length})
      </button>

      {open ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {hidden.map((wf) => (
            <HiddenWorkflowRow
              key={wf.id}
              wf={wf}
              onRestore={() => onRestore(wf.id)}
              onDelete={() => onDelete(wf.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A single archived-workflow row. Restore is the safe, primary action; the
 * permanent Delete is gated behind an inline "Delete permanently? / Confirm"
 * step with a distinct destructive tint, so an irreversible (localStorage-only,
 * no undo) removal can't happen on a single stray tap.
 */
function HiddenWorkflowRow({
  wf,
  onRestore,
  onDelete,
}: {
  wf: StoredWorkflow;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const DANGER = '#e06c5a';

  return (
    <div
      data-testid={`workflow-hidden-row-${wf.id}`}
      style={{
        border: '1px solid var(--etched-border)',
        background: 'rgba(255,255,255,0.01)',
        padding: '8px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          color: confirming ? DANGER : 'var(--text-secondary)',
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {confirming ? 'Delete permanently?' : wf.title}
      </span>

      {confirming ? (
        <>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Confirm permanent delete of ${wf.title}`}
            data-testid={`workflow-delete-confirm-${wf.id}`}
            className="mono"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              border: `1px solid ${DANGER}`,
              background: 'transparent',
              color: DANGER,
              fontSize: 9.5,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: 800,
              padding: '5px 8px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Trash2 size={11} aria-hidden="true" /> Delete
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            aria-label="Cancel delete"
            data-testid={`workflow-delete-cancel-${wf.id}`}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              padding: 2,
              display: 'inline-flex',
              flexShrink: 0,
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={onRestore}
            aria-label={`Restore ${wf.title}`}
            data-testid={`workflow-restore-${wf.id}`}
            className="mono"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              border: '1px solid var(--etched-border)',
              background: 'transparent',
              color: 'var(--ink-black)',
              fontSize: 9.5,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              fontWeight: 700,
              padding: '5px 8px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <RotateCcw size={11} aria-hidden="true" /> Restore
          </button>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label={`Delete ${wf.title} permanently`}
            title="Delete permanently"
            data-testid={`workflow-delete-${wf.id}`}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--text-muted)',
              padding: 2,
              display: 'inline-flex',
              flexShrink: 0,
            }}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}

function CreateWorkflowForm({
  onAdd,
  onCancel,
}: {
  onAdd: (title: string, prompt: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const canAdd = title.trim().length > 0 && prompt.trim().length > 0;

  const inputStyle: React.CSSProperties = {
    width: '100%',
    minWidth: 0,
    border: '1px solid var(--etched-border)',
    background: 'rgba(255,255,255,0.02)',
    color: 'var(--ink-black)',
    fontSize: 12.5,
    padding: '8px 10px',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div
      data-testid="workflow-create-form"
      style={{ border: '1px solid var(--etched-border)', background: 'rgba(255,255,255,0.02)', padding: '11px', display: 'grid', gap: 8 }}
    >
      <span className="mono" style={KICKER}>
        New workflow
      </span>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Name — e.g. Daily sales recap"
        autoComplete="off"
        data-testid="workflow-create-title"
        style={inputStyle}
      />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="What should the agent do when you run this?"
        rows={3}
        data-testid="workflow-create-prompt"
        style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => onAdd(title, prompt)}
          disabled={!canAdd}
          data-testid="workflow-create-save"
          className="mono"
          style={{
            border: '1px solid var(--ink-black)',
            background: canAdd ? 'var(--ink-black)' : 'transparent',
            color: canAdd ? 'var(--bg-surface)' : 'var(--text-muted)',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontWeight: 800,
            padding: '7px 12px',
            cursor: canAdd ? 'pointer' : 'default',
          }}
        >
          Add workflow
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="mono"
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontWeight: 700,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <X size={12} /> Cancel
        </button>
      </div>
    </div>
  );
}
