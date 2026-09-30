import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, X } from 'lucide-react';
import { StyledDropdown } from "@/components/ui/StyledDropdown";
import { SafePortal } from "@/components/ui/SafePortal";
import { clientLog } from "@/lib/client/logger";
import {
  cronFromFriendly,
  friendlyFromCron,
  describeFriendly,
  to12Hour,
  to24Hour,
  DAY_INITIALS,
  DAY_LABELS,
  DEFAULT_FRIENDLY_SCHEDULE,
  type Frequency,
  type FriendlySchedule,
} from "@/lib/schedule/cron-friendly";

interface Agent {
  id: string;
  name: string;
  status: string;
}

interface LiveJob {
  id: string;
  name: string;
  schedule: string;
  command: string; // This maps to "prompt" in the agent
  enabled: boolean;
  errorCount?: number;
  profileName?: string;
  state?: string;
  deliver?: string;
  nextRunAt?: string;
  lastRunAt?: string;
}

const DEFAULT_NEW_TASK_SCHEDULE = '0 9 * * *';

// "Deliver results to" — maps to the box's CronJobCreate `deliver` field. The box
// accepts a free-form delivery token; "local" (the default) keeps the result in
// the agent's own run history / dashboard and is the EXISTING behavior. The other
// options name the connected messaging platform the agent should push the result
// to when the job fires (see the gateway's per-platform delivery).
// TODO(paioclaw-riplist): only "local" is confirmed end-to-end from this repo. The
// exact box tokens for the platform options ("telegram"/"discord"/"email") and
// whether to gate each on a *connected* channel are owned by the gateway/sidecar
// CronJobCreate model, which isn't in this repo — a reviewer must confirm the
// accepted tokens and ideally populate this list from the box's connected
// channels rather than hardcoding it.
const DEFAULT_DELIVER = 'local';
const DELIVER_OPTIONS: { value: string; label: string }[] = [
  { value: 'local', label: 'Agent only (keep in run history)' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'discord', label: 'Discord' },
  { value: 'email', label: 'Email' },
];

const FREQUENCY_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

// Quick one-click day sets for the weekly view.
const WEEKLY_PRESETS: { label: string; days: number[] }[] = [
  { label: 'Weekdays', days: [1, 2, 3, 4, 5] },
  { label: 'Every day', days: [0, 1, 2, 3, 4, 5, 6] },
  { label: 'Weekends', days: [0, 6] },
];

const HOUR_OPTIONS = Array.from({ length: 12 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));
const MERIDIEM_OPTIONS = [
  { value: 'AM', label: 'AM' },
  { value: 'PM', label: 'PM' },
];
const DAY_OF_MONTH_OPTIONS = Array.from({ length: 31 }, (_, i) => ({
  value: String(i + 1),
  label: String(i + 1),
}));

const segButtonStyle = (active: boolean): React.CSSProperties => ({
  border: '1px solid var(--etched-border)',
  background: active ? 'var(--ink-black)' : 'transparent',
  color: active ? 'var(--bg-surface)' : 'var(--ink-black)',
  padding: '8px 14px',
  minHeight: 40,
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  flex: '1 1 auto',
});

// The overlay covers only the visible viewport and the dialog is capped to it, so
// the pinned header and Save stay on screen behind iOS toolbars and the keyboard.
const OVERLAY_PADDING = 'clamp(8px, 4vw, 16px)';
const MODAL_MAX_HEIGHT = `calc(var(--workspace-viewport-height, 100dvh) - 2 * ${OVERLAY_PADDING} - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))`;
const FORM_GUTTER = 'clamp(20px, 5vw, 32px)';

const presetButtonStyle: React.CSSProperties = {
  border: '1px solid var(--etched-border)',
  background: 'transparent',
  color: 'var(--ink-black)',
  padding: '8px 12px',
  minHeight: 40,
  fontSize: 10,
  cursor: 'pointer',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  opacity: 0.8,
};

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function hasFinePointer(): boolean {
  try {
    return window.matchMedia?.('(pointer: fine)').matches ?? false;
  } catch {
    return false;
  }
}

type TaskDraft = { name: string; command: string; status: 'active' | 'paused'; deliver: string; agentId: string; profileName: string; schedule: string };
const draftKey = (d: TaskDraft) => JSON.stringify([d.name, d.command, d.status, d.deliver, d.agentId, d.profileName, d.schedule]);

// Mounted inside the portal so the dialog node exists when focus moves in. Tab
// wraps inside and focus returns to the opener. Escape closes only when
// closeOnEscape is set (an untouched form), never mid-IME composition, and never
// while a StyledDropdown is open: its menu portals outside the dialog, takes
// focus after a short delay and handles its own Escape.
function TaskDialogFrame({ onClose, closeOnEscape, children }: { onClose: () => void; closeOnEscape: boolean; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const closeOnEscapeRef = useRef(closeOnEscape);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { closeOnEscapeRef.current = closeOnEscape; }, [closeOnEscape]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    (focusable()[0] ?? dialog).focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target instanceof Node ? event.target : null;
      if (target && target !== document.body && !dialog.contains(target)) return;
      if (event.key === 'Escape') {
        if (dialog.querySelector('[aria-expanded="true"]')) return;
        event.preventDefault();
        if (closeOnEscapeRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 'var(--workspace-viewport-height, 100dvh)', boxSizing: 'border-box', background: 'var(--overlay-bg)', backdropFilter: 'blur(4px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: OVERLAY_PADDING }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="task-modal-title" tabIndex={-1} className="interrogation-box" style={{ background: "var(--vellum-bg)", width: '100%', maxWidth: 700, padding: 0, boxShadow: '0 20px 40px rgba(0,0,0,0.1)', maxHeight: MODAL_MAX_HEIGHT, overflowY: 'auto', overscrollBehavior: 'contain', outline: 'none' }}>
        {children}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  display: 'block',
  marginBottom: 8,
  opacity: 0.6,
  fontWeight: 700,
  textTransform: 'uppercase',
};

export function TaskModal({
  isOpen,
  onClose,
  onSave,
  saving,
  agents,
  editingJobInitial,
  editingAgentId,
  editingProfileName,
  agentName,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: { name: string, schedule: string, command: string, agentId: string, profileName: string, status: 'active' | 'paused', deliver: string }, isEdit: boolean) => void;
  saving: boolean;
  agents: Agent[];
  editingJobInitial: LiveJob | null;
  editingAgentId: string;
  editingProfileName: string;
  /** Names the agent in the copy; falls back to "your agent". */
  agentName?: string;
}) {
  const [formName, setFormName] = useState('');
  const [formCommand, setFormCommand] = useState('');
  const [formAgentId, setFormAgentId] = useState('');
  const [formProfileName, setFormProfileName] = useState('default');
  const [formStatus, setFormStatus] = useState<'active'|'paused'>('active');
  const [formDeliver, setFormDeliver] = useState<string>(DEFAULT_DELIVER);

  // Friendly schedule model. The raw cron string is derived from this on save;
  // `advancedCron` is only set when an existing job's cron can't be represented
  // by the builder (the raw-cron escape hatch shows in that case).
  const [frequency, setFrequency] = useState<Frequency>(DEFAULT_FRIENDLY_SCHEDULE.frequency);
  const [minute, setMinute] = useState(DEFAULT_FRIENDLY_SCHEDULE.minute);
  const [hour, setHour] = useState(DEFAULT_FRIENDLY_SCHEDULE.hour);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(DEFAULT_FRIENDLY_SCHEDULE.daysOfWeek);
  const [dayOfMonth, setDayOfMonth] = useState(DEFAULT_FRIENDLY_SCHEDULE.dayOfMonth);
  const [advancedCron, setAdvancedCron] = useState<string | null>(null);

  const [profiles, setProfiles] = useState<{name: string, display_name?: string}[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  // The draft as the modal opened it; Escape only closes while the form still matches.
  const [pristineKey, setPristineKey] = useState<string | null>(null);
  const commandRef = useRef<HTMLTextAreaElement>(null);

  const applyFriendly = (f: FriendlySchedule): FriendlySchedule => {
    const applied: FriendlySchedule = {
      ...f,
      daysOfWeek: f.frequency === 'weekly' ? f.daysOfWeek : DEFAULT_FRIENDLY_SCHEDULE.daysOfWeek,
      dayOfMonth: f.frequency === 'monthly' ? f.dayOfMonth : DEFAULT_FRIENDLY_SCHEDULE.dayOfMonth,
    };
    setFrequency(applied.frequency);
    setMinute(applied.minute);
    setHour(applied.hour);
    setDaysOfWeek(applied.daysOfWeek);
    setDayOfMonth(applied.dayOfMonth);
    return applied;
  };

  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen) {
      if (editingJobInitial) {
        const initial: TaskDraft = {
          name: editingJobInitial.name || '',
          command: editingJobInitial.command || '',
          status: editingJobInitial.enabled ? 'active' : 'paused',
          // Preserve the existing job's delivery target; blank/unknown -> "local".
          deliver: editingJobInitial.deliver || DEFAULT_DELIVER,
          agentId: editingAgentId,
          profileName: editingProfileName || 'default',
          schedule: '',
        };
        setFormName(initial.name);
        setFormCommand(initial.command);
        setFormStatus(initial.status);
        setFormDeliver(initial.deliver);
        setFormAgentId(initial.agentId);
        setFormProfileName(initial.profileName);
        const parsed = friendlyFromCron(editingJobInitial.schedule || '');
        if (parsed) {
          initial.schedule = cronFromFriendly(applyFriendly(parsed));
          setAdvancedCron(null);
        } else {
          // Keep an editable raw expression for schedules the builder can't model.
          applyFriendly(DEFAULT_FRIENDLY_SCHEDULE);
          initial.schedule = editingJobInitial.schedule || DEFAULT_NEW_TASK_SCHEDULE;
          setAdvancedCron(initial.schedule);
        }
        setPristineKey(draftKey(initial));
      } else {
        setFormName('');
        setFormCommand('');
        setFormStatus('active');
        setFormDeliver(DEFAULT_DELIVER);
        const schedule = cronFromFriendly(applyFriendly(DEFAULT_FRIENDLY_SCHEDULE));
        setAdvancedCron(null);
        const defaultAgent = agents.find(a => a.status === 'running') || agents[0];
        const agentId = defaultAgent ? defaultAgent.id : '';
        setFormAgentId(agentId);
        setFormProfileName('default');
        setPristineKey(draftKey({ name: '', command: '', status: 'active', deliver: DEFAULT_DELIVER, agentId, profileName: 'default', schedule }));
      }
    }
  }, [isOpen, editingJobInitial, agents, editingAgentId, editingProfileName]);

  useEffect(() => {
    if (formAgentId) fetchProfiles(formAgentId);
    else setProfiles([]);
  }, [formAgentId]);

  const fetchProfiles = async (instanceId: string) => {
    setProfilesLoading(true);
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/profiles`);
      const data = await res.json();
      if (data.success) {
         setProfiles(data.data);
      }
    } catch (err) {
      clientLog.error("Failed to fetch scheduled task profiles", err, {
        source: "task-modal",
        instanceId,
        failureType: "task_modal_profiles_fetch_failed",
      });
    }
    finally { setProfilesLoading(false); }
  };

  const statusOptions = [
    { value: 'active', label: 'Scheduled' },
    { value: 'paused', label: 'Paused' },
  ];
  const agentLabel = agentName?.trim() || 'your agent';
  
  const agentDropdownOptions = [
    ...agents.map(a => ({ value: a.id, label: `${a.name} (${a.status})` }))
  ];

  // Derived schedule. `friendly` mirrors the builder state; `resolvedSchedule`
  // is the raw cron handed to the backend (advanced raw string wins when set).
  const friendly: FriendlySchedule = { frequency, minute, hour, daysOfWeek, dayOfMonth };
  const resolvedSchedule = advancedCron != null ? advancedCron : cronFromFriendly(friendly);
  const usingAdvanced = advancedCron != null;
  const pristine = pristineKey !== null && pristineKey === draftKey({
    name: formName, command: formCommand, status: formStatus, deliver: formDeliver,
    agentId: formAgentId, profileName: formProfileName, schedule: resolvedSchedule,
  });

  const { hour12, meridiem } = to12Hour(hour);

  // Minute options in 5-minute steps, always including the current value so an
  // edited task that fires at e.g. :07 keeps its exact minute.
  const minuteOptions = useMemo(() => {
    const set = new Set<number>();
    for (let i = 0; i < 60; i += 5) set.add(i);
    set.add(minute);
    return Array.from(set)
      .sort((a, b) => a - b)
      .map((m) => ({ value: String(m), label: `:${String(m).padStart(2, '0')}` }));
  }, [minute]);

  const toggleDay = (d: number) => {
    setDaysOfWeek((prev) => {
      if (prev.includes(d)) {
        const next = prev.filter((x) => x !== d);
        return next.length === 0 ? prev : next; // always keep at least one day
      }
      return [...prev, d].sort((a, b) => a - b);
    });
  };

  // The dropdown trigger reserves ~70px for padding and chevron, so fixed 72-84px
  // cells clipped "9", ":00" and "AM"; three shared columns keep each value visible.
  const timePicker = (
    <div role="group" aria-label="Time" style={{ display: 'grid', gap: 6, width: '100%', maxWidth: 320 }}>
      <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>at</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 1fr)', gap: 8 }}>
        <StyledDropdown
          value={String(hour12)}
          onChange={(val) => setHour(to24Hour(Number(val), meridiem))}
          options={HOUR_OPTIONS}
        />
        <StyledDropdown value={String(minute)} onChange={(val) => setMinute(Number(val))} options={minuteOptions} />
        <StyledDropdown
          value={meridiem}
          onChange={(val) => setHour(to24Hour(hour12, val as 'AM' | 'PM'))}
          options={MERIDIEM_OPTIONS}
        />
      </div>
    </div>
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      name: formName,
      schedule: resolvedSchedule,
      command: formCommand,
      agentId: formAgentId,
      profileName: formProfileName,
      status: formStatus,
      deliver: formDeliver || DEFAULT_DELIVER
    }, !!editingJobInitial);
  };

  if (!isOpen) return null;

  return (
    <SafePortal>
      <TaskDialogFrame onClose={onClose} closeOnEscape={pristine}>
          <div style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--vellum-bg)', padding: 'clamp(16px, 4vw, 24px) clamp(16px, 5vw, 32px)', borderBottom: '1px solid var(--etched-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
             <div style={{ minWidth: 0 }}>
                <h2 id="task-modal-title" className="serif" style={{ fontSize: '1.5rem', margin: 0, color: 'var(--ink-black)' }}>{editingJobInitial ? 'Edit scheduled task' : 'New scheduled task'}</h2>
                <div className="mono" style={{ fontSize: 11, marginTop: 8, opacity: 0.6 }}>
                  {editingJobInitial ? 'Adjust what runs and when it fires.' : `Tell ${agentLabel} what to do and when.`}
                </div>
             </div>
             <button type="button" onClick={onClose} aria-label="Close" style={{ flexShrink: 0, width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, background: 'transparent', border: '1px solid var(--etched-border)', cursor: 'pointer', color: 'var(--text-muted)' }}><X size={16} /></button>
          </div>
          <form onSubmit={handleSubmit} style={{ padding: `${FORM_GUTTER} ${FORM_GUTTER} 0` }}>
             <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {!editingJobInitial && (
                  <div style={{ border: '1px solid var(--etched-border)', background: 'rgba(0,0,0,0.025)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.6 }}>
                      Quick Start
                    </div>
                    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--ink-black)' }}>
                      Scheduled tasks let your agent run on its own. Example: every weekday at 9am, review new leads and send me a summary.
                    </p>
                  </div>
                )}

                <div>
                  <label htmlFor="task-modal-name" className="mono" style={{ fontSize: 10, display: 'block', marginBottom: 8, opacity: 0.6, fontWeight: 700, textTransform: 'uppercase' }}>Name</label>
                  <input
                    id="task-modal-name"
                    type="text"
                    required
                    value={formName}
                    onChange={e => setFormName(e.target.value)}
                    // The touch keyboard labels Enter "next", so it moves on instead of saving; a physical keyboard keeps Enter-to-save.
                    onKeyDown={e => {
                      if (e.key !== 'Enter' || e.nativeEvent.isComposing || hasFinePointer()) return;
                      e.preventDefault();
                      commandRef.current?.focus();
                    }}
                    enterKeyHint="next"
                    className="terminal-light"
                    placeholder="e.g., Morning inbox summary"
                    style={{ width: '100%', padding: '12px', fontSize: 13 }}
                  />
                </div>

                <div>
                  <label className="mono" style={labelStyle}>Schedule</label>

                  {usingAdvanced ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <input
                        type="text"
                        required
                        value={advancedCron ?? ''}
                        onChange={e => setAdvancedCron(e.target.value)}
                        aria-label="Custom schedule (cron)"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        className="terminal-light"
                        placeholder="0 9 * * *"
                        style={{ width: '100%', padding: '12px', fontSize: 13, fontFamily: 'var(--font-mono)' }}
                      />
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.5 }}>
                          This task uses a custom schedule.
                        </span>
                        <button
                          type="button"
                          onClick={() => { setAdvancedCron(null); applyFriendly(DEFAULT_FRIENDLY_SCHEDULE); }}
                          className="mono"
                          style={{ background: 'none', border: 'none', padding: '8px 12px', minHeight: 40, cursor: 'pointer', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--ink-black)', textDecoration: 'underline' }}
                        >
                          Use simple schedule
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        {FREQUENCY_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => setFrequency(opt.value)}
                            style={segButtonStyle(frequency === opt.value)}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>

                      {frequency === 'hourly' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>at</span>
                          <div style={{ width: 100 }}>
                            <StyledDropdown value={String(minute)} onChange={(val) => setMinute(Number(val))} options={minuteOptions} />
                          </div>
                          <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>past every hour</span>
                        </div>
                      )}

                      {frequency === 'daily' && timePicker}

                      {frequency === 'weekly' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                          {/* One row of seven: each day shrinks to fit a 360px phone rather than wrapping Saturday. */}
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'nowrap' }}>
                            {DAY_INITIALS.map((initial, idx) => {
                              const active = daysOfWeek.includes(idx);
                              return (
                                <button
                                  key={idx}
                                  type="button"
                                  onClick={() => toggleDay(idx)}
                                  title={DAY_LABELS[idx]}
                                  aria-label={DAY_LABELS[idx]}
                                  aria-pressed={active}
                                  style={{
                                    flex: '1 1 0',
                                    minWidth: 34,
                                    maxWidth: 40,
                                    height: 40,
                                    padding: 0,
                                    border: '1px solid var(--etched-border)',
                                    background: active ? 'var(--ink-black)' : 'transparent',
                                    color: active ? 'var(--bg-surface)' : 'var(--ink-black)',
                                    cursor: 'pointer',
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 12,
                                    fontWeight: 700,
                                  }}
                                >
                                  {initial}
                                </button>
                              );
                            })}
                          </div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {WEEKLY_PRESETS.map((preset) => (
                              <button
                                key={preset.label}
                                type="button"
                                onClick={() => setDaysOfWeek(preset.days)}
                                className="mono"
                                style={presetButtonStyle}
                              >
                                {preset.label}
                              </button>
                            ))}
                          </div>
                          {timePicker}
                        </div>
                      )}

                      {frequency === 'monthly' && (
                        // "on day" stacks above its dropdown like "at" does, so both rows of dropdowns line up.
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px 16px', flexWrap: 'wrap' }}>
                          <div role="group" aria-label="Day of month" style={{ display: 'grid', gap: 6, width: 96 }}>
                            <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>on day</span>
                            <StyledDropdown value={String(dayOfMonth)} onChange={(val) => setDayOfMonth(Number(val))} options={DAY_OF_MONTH_OPTIONS} />
                          </div>
                          {timePicker}
                        </div>
                      )}

                      <p style={{ margin: 0, fontSize: 11, opacity: 0.6, lineHeight: 1.5 }}>
                        Runs <strong style={{ fontWeight: 600, opacity: 0.9 }}>{describeFriendly(friendly).toLowerCase()}</strong> in the agent&rsquo;s timezone.
                      </p>
                    </div>
                  )}
                </div>

                <div>
                  <label className="mono" style={labelStyle}>Status</label>
                  <div style={{ maxWidth: 320 }}>
                    <StyledDropdown value={formStatus} onChange={val => setFormStatus(val as 'active'|'paused')} options={statusOptions} />
                  </div>
                </div>

                <div>
                  <label className="mono" style={labelStyle}>Deliver results to</label>
                  <div style={{ maxWidth: 320 }}>
                    <StyledDropdown value={formDeliver} onChange={setFormDeliver} options={DELIVER_OPTIONS} />
                  </div>
                  <p style={{ margin: '8px 0 0', fontSize: 11, opacity: 0.6, lineHeight: 1.5 }}>
                    Where {agentName?.trim() || 'the agent'} sends the result when this task fires. Default keeps it in the agent&rsquo;s run history.
                  </p>
                </div>

                <div>
                  <label className="mono" style={{ fontSize: 10, display: 'block', marginBottom: 8, opacity: 0.6, fontWeight: 700, textTransform: 'uppercase' }}>
                     Instructions for Agent
                  </label>
                  <textarea 
                    ref={commandRef}
                    required 
                    value={formCommand} 
                    onChange={e => setFormCommand(e.target.value)} 
                    className="terminal-light" 
                    placeholder="Check Twitter for updates and summarize the latest trends..." 
                    style={{ width: '100%', padding: '12px', fontSize: 13, fontFamily: 'var(--font-serif)', minHeight: 120, resize: 'vertical', overflow: 'auto' }} 
                  />
                  {!editingJobInitial && (
                    <p style={{ margin: '8px 0 0', fontSize: 11, opacity: 0.6, lineHeight: 1.5 }}>
                      Be specific about the outcome you want. Example: “Scan our inbox for urgent customer issues and post a summary in Slack.”
                    </p>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: '1.5rem' }}>
                   {agents.length > 1 && (
                     <div>
                       <label className="mono" style={{ fontSize: 10, display: 'block', marginBottom: 8, opacity: 0.6, fontWeight: 700, textTransform: 'uppercase' }}>Target Agent <span style={{ color: '#ef4444' }}>*</span></label>
                       <StyledDropdown disabled={!!editingJobInitial} value={formAgentId} onChange={setFormAgentId} options={agentDropdownOptions} />
                     </div>
                   )}
                   <div>
                     <label className="mono" style={{ fontSize: 10, display: 'block', marginBottom: 8, opacity: 0.6, fontWeight: 700, textTransform: 'uppercase' }}>
                        Target Profile {profilesLoading && <Loader2 size={10} className="animate-spin" style={{ display: 'inline', marginLeft: 4 }} />}
                     </label>
                     {agents.length === 0 ? (
                       <input 
                         type="text" 
                         required 
                         disabled={!!editingJobInitial}
                         value={formProfileName} 
                         onChange={e => setFormProfileName(e.target.value)} 
                         autoCapitalize="none"
                         autoCorrect="off"
                         spellCheck={false}
                         className="terminal-light" 
                         placeholder="e.g. default, coder" 
                         style={{ width: '100%', padding: '12px', fontSize: 13, fontFamily: 'var(--font-mono)' }} 
                       />
                     ) : (
                       <StyledDropdown 
                         disabled={!!editingJobInitial}
                         value={formProfileName} 
                         onChange={setFormProfileName} 
                         options={
                           !formAgentId 
                             ? [{ value: '', label: '-- Select Target Agent First --' }]
                             : profiles.length > 0 
                               ? profiles.map(p => ({ 
                                   value: p.name, 
                                   label: p.name === 'default' 
                                          ? `${agents.find(a => a.id === formAgentId)?.name || 'Main Instance'} Core (default)` 
                                          : p.display_name ? `${p.display_name} (${p.name})` : p.name 
                                 }))
                               : [{ value: formProfileName || 'default', label: formProfileName || 'default' }]
                         }
                       />
                     )}
                   </div>
                </div>
             </div>
             {/* Pinned to the bottom of the scrolling modal so Save is always reachable. */}
             <div style={{ position: 'sticky', bottom: 0, zIndex: 2, background: 'var(--vellum-bg)', borderTop: '1px solid var(--etched-border)', display: 'flex', justifyContent: 'flex-end', gap: 12, flexWrap: 'wrap', margin: `2.5rem calc(-1 * ${FORM_GUTTER}) 0`, padding: `14px ${FORM_GUTTER}` }}>
                <button type="button" onClick={onClose} style={{ background: 'transparent', color: 'var(--ink-black)', border: 'none', padding: '10px 24px', minHeight: 44, fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontWeight: 700, textTransform: 'uppercase' }}>Cancel</button>
                <button type="submit" disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--ink-black)', color: "var(--bg-surface)", border: 'none', padding: '10px 32px', minHeight: 44, fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontWeight: 700, textTransform: 'uppercase' }}>
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  {saving ? 'Saving…' : 'Save task'}
                </button>
             </div>
          </form>
      </TaskDialogFrame>
    </SafePortal>
  );
}
