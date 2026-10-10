'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Lock,
  Network,
  RefreshCw,
  Shield,
  Unplug,
} from 'lucide-react';

import type { TailscaleConfig } from '@/lib/private-access/tailscale';
import styles from '../console.module.css';

// Typed secrets and hostnames must reach the API exactly as entered.
const RAW_TEXT_INPUT_PROPS = {
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
  autoComplete: 'off',
  enterKeyHint: 'done',
} as const;

interface ConfigurationTailscalePanelProps {
  instanceId: string;
  initialConfig?: TailscaleConfig;
  isSharedHost: boolean;
}

type FeedbackTone = 'success' | 'error' | 'info';
type ActionState = 'connect' | 'save' | 'refresh' | 'disconnect' | null;
type SetupMode = 'connect' | 'edit';

function getStatusPalette(state: TailscaleConfig['state'] | 'unknown') {
  if (state === 'connected') {
    return {
      background: 'rgba(32, 123, 91, 0.12)',
      color: '#1f6f55',
      border: '1px solid rgba(32, 123, 91, 0.3)',
    };
  }

  if (state === 'error') {
    return {
      background: 'rgba(163, 62, 41, 0.12)',
      color: '#8a3c2e',
      border: '1px solid rgba(163, 62, 41, 0.28)',
    };
  }

  if (state === 'connecting') {
    return {
      background: 'rgba(122, 91, 27, 0.12)',
      color: '#7a5b1b',
      border: '1px solid rgba(122, 91, 27, 0.28)',
    };
  }

  return {
    background: 'var(--bg-surface)',
    color: 'var(--text-muted)',
    border: '1px solid var(--etched-border)',
  };
}

function formatStateLabel(state: TailscaleConfig['state'] | 'unknown') {
  if (state === 'connected') return 'Connected';
  if (state === 'connecting') return 'Connecting';
  if (state === 'error') return 'Needs Attention';
  if (state === 'disconnected') return 'Not Connected';
  return 'Checking';
}

function formatTags(tags: string | undefined) {
  return (tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function FeedbackBanner({ tone, message }: { tone: FeedbackTone; message: string }) {
  const palette =
    tone === 'success'
      ? {
          background: 'rgba(32, 123, 91, 0.08)',
          border: '1px solid rgba(32, 123, 91, 0.24)',
          color: '#1f6f55',
        }
      : tone === 'error'
        ? {
            background: 'rgba(163, 62, 41, 0.08)',
            border: '1px solid rgba(163, 62, 41, 0.24)',
            color: '#8a3c2e',
          }
        : {
            background: 'var(--bg-surface)',
            border: '1px solid var(--etched-border)',
            color: 'var(--text-muted)',
          };

  return (
    <div
      style={{
        padding: '12px 14px',
        background: palette.background,
        border: palette.border,
        color: palette.color,
        fontSize: 12,
      }}
    >
      {message}
    </div>
  );
}

function DetailField({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  if (!value) return null;

  return (
    <div>
      <label
        className={`mono ${styles.microLabel}`}
        style={{ fontSize: 9, display: 'block', marginBottom: 8, opacity: 0.5, fontWeight: 700 }}
      >
        {label}
      </label>
      <input
        readOnly
        value={value}
        style={{
          width: '100%',
          border: '1px solid var(--etched-border)',
          background: 'var(--bg-elevated)',
          padding: '10px 14px',
          fontSize: 13,
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
        }}
      />
    </div>
  );
}

export function ConfigurationTailscalePanel({
  instanceId,
  initialConfig,
  isSharedHost,
}: ConfigurationTailscalePanelProps) {
  const [tailscale, setTailscale] = useState<TailscaleConfig | undefined>(initialConfig);
  const [loading, setLoading] = useState(!initialConfig);
  const [showSetup, setShowSetup] = useState(false);
  const [setupMode, setSetupMode] = useState<SetupMode>('connect');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [authKey, setAuthKey] = useState('');
  const [machineName, setMachineName] = useState(initialConfig?.machineName || '');
  const [tags, setTags] = useState(initialConfig?.tags?.join(', ') || '');
  const [enableSsh, setEnableSsh] = useState(Boolean(initialConfig?.sshEnabled));
  const [feedback, setFeedback] = useState<{ tone: FeedbackTone; message: string } | null>(null);
  const [activeAction, setActiveAction] = useState<ActionState>(null);
  const [forceClearAvailable, setForceClearAvailable] = useState(false);
  // Disconnect removes this host from the tailnet, so it asks once inline.
  // Focus moves to the strip's Cancel on open and back to the trigger on cancel.
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const disconnectTriggerRef = useRef<HTMLButtonElement>(null);
  const disconnectCancelRef = useRef<HTMLButtonElement>(null);
  const disconnectQuestionId = useId();
  useEffect(() => {
    if (confirmDisconnect) disconnectCancelRef.current?.focus();
  }, [confirmDisconnect]);
  const cancelDisconnect = () => {
    setConfirmDisconnect(false);
    disconnectTriggerRef.current?.focus();
  };

  const currentState = tailscale?.state || 'disconnected';
  const statusPalette = getStatusPalette(currentState);
  const isConnected = Boolean(tailscale?.enabled);
  const showingConnectedState = isConnected && !showSetup;
  const isEditingConnectedHost = setupMode === 'edit';

  function syncFormFromConfig(nextConfig?: TailscaleConfig) {
    setMachineName(nextConfig?.machineName || '');
    setTags(nextConfig?.tags?.join(', ') || '');
    setEnableSsh(Boolean(nextConfig?.sshEnabled));
  }

  async function refreshTailscaleStatus(showSpinner = false) {
    if (showSpinner) setActiveAction('refresh');
    if (!tailscale) setLoading(true);

    try {
      const response = await fetch(`/api/instances/${instanceId}/private-access/tailscale`, {
        cache: 'no-store',
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.error || 'Unable to load Tailscale status.');
      }

      const nextConfig = json.data?.tailscale as TailscaleConfig | undefined;
      setTailscale(nextConfig);
      syncFormFromConfig(nextConfig);
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to load Tailscale status.',
      });
    } finally {
      setLoading(false);
      if (showSpinner) setActiveAction(null);
    }
  }

  useEffect(() => {
    refreshTailscaleStatus(!initialConfig);
    // We intentionally sync when the instance changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  function openConnectSetup() {
    syncFormFromConfig(tailscale);
    setAuthKey('');
    setSetupMode('connect');
    setShowAdvanced(false);
    setShowSetup(true);
    setFeedback(null);
  }

  function openEditSetup() {
    syncFormFromConfig(tailscale);
    setAuthKey('');
    setSetupMode('edit');
    setShowAdvanced(true);
    setShowSetup(true);
    setFeedback(null);
  }

  async function handleSubmit() {
    if (isEditingConnectedHost) {
      setActiveAction('save');
      setFeedback(null);

      try {
        const response = await fetch(`/api/instances/${instanceId}/private-access/tailscale`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            machineName: machineName.trim() || undefined,
            enableSsh,
          }),
        });
        const json = await response.json();

        if (!response.ok || !json.success) {
          throw new Error(json.error || 'Unable to update Tailscale settings on this host.');
        }

        const nextConfig = json.data?.tailscale as TailscaleConfig | undefined;
        setTailscale(nextConfig);
        syncFormFromConfig(nextConfig);
        setShowSetup(false);
        setFeedback({
          tone: 'success',
          message: 'Tailscale settings were updated and will stay in place on this host.',
        });
      } catch (error) {
        setFeedback({
          tone: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Unable to update Tailscale settings on this host.',
        });
      } finally {
        setActiveAction(null);
      }

      return;
    }

    const trimmedAuthKey = authKey.trim();
    if (!trimmedAuthKey) {
      setFeedback({
        tone: 'error',
        message: 'Paste a Tailscale auth key before saving this connection.',
      });
      return;
    }

    setActiveAction('connect');
    setFeedback(null);

    try {
      const response = await fetch(`/api/instances/${instanceId}/private-access/tailscale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authKey: trimmedAuthKey,
          machineName: machineName.trim() || undefined,
          tags: formatTags(tags),
          enableSsh,
        }),
      });
      const json = await response.json();

      if (!response.ok || !json.success) {
        throw new Error(json.error || 'Unable to enable Tailscale on this host.');
      }

      const nextConfig = json.data?.tailscale as TailscaleConfig | undefined;
      setTailscale(nextConfig);
      syncFormFromConfig(nextConfig);
      setAuthKey('');
      setShowSetup(false);
      setFeedback({
        tone: 'success',
        message:
          'Tailscale is connected. Your normal public dashboard URL stays exactly the same.',
      });
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to enable Tailscale on this host.',
      });
    } finally {
      setActiveAction(null);
    }
  }

  async function handleDisconnect(force = false) {
    setConfirmDisconnect(false);
    setActiveAction('disconnect');
    setFeedback(null);

    try {
      const response = await fetch(
        `/api/instances/${instanceId}/private-access/tailscale${force ? '?force=1' : ''}`,
        {
          method: 'DELETE',
        },
      );
      const json = await response.json();

      if (!response.ok || !json.success) {
        // When the host-side teardown fails, the route returns canForce so the
        // user can clear a stuck/manually-removed enrollment from the DB and
        // re-enroll. Surface that as a recovery action rather than a dead end.
        if (json?.canForce && !force) {
          setForceClearAvailable(true);
          setFeedback({
            tone: 'error',
            message:
              (json.error || 'Unable to disconnect Tailscale.') +
              ' If Tailscale was already removed from the host, you can force-clear this enrollment to re-enroll.',
          });
          return;
        }
        throw new Error(json.error || 'Unable to disconnect Tailscale.');
      }

      setForceClearAvailable(false);
      setTailscale(undefined);
      setShowSetup(false);
      syncFormFromConfig(undefined);
      setFeedback({
        tone: json.hostTeardownConfirmed === false ? 'error' : 'success',
        message:
          json.hostTeardownConfirmed === false
            ? 'Tailscale enrollment cleared. The host could not be reached for teardown, so it may still hold tailnet membership — remove it manually if needed.'
            : 'Tailscale has been disconnected from this host.',
      });
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Unable to disconnect Tailscale.',
      });
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <div className="interrogation-box" style={{ padding: 'clamp(16px, 5vw, 2rem)' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Shield size={18} />
            <h3 className="serif" style={{ fontSize: '1.25rem', margin: 0, fontWeight: 700 }}>
              Private Access with Tailscale
            </h3>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0.75rem 0 0' }}>
            Customer-owned private access for developers who want a safer way to reach the host
            without changing the public browser URL your clients already use.
          </p>
        </div>

        <div
          className={`mono ${styles.microLabel}`}
          style={{
            ...statusPalette,
            padding: '8px 10px',
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            whiteSpace: 'nowrap',
          }}
        >
          {loading ? 'Checking' : formatStateLabel(currentState)}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {isSharedHost && (
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              padding: '12px 14px',
              background: 'rgba(122, 91, 27, 0.08)',
              border: '1px solid rgba(122, 91, 27, 0.24)',
            }}
          >
            <AlertTriangle size={16} style={{ marginTop: 1, flexShrink: 0, color: '#7a5b1b' }} />
            <div style={{ fontSize: 12, color: '#7a5b1b', lineHeight: 1.5 }}>
              This agent is running on a shared host. Tailscale will connect to the underlying
              machine that powers this agent, so it improves access control but does not turn the
              machine into a dedicated single-tenant server.
            </div>
          </div>
        )}

        {feedback && <FeedbackBanner tone={feedback.tone} message={feedback.message} />}

        {loading && !tailscale ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)' }}>
            <Loader2 size={16} className="animate-spin" />
            <span style={{ fontSize: 12 }}>Checking current Tailscale status...</span>
          </div>
        ) : null}

        {!showingConnectedState && !showSetup && !loading && (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
              }}
            >
              <div
                style={{
                  border: '1px dashed var(--etched-border)',
                  padding: '14px',
                  background: 'var(--bg-surface)',
                }}
              >
                <div className={`mono ${styles.microLabel}`} style={{ fontSize: 9, opacity: 0.5, fontWeight: 700 }}>
                  WHAT THIS DOES
                </div>
                <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Adds a private network path to the host through your own Tailscale account, so
                  developers can reach it without relying only on the public internet.
                </p>
              </div>

              <div
                style={{
                  border: '1px dashed var(--etched-border)',
                  padding: '14px',
                  background: 'var(--bg-surface)',
                }}
              >
                <div className={`mono ${styles.microLabel}`} style={{ fontSize: 9, opacity: 0.5, fontWeight: 700 }}>
                  WHAT STAYS THE SAME
                </div>
                <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Your normal public dashboard URL stays exactly the same. This is an extra private
                  access path, not a replacement for the existing client-facing link.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={openConnectSetup}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'var(--ink-black)',
                  color: 'var(--bg-surface)',
                  border: 'none',
                  padding: '12px 24px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                }}
              >
                <Lock size={15} />
                Connect Tailscale
              </button>
            </div>
          </>
        )}

        {showSetup && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {isEditingConnectedHost ? (
              <div
                style={{
                  padding: '12px 14px',
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--etched-border)',
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  lineHeight: 1.6,
                }}
              >
                This host is already connected to your tailnet. You can update the machine name
                and Tailscale SSH here without pasting a new auth key.
              </div>
            ) : (
              <>
                <div>
                  <label
                    htmlFor="tailscale-auth-key"
                    className={`mono ${styles.microLabel}`}
                    style={{
                      fontSize: 9,
                      display: 'block',
                      marginBottom: 8,
                      opacity: 0.5,
                      fontWeight: 700,
                    }}
                  >
                    TAILSCALE AUTH KEY
                  </label>
                  <input
                    id="tailscale-auth-key"
                    type="text"
                    {...RAW_TEXT_INPUT_PROPS}
                    value={authKey}
                    onChange={(event) => setAuthKey(event.target.value)}
                    placeholder="tskey-auth-..."
                    style={{
                      width: '100%',
                      border: '1px solid var(--etched-border)',
                      padding: '10px 14px',
                      fontSize: 13,
                      fontFamily: 'var(--font-mono), monospace',
                      background: 'var(--bg-elevated)',
                      outline: 'none',
                    }}
                  />
                  <div
                    style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}
                  >
                    Paste a key from your own Tailscale admin. We use it for setup and do not keep
                    it in the dashboard config.
                  </div>
                </div>

                <div style={{ borderTop: '1px dashed var(--etched-border)' }} />
              </>
            )}

            <button
              type="button"
              onClick={() => setShowAdvanced((value) => !value)}
              aria-expanded={showAdvanced}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                border: '1px solid var(--etched-border)',
                background: 'var(--bg-surface)',
                padding: '10px 14px',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono), monospace',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              <span>Advanced Options</span>
              {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {showAdvanced && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1rem' }}>
                <div>
                  <label
                    htmlFor="tailscale-machine-name"
                    className={`mono ${styles.microLabel}`}
                    style={{
                      fontSize: 9,
                      display: 'block',
                      marginBottom: 8,
                      opacity: 0.5,
                      fontWeight: 700,
                    }}
                  >
                    MACHINE NAME OVERRIDE
                  </label>
                  <input
                    id="tailscale-machine-name"
                    type="text"
                    {...RAW_TEXT_INPUT_PROPS}
                    value={machineName}
                    onChange={(event) => setMachineName(event.target.value)}
                    placeholder={
                      isEditingConnectedHost
                        ? 'Leave as-is unless you want to rename this machine'
                        : 'Leave blank to use the default hostname'
                    }
                    style={{
                      width: '100%',
                      border: '1px solid var(--etched-border)',
                      padding: '10px 14px',
                      fontSize: 13,
                      fontFamily: 'var(--font-mono), monospace',
                      background: 'var(--bg-elevated)',
                      outline: 'none',
                    }}
                  />
                </div>

                <div>
                  <label
                    htmlFor="tailscale-tags"
                    className={`mono ${styles.microLabel}`}
                    style={{
                      fontSize: 9,
                      display: 'block',
                      marginBottom: 8,
                      opacity: 0.5,
                      fontWeight: 700,
                    }}
                  >
                    TAGS
                  </label>
                  <input
                    id="tailscale-tags"
                    type="text"
                    {...RAW_TEXT_INPUT_PROPS}
                    value={tags}
                    onChange={(event) => setTags(event.target.value)}
                    placeholder="tag:prod, tag:ops"
                    disabled={isEditingConnectedHost}
                    style={{
                      width: '100%',
                      border: '1px solid var(--etched-border)',
                      padding: '10px 14px',
                      fontSize: 13,
                      fontFamily: 'var(--font-mono), monospace',
                      background: isEditingConnectedHost ? 'var(--bg-surface)' : 'var(--bg-elevated)',
                      outline: 'none',
                      color: isEditingConnectedHost ? 'var(--text-muted)' : 'var(--ink-black)',
                    }}
                  />
                  {isEditingConnectedHost ? (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                      Tags are set during the initial connection flow. Reconnect Tailscale if you
                      need to apply a different tag set.
                    </div>
                  ) : null}
                </div>

                <div>
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '1rem',
                    }}
                  >
                    <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                      <span
                        id="tailscale-ssh-label"
                        className={`mono ${styles.microLabel}`}
                        style={{
                          fontSize: 9,
                          display: 'block',
                          opacity: 0.5,
                          fontWeight: 700,
                        }}
                      >
                        ENABLE TAILSCALE SSH
                      </span>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                        Lets approved Tailscale users open SSH sessions without exposing another
                        public path.
                      </div>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={enableSsh}
                      aria-labelledby="tailscale-ssh-label"
                      onClick={() => setEnableSsh((value) => !value)}
                      className={`${styles.touchTarget} ${styles.microLabel}`}
                      style={{
                        border: '1px solid var(--etched-border)',
                        background: enableSsh ? 'var(--ink-black)' : 'var(--bg-surface)',
                        color: enableSsh ? 'var(--bg-surface)' : 'var(--ink-black)',
                        padding: '6px 10px',
                        fontSize: 10,
                        fontFamily: 'var(--font-mono), monospace',
                        textTransform: 'uppercase',
                        letterSpacing: '0.12em',
                        flexShrink: 0,
                      }}
                    >
                      {enableSsh ? 'SSH: On' : 'SSH: Off'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => {
                  setShowSetup(false);
                  setFeedback(null);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'transparent',
                  color: 'var(--ink-black)',
                  border: '1px solid var(--ink-black)',
                  padding: '12px 24px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleSubmit}
                disabled={activeAction === 'connect' || activeAction === 'save'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'var(--ink-black)',
                  color: 'var(--bg-surface)',
                  border: 'none',
                  padding: '12px 24px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor:
                    activeAction === 'connect' || activeAction === 'save' ? 'wait' : 'pointer',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                }}
              >
                {activeAction === 'connect' || activeAction === 'save' ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Network size={15} />
                )}
                {isEditingConnectedHost ? 'Save Settings' : 'Enable Tailscale'}
              </button>
            </div>
          </div>
        )}

        {showingConnectedState && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: '1rem',
                padding: '14px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--etched-border)',
              }}
            >
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {currentState === 'error' ? 'Tailscale needs attention.' : 'Connected to your tailnet.'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.6 }}>
                  Developers can now use your private tailnet route for host access, while the
                  normal public dashboard URL remains unchanged for everyone else.
                </div>
                {tailscale?.lastError ? (
                  <div style={{ fontSize: 12, color: '#8a3c2e', marginTop: 8 }}>
                    Last error: {tailscale.lastError}
                  </div>
                ) : null}
              </div>

              <div
                className={`mono ${styles.microLabel}`}
                style={{
                  ...statusPalette,
                  padding: '8px 10px',
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatStateLabel(currentState)}
              </div>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '1rem',
              }}
            >
              <DetailField label="MAGICDNS NAME" value={tailscale?.magicDnsName} />
              <DetailField label="MACHINE NAME" value={tailscale?.machineName} />
              <DetailField label="TAILNET" value={tailscale?.tailnetName} />
              <DetailField label="TAILSCALE IPV4" value={tailscale?.ipv4} />
              <DetailField label="TAILSCALE IPV6" value={tailscale?.ipv6} />
              <DetailField
                label="TAILSCALE SSH"
                value={tailscale?.sshEnabled ? 'Enabled' : 'Disabled'}
              />
            </div>

            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => refreshTailscaleStatus(true)}
                disabled={activeAction === 'refresh'}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'transparent',
                  color: 'var(--ink-black)',
                  border: '1px solid var(--ink-black)',
                  padding: '12px 24px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: activeAction === 'refresh' ? 'wait' : 'pointer',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                }}
              >
                {activeAction === 'refresh' ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <RefreshCw size={15} />
                )}
                Refresh Status
              </button>

              <button
                type="button"
                onClick={openEditSetup}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'var(--ink-black)',
                  color: 'var(--bg-surface)',
                  border: 'none',
                  padding: '12px 24px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                }}
              >
                Update Settings
              </button>

              <button
                ref={disconnectTriggerRef}
                type="button"
                onClick={() => setConfirmDisconnect(true)}
                disabled={activeAction === 'disconnect'}
                aria-expanded={confirmDisconnect}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: 'transparent',
                  color: '#8a3c2e',
                  border: '1px solid rgba(163, 62, 41, 0.4)',
                  padding: '12px 24px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: activeAction === 'disconnect' ? 'wait' : 'pointer',
                  opacity: confirmDisconnect ? 0.5 : 1,
                  fontFamily: 'var(--font-mono)',
                  textTransform: 'uppercase',
                }}
              >
                {activeAction === 'disconnect' ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Unplug size={15} />
                )}
                Disconnect Tailscale
              </button>

              {forceClearAvailable && (
                <button
                  type="button"
                  onClick={() => handleDisconnect(true)}
                  disabled={activeAction === 'disconnect'}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: 'transparent',
                    color: '#8a3c2e',
                    border: '1px dashed rgba(163, 62, 41, 0.6)',
                    padding: '12px 24px',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: activeAction === 'disconnect' ? 'wait' : 'pointer',
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                  }}
                  title="Clear this enrollment from the dashboard even though the host could not be reached, so you can re-enroll."
                >
                  <Unplug size={15} />
                  Force-clear enrollment
                </button>
              )}
            </div>

            {confirmDisconnect && (
              <div
                role="alertdialog"
                aria-labelledby={disconnectQuestionId}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') cancelDisconnect();
                }}
                style={{
                  display: 'grid',
                  gap: 12,
                  padding: '14px',
                  border: '1px solid rgba(163, 62, 41, 0.4)',
                  background: 'rgba(163, 62, 41, 0.05)',
                }}
              >
                <p id={disconnectQuestionId} className={`mono ${styles.dangerText}`} style={{ margin: 0, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Disconnect this host from your tailnet?
                </p>
                <div className={styles.stackLast} style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  <button
                    ref={disconnectCancelRef}
                    type="button"
                    onClick={cancelDisconnect}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      minHeight: 44,
                      background: 'transparent',
                      color: 'var(--ink-black)',
                      border: '1px solid var(--ink-black)',
                      padding: '0 20px',
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-mono)',
                      textTransform: 'uppercase',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDisconnect(false)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      minHeight: 44,
                      background: '#8a3c2e',
                      color: '#fff',
                      border: '1px solid #8a3c2e',
                      padding: '0 20px',
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-mono)',
                      textTransform: 'uppercase',
                    }}
                  >
                    <Unplug size={15} />
                    Disconnect
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
