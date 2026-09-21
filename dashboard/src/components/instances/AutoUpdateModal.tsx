'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Clock3, Loader2 } from 'lucide-react';

import { SafePortal } from '@/components/ui/SafePortal';
import {
  buildHermesOverlayVariants,
  buildHermesSurfaceSpring,
  buildHermesSurfaceVariants,
} from '@/components/ui/motion';
import {
  DEFAULT_AUTO_UPDATE_TIME,
  normalizeAutoUpdateTime,
  type AutoUpdateConfig,
} from '@/lib/instance-settings';

interface AutoUpdateSaveResult {
  autoUpdateApplied?: boolean;
  autoUpdateError?: string | null;
}

interface AutoUpdateModalProps {
  open: boolean;
  onClose: () => void;
  initialConfig?: AutoUpdateConfig;
  onSave: (config: AutoUpdateConfig) => Promise<AutoUpdateSaveResult>;
}

type FeedbackTone = 'success' | 'warning' | 'error';

function buildFeedback(params: {
  enabled: boolean;
  time: string;
  result: AutoUpdateSaveResult;
}): { tone: FeedbackTone; message: string } {
  const { enabled, time, result } = params;

  if (result.autoUpdateError) {
    return {
      tone: 'warning',
      message: result.autoUpdateError,
    };
  }

  if (enabled) {
    return {
      tone: 'success',
      message: `Daily auto-update is enabled. Hermes will refresh this instance every day at ${time} UTC.`,
    };
  }

  return {
    tone: 'success',
    message: 'Daily auto-update is disabled for this instance.',
  };
}

export function AutoUpdateModal({
  open,
  onClose,
  initialConfig,
  onSave,
}: AutoUpdateModalProps) {
  const [enabled, setEnabled] = useState(initialConfig?.enabled ?? true);
  const [time, setTime] = useState(
    normalizeAutoUpdateTime(initialConfig?.time) ?? DEFAULT_AUTO_UPDATE_TIME
  );
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: FeedbackTone;
    message: string;
  } | null>(null);
  const wasOpenRef = useRef(false);
  const reduceMotion = useReducedMotion();
  const overlayVariants = buildHermesOverlayVariants(Boolean(reduceMotion));
  const modalVariants = buildHermesSurfaceVariants(Boolean(reduceMotion), {
    offset: 20,
    scale: 0.985,
    spring: 'panel',
  });
  const buttonSpring = buildHermesSurfaceSpring(Boolean(reduceMotion), 'dock');
  const tapScale = reduceMotion ? undefined : { scale: 0.97 };

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setEnabled(initialConfig?.enabled ?? true);
      setTime(normalizeAutoUpdateTime(initialConfig?.time) ?? DEFAULT_AUTO_UPDATE_TIME);
      setFeedback(null);
    }

    wasOpenRef.current = open;
  }, [open, initialConfig]);

  const handleSave = async () => {
    const normalizedTime = normalizeAutoUpdateTime(time) ?? DEFAULT_AUTO_UPDATE_TIME;
    setSaving(true);
    setFeedback(null);

    try {
      const result = await onSave({
        enabled,
        time: normalizedTime,
      });
      setTime(normalizedTime);
      setFeedback(
        buildFeedback({
          enabled,
          time: normalizedTime,
          result,
        })
      );
    } catch (error) {
      setFeedback({
        tone: 'error',
        message:
          error instanceof Error && error.message.trim()
            ? error.message.trim()
            : 'Unable to save the auto-update schedule right now.',
      });
    } finally {
      setSaving(false);
    }
  };

  const feedbackStyles: Record<FeedbackTone, { border: string; background: string; color: string }> = {
    success: {
      border: '1px solid rgba(22, 101, 52, 0.24)',
      background: 'rgba(22, 163, 74, 0.08)',
      color: '#166534',
    },
    warning: {
      border: '1px solid rgba(180, 83, 9, 0.24)',
      background: 'rgba(217, 119, 6, 0.08)',
      color: '#92400e',
    },
    error: {
      border: '1px solid rgba(185, 28, 28, 0.24)',
      background: 'rgba(239, 68, 68, 0.08)',
      color: '#991b1b',
    },
  };

  return (
    <SafePortal>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="auto-update-title"
            onClick={() => {
              if (!saving) onClose();
            }}
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={overlayVariants}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 300,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
              background: 'rgba(7, 10, 20, 0.58)',
            }}
          >
            <motion.div
              onClick={(event) => event.stopPropagation()}
              initial="hidden"
              animate="visible"
              exit="exit"
              variants={modalVariants}
              style={{
                width: 'min(100%, 540px)',
                background: 'var(--vellum-bg)',
                border: '1px solid var(--ink-black)',
                boxShadow: '0 24px 80px rgba(0,0,0,0.28)',
                padding: '24px',
                display: 'grid',
                gap: '1rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1px solid rgba(59, 130, 246, 0.22)',
                    background: 'rgba(59, 130, 246, 0.08)',
                    color: '#1d4ed8',
                  }}
                >
                  <Clock3 size={18} />
                </div>
                <div>
                  <h2
                    id="auto-update-title"
                    className="serif"
                    style={{ margin: 0, fontSize: '2rem', fontWeight: 400, color: 'var(--ink-black)' }}
                  >
                    Daily auto-update
                  </h2>
                  <p style={{ margin: '0.4rem 0 0', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>
                    Hermes safely refreshes the Docker stack on a daily timer and preserves mounted volumes, so memories,
                    profiles, sessions, and other persistent data stay attached.
                  </p>
                </div>
              </div>

              <div
                className="mono"
                style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-muted)',
                  padding: '10px 12px',
                  border: '1px solid var(--etched-border)',
                  background: 'rgba(255,255,255,0.45)',
                }}
              >
                Hermes pulls the latest image or compose changes, runs a safe `docker compose up -d --remove-orphans`,
                and checks the runtime comes back healthy before the update finishes.
              </div>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '14px 16px',
                  border: '1px solid var(--etched-border)',
                  background: 'rgba(255,255,255,0.45)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                  disabled={saving}
                  style={{ marginTop: 2 }}
                />
                <div style={{ display: 'grid', gap: 4 }}>
                  <span
                    className="mono"
                    style={{
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      color: 'var(--ink-black)',
                      fontWeight: 700,
                    }}
                  >
                    Enable daily auto-update
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                    Keep this on to have Hermes refresh the runtime automatically every day.
                  </span>
                </div>
              </label>

              <label style={{ display: 'grid', gap: 8 }}>
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--text-muted)',
                  }}
                >
                  Time (UTC)
                </span>
                <input
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value || DEFAULT_AUTO_UPDATE_TIME)}
                  disabled={saving}
                  step={60}
                  style={{
                    width: '100%',
                    border: '1px solid var(--ink-black)',
                    background: 'var(--bg-surface)',
                    color: 'var(--ink-black)',
                    padding: '12px 14px',
                    fontFamily: 'var(--font-mono), monospace',
                    fontSize: 14,
                  }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Default is {DEFAULT_AUTO_UPDATE_TIME} UTC. Choose any daily time that feels quiet for your team.
                </span>
              </label>

              {feedback ? (
                <div
                  style={{
                    padding: '12px 14px',
                    fontSize: 12,
                    lineHeight: 1.6,
                    ...feedbackStyles[feedback.tone],
                  }}
                >
                  {feedback.message}
                </div>
              ) : null}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <motion.button
                  type="button"
                  onClick={onClose}
                  disabled={saving}
                  style={{
                    border: '1px solid var(--etched-border)',
                    background: 'transparent',
                    color: 'var(--ink-black)',
                    padding: '10px 18px',
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    cursor: saving ? 'not-allowed' : 'pointer',
                  }}
                  whileTap={tapScale}
                  transition={buttonSpring}
                >
                  Close
                </motion.button>
                <motion.button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    border: 'none',
                    background: 'var(--ink-black)',
                    color: 'var(--bg-surface)',
                    padding: '10px 18px',
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    cursor: saving ? 'not-allowed' : 'pointer',
                  }}
                  whileTap={tapScale}
                  transition={buttonSpring}
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                  {saving ? 'Saving...' : 'Save schedule'}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </SafePortal>
  );
}
