import React, { useState, useEffect, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
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
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  flex: '1 1 auto',
});

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
  editingProfileName
}: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: { name: string, schedule: string, command: string, agentId: string, profileName: string, status: 'active' | 'paused', deliver: string }, isEdit: boolean) => void;
  saving: boolean;
  agents: Agent[];
  editingJobInitial: LiveJob | null;
  editingAgentId: string;
  editingProfileName: string;
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

  const applyFriendly = (f: FriendlySchedule) => {
    setFrequency(f.frequency);
    setMinute(f.minute);
    setHour(f.hour);
    setDaysOfWeek(f.frequency === 'weekly' ? f.daysOfWeek : DEFAULT_FRIENDLY_SCHEDULE.daysOfWeek);
    setDayOfMonth(f.frequency === 'monthly' ? f.dayOfMonth : DEFAULT_FRIENDLY_SCHEDULE.dayOfMonth);
  };

  // Initialize form when modal opens
  useEffect(() => {
    if (isOpen) {
      if (editingJobInitial) {
        setFormName(editingJobInitial.name || '');
        setFormCommand(editingJobInitial.command || '');
        setFormStatus(editingJobInitial.enabled ? 'active' : 'paused');
        // Preserve the existing job's delivery target; blank/unknown -> "local".
        setFormDeliver(editingJobInitial.deliver || DEFAULT_DELIVER);
        setFormAgentId(editingAgentId);
        setFormProfileName(editingProfileName || 'default');
        const parsed = friendlyFromCron(editingJobInitial.schedule || '');
        if (parsed) {
          applyFriendly(parsed);
          setAdvancedCron(null);
        } else {
          // Keep an editable raw expression for schedules the builder can't model.
          applyFriendly(DEFAULT_FRIENDLY_SCHEDULE);
          setAdvancedCron(editingJobInitial.schedule || DEFAULT_NEW_TASK_SCHEDULE);
        }
      } else {
        setFormName('');
        setFormCommand('');
        setFormStatus('active');
        setFormDeliver(DEFAULT_DELIVER);
        applyFriendly(DEFAULT_FRIENDLY_SCHEDULE);
        setAdvancedCron(null);
        const defaultAgent = agents.find(a => a.status === 'running') || agents[0];
        setFormAgentId(defaultAgent ? defaultAgent.id : '');
        setFormProfileName('default');
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
    { value: 'active', label: 'ACTIVE (SCHEDULED)' },
    { value: 'paused', label: 'DRAFT (PAUSED)' },
  ];
  
  const agentDropdownOptions = [
    ...agents.map(a => ({ value: a.id, label: `${a.name} (${a.status})` }))
  ];

  // Derived schedule. `friendly` mirrors the builder state; `resolvedSchedule`
  // is the raw cron handed to the backend (advanced raw string wins when set).
  const friendly: FriendlySchedule = { frequency, minute, hour, daysOfWeek, dayOfMonth };
  const resolvedSchedule = advancedCron != null ? advancedCron : cronFromFriendly(friendly);
  const usingAdvanced = advancedCron != null;

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

  const timePicker = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>at</span>
      <div style={{ width: 72 }}>
        <StyledDropdown
          value={String(hour12)}
          onChange={(val) => setHour(to24Hour(Number(val), meridiem))}
          options={HOUR_OPTIONS}
        />
      </div>
      <div style={{ width: 84 }}>
        <StyledDropdown value={String(minute)} onChange={(val) => setMinute(Number(val))} options={minuteOptions} />
      </div>
      <div style={{ width: 80 }}>
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
      <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay-bg)', backdropFilter: 'blur(4px)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'clamp(8px, 4vw, 16px)' }}>
         <div className="interrogation-box" style={{ background: "var(--vellum-bg)", width: '100%', maxWidth: 700, padding: 0, boxShadow: '0 20px 40px rgba(0,0,0,0.1)', maxHeight: '95vh', overflowY: 'auto' }}>
          <div style={{ padding: 'clamp(16px, 4vw, 24px) clamp(16px, 5vw, 32px)', borderBottom: '1px solid var(--etched-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
             <div>
                <h2 className="serif" style={{ fontSize: '1.5rem', margin: 0, color: 'var(--ink-black)' }}>{editingJobInitial ? 'Configure Task Request' : 'Define New Task'}</h2>
                <div className="mono" style={{ fontSize: 10, marginTop: 8, opacity: 0.5 }}>
                  {editingJobInitial ? 'Adjust what runs and when it fires.' : 'Tell Hermes what to run and when it should fire.'}
                </div>
             </div>
             <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>✕</button>
          </div>
          <form onSubmit={handleSubmit} style={{ padding: 'clamp(20px, 5vw, 32px)' }}>
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
                  <label className="mono" style={{ fontSize: 10, display: 'block', marginBottom: 8, opacity: 0.6, fontWeight: 700, textTransform: 'uppercase' }}>Task Identifier</label>
                  <input type="text" required value={formName} onChange={e => setFormName(e.target.value)} className="terminal-light" placeholder="e.g., Target Purge" style={{ width: '100%', padding: '12px', fontSize: 13 }} />
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
                          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--ink-black)', textDecoration: 'underline' }}
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
                          <div style={{ width: 84 }}>
                            <StyledDropdown value={String(minute)} onChange={(val) => setMinute(Number(val))} options={minuteOptions} />
                          </div>
                          <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>past every hour</span>
                        </div>
                      )}

                      {frequency === 'daily' && timePicker}

                      {frequency === 'weekly' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {DAY_INITIALS.map((initial, idx) => {
                              const active = daysOfWeek.includes(idx);
                              return (
                                <button
                                  key={idx}
                                  type="button"
                                  onClick={() => toggleDay(idx)}
                                  title={DAY_LABELS[idx]}
                                  style={{
                                    width: 38,
                                    height: 38,
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
                                style={{
                                  border: '1px solid var(--etched-border)',
                                  background: 'transparent',
                                  color: 'var(--ink-black)',
                                  padding: '4px 10px',
                                  fontSize: 10,
                                  cursor: 'pointer',
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.04em',
                                  opacity: 0.8,
                                }}
                              >
                                {preset.label}
                              </button>
                            ))}
                          </div>
                          {timePicker}
                        </div>
                      )}

                      {frequency === 'monthly' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>on day</span>
                          <div style={{ width: 80 }}>
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
                  <label className="mono" style={labelStyle}>Initial Status</label>
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
                    Where {`the agent`} sends the result when this task fires. Default keeps it in the agent&rsquo;s run history.
                  </p>
                </div>

                <div>
                  <label className="mono" style={{ fontSize: 10, display: 'block', marginBottom: 8, opacity: 0.6, fontWeight: 700, textTransform: 'uppercase' }}>
                     Instructions for Agent
                  </label>
                  <textarea 
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
             <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, marginTop: '2.5rem' }}>
                <button type="button" onClick={onClose} style={{ background: 'transparent', color: 'var(--ink-black)', border: 'none', padding: '10px 24px', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontWeight: 700, textTransform: 'uppercase' }}>Cancel</button>
                <button type="submit" disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--ink-black)', color: "var(--bg-surface)", border: 'none', padding: '10px 32px', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontWeight: 700, textTransform: 'uppercase' }}>
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  {saving ? 'Transmitting...' : (editingJobInitial ? 'Update Task' : 'Commit Tasks')}
                </button>
             </div>
          </form>
         </div>
      </div>
    </SafePortal>
  );
}
