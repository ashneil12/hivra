import React from 'react';
import { AlertTriangle } from 'lucide-react';

// One-click churn reasons. Optional + non-blocking — the user can confirm the
// delete without picking one. 'other' reveals a free-text note.
export type DeleteReason =
  | 'too_slow'
  | 'didnt_work'
  | 'too_expensive'
  | 'just_testing'
  | 'other';

export const DELETE_REASON_OPTIONS: ReadonlyArray<{ value: DeleteReason; label: string }> = [
  { value: 'too_slow', label: 'Too slow' },
  { value: 'didnt_work', label: "Didn't work" },
  { value: 'too_expensive', label: 'Too expensive' },
  { value: 'just_testing', label: 'Just testing' },
  { value: 'other', label: 'Other' },
];

interface DangerZoneProps {
  instanceId: string;
  deleteConfirm: boolean;
  setDeleteConfirm: React.Dispatch<React.SetStateAction<boolean>>;
  deleteInputText: string;
  setDeleteInputText: React.Dispatch<React.SetStateAction<string>>;
  actionLoading: boolean;
  handleDeleteInstance: () => void;
  deleteReason: DeleteReason | null;
  setDeleteReason: React.Dispatch<React.SetStateAction<DeleteReason | null>>;
  deleteReasonNote: string;
  setDeleteReasonNote: React.Dispatch<React.SetStateAction<string>>;
}

export function ConfigurationDangerZone({
  instanceId,
  deleteConfirm,
  setDeleteConfirm,
  deleteInputText,
  setDeleteInputText,
  actionLoading,
  handleDeleteInstance,
  deleteReason,
  setDeleteReason,
  deleteReasonNote,
  setDeleteReasonNote
}: DangerZoneProps) {
  return (
    <>
      <div style={{ marginTop: '2rem', padding: '2rem', border: '1px dashed rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.02)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--red)' }}>
          <AlertTriangle size={18} />
          <h3 className="serif" style={{ fontSize: '1.25rem', margin: 0, fontWeight: 700 }}>Danger Zone</h3>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Once you delete an instance, there is no going back with data recovery.
        </div>
        
        <button 
          type="button" 
          onClick={() => setDeleteConfirm(true)} 
          disabled={actionLoading} 
          style={{ width: '100%', border: '1px solid rgba(239,68,68,0.6)', background: "var(--bg-surface)", color: 'var(--red)', padding: '12px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em' }}
        >
          {actionLoading ? 'Working...' : 'Delete Instance'}
        </button>
      </div>

      {deleteConfirm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}>
          <div style={{ background: 'var(--bg-elevated)', width: '90%', maxWidth: 480, border: '1px solid rgba(239,68,68,0.3)', borderRadius: 0, boxShadow: '0 16px 48px rgba(0,0,0,0.5)', overflow: 'hidden' }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgba(239,68,68,0.2)', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(239,68,68,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <AlertTriangle size={20} style={{ color: 'var(--red)' }} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--ink-black)' }}>Delete Instance</h3>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>This action cannot be undone</p>
              </div>
            </div>
            
            <div style={{ padding: '20px 24px' }}>
              <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 16px' }}>
                You are about to permanently delete this instance. All data, conversations, memory, and configurations will be lost.
              </p>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Please type <strong style={{color: 'var(--red)', fontFamily: 'var(--font-mono)'}}>{instanceId}</strong> to confirm.
              </div>
              <input 
                type="text" 
                value={deleteInputText}
                onChange={(e) => setDeleteInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && deleteInputText === instanceId) {
                    handleDeleteInstance();
                  }
                  if (e.key === 'Escape') {
                    setDeleteInputText('');
                    setDeleteReason(null);
                    setDeleteReasonNote('');
                    setDeleteConfirm(false);
                  }
                }}
                placeholder="Type to confirm..."
                autoFocus
                style={{ width: '100%', border: '1px solid var(--etched-border)', background: "var(--bg-surface)", padding: '12px 14px', fontSize: 13, fontFamily: 'var(--font-mono), monospace', borderRadius: 0, boxSizing: 'border-box' }}
              />

              {/* Optional churn reason. Never blocks the delete — purely for us
                  to learn why agents get torn down. */}
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: 'var(--font-mono)', marginBottom: 10 }}>
                  Why are you deleting? <span style={{ textTransform: 'none', letterSpacing: 0, opacity: 0.7 }}>(optional)</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {DELETE_REASON_OPTIONS.map((option) => {
                    const active = deleteReason === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setDeleteReason(active ? null : option.value)}
                        style={{
                          border: active ? '1px solid var(--ink-black)' : '1px solid var(--etched-border)',
                          background: active ? 'var(--ink-black)' : 'var(--bg-surface)',
                          color: active ? 'var(--bg-surface)' : 'var(--text-secondary)',
                          padding: '7px 12px',
                          fontSize: 12,
                          cursor: 'pointer',
                          fontFamily: 'var(--font-mono)',
                          borderRadius: 0,
                        }}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                {deleteReason === 'other' && (
                  <textarea
                    value={deleteReasonNote}
                    onChange={(e) => setDeleteReasonNote(e.target.value)}
                    placeholder="Tell us more (optional)"
                    rows={2}
                    maxLength={2000}
                    style={{ width: '100%', marginTop: 10, border: '1px solid var(--etched-border)', background: 'var(--bg-surface)', padding: '10px 12px', fontSize: 13, fontFamily: 'var(--font-sans), sans-serif', borderRadius: 0, boxSizing: 'border-box', resize: 'vertical' }}
                  />
                )}
              </div>
            </div>
            
            <div style={{ padding: '16px 24px', borderTop: '1px solid var(--etched-border)', display: 'flex', gap: '12px', background: 'var(--bg-surface)' }}>
              <button 
                type="button" 
                onClick={() => {
                  setDeleteInputText('');
                  setDeleteReason(null);
                  setDeleteReasonNote('');
                  setDeleteConfirm(false);
                }}
                disabled={actionLoading}
                style={{ flex: 1, border: '1px solid var(--etched-border)', background: "var(--bg-surface)", color: 'var(--text-muted)', padding: '10px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em', borderRadius: 0 }}
              >
                Cancel
              </button>
              <button 
                type="button" 
                onClick={handleDeleteInstance} 
                disabled={actionLoading || deleteInputText !== instanceId}
                style={{ flex: 1, border: '1px solid var(--red)', background: 'var(--red)', color: "var(--bg-surface)", padding: '10px 14px', fontSize: 12, fontWeight: 600, cursor: actionLoading || deleteInputText !== instanceId ? 'not-allowed' : 'pointer', opacity: actionLoading || deleteInputText !== instanceId ? 0.5 : 1, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em', borderRadius: 0 }}
              >
                {actionLoading ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
