import { useState, useEffect } from 'react';
import posthog from 'posthog-js';
import { AlertTriangle, Cpu, ExternalLink, Layers, Loader2, Monitor, Terminal } from 'lucide-react';
import type { TailscaleConfig } from '@/lib/private-access/tailscale';
import { CONTEXT_ENGINES, TERMINAL_BACKENDS, type ContextEngine, type TerminalBackend } from '@/lib/instance-settings';
import { VISIBLE_PROVIDERS } from '@/lib/models';
import { clientLog } from '@/lib/client/logger';
import { openWebuiWorkspaceInNewTab } from '@/lib/webui-open-new-tab';

import { ConfigurationDangerZone, isDeleteConfirmationMatch, type DeleteReason } from "./ConfigurationDangerZone";
import { ConfigurationTailscalePanel } from './ConfigurationTailscalePanel';
import { ConnectDesktopButton } from '@/components/instances/ConnectDesktopButton';
import styles from '../console.module.css';

const CARD_PADDING = 'clamp(16px, 5vw, 2rem)';

type InstanceSettingsData = {
  id: string;
  host_id?: unknown;
  config?: {
    privateAccess?: { tailscale?: TailscaleConfig };
    agentSettings?: {
      enableRootAccess?: boolean;
      terminalBackend?: TerminalBackend;
      hasDaytonaApiKey?: boolean;
      compressionProvider?: string;
      compressionModel?: string;
      contextEngine?: ContextEngine;
    };
  };
  advanced_cloud_access_eligible?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readInstanceSettings(payload: unknown, instanceId: string): InstanceSettingsData {
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    !isRecord(payload.data) ||
    payload.data.id !== instanceId
  ) {
    throw new Error('Instance settings response was unsuccessful or malformed.');
  }

  const data = payload.data;
  const config = data.config;
  if (config != null && !isRecord(config)) {
    throw new Error('Instance settings config was malformed.');
  }
  const agent = isRecord(config) ? config.agentSettings : undefined;
  if (agent != null && !isRecord(agent)) {
    throw new Error('Instance agent settings were malformed.');
  }
  if (
    (data.advanced_cloud_access_eligible !== undefined && typeof data.advanced_cloud_access_eligible !== 'boolean') ||
    (isRecord(agent) && (
      (agent.enableRootAccess !== undefined && typeof agent.enableRootAccess !== 'boolean') ||
      (agent.terminalBackend !== undefined && !TERMINAL_BACKENDS.includes(agent.terminalBackend as TerminalBackend)) ||
      (agent.hasDaytonaApiKey !== undefined && typeof agent.hasDaytonaApiKey !== 'boolean') ||
      (agent.compressionProvider !== undefined && typeof agent.compressionProvider !== 'string') ||
      (agent.compressionModel !== undefined && typeof agent.compressionModel !== 'string') ||
      (agent.contextEngine !== undefined && !CONTEXT_ENGINES.includes(agent.contextEngine as ContextEngine))
    ))
  ) {
    throw new Error('Instance settings values were malformed.');
  }

  return data as InstanceSettingsData;
}

export default function ConfigurationTab({ instanceId }: { instanceId: string }) {
  const [settingsLoad, setSettingsLoad] = useState<{
    instanceId: string;
    status: 'loading' | 'ready' | 'error';
  }>({ instanceId, status: 'loading' });
  const [settingsLoadAttempt, setSettingsLoadAttempt] = useState(0);
  const settingsReady = settingsLoad.instanceId === instanceId && settingsLoad.status === 'ready';
  const [isSharedHost, setIsSharedHost] = useState(false);
  const [initialTailscaleConfig, setInitialTailscaleConfig] = useState<TailscaleConfig | undefined>(undefined);

  // Delete State
  const [deleteInputText, setDeleteInputText] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  // Optional churn reason — never blocks the delete.
  const [deleteReason, setDeleteReason] = useState<DeleteReason | null>(null);
  const [deleteReasonNote, setDeleteReasonNote] = useState('');

  // Advanced cloud access: owner-controlled root + this VM's Docker daemon.
  // The API only marks isolated customer VMs eligible; legacy shared-host
  // layouts fail closed so a Docker socket can never expose sibling tenants.
  const [cloudAccessEnabled, setCloudAccessEnabled] = useState(false);
  const [cloudAccessEligible, setCloudAccessEligible] = useState(false);
  const [cloudAccessLoading, setCloudAccessLoading] = useState(false);
  const [cloudAccessMessage, setCloudAccessMessage] = useState('');
  const [cloudAccessError, setCloudAccessError] = useState('');

  // Terminal execution backend (where the agent runs shell commands)
  const [terminalBackend, setTerminalBackend] = useState<TerminalBackend>('local');
  const [hasDaytonaKey, setHasDaytonaKey] = useState(false);
  const [daytonaKeyInput, setDaytonaKeyInput] = useState('');
  const [terminalSaving, setTerminalSaving] = useState(false);
  const [terminalMessage, setTerminalMessage] = useState('');
  const [terminalError, setTerminalError] = useState('');

  // Auxiliary compression model + context engine. Empty provider/model = inherit
  // the main model (the cheap-model routing is opt-in). Engine defaults to the
  // agent's own default ('compressor') until the user picks one.
  const [compressionProvider, setCompressionProvider] = useState('');
  const [compressionModel, setCompressionModel] = useState('');
  const [contextEngine, setContextEngine] = useState<ContextEngine | ''>('');
  const [contextSaving, setContextSaving] = useState(false);
  const [contextMessage, setContextMessage] = useState('');
  const [contextError, setContextError] = useState('');

  // Open WebUI in a dedicated browser tab
  const [webuiOpening, setWebuiOpening] = useState(false);
  const [webuiNotice, setWebuiNotice] = useState('');
  const [webuiError, setWebuiError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setSettingsLoad({ instanceId, status: 'loading' });
    // A new instance or retry must not retain unsaved secrets, confirmations, or
    // status messages from the previous settings view.
    setDaytonaKeyInput('');
    setDeleteInputText('');
    setDeleteConfirm(false);
    setDeleteReason(null);
    setDeleteReasonNote('');
    setCloudAccessMessage('');
    setCloudAccessError('');
    setTerminalMessage('');
    setTerminalError('');
    setContextMessage('');
    setContextError('');
    setWebuiNotice('');
    setWebuiError('');

    (async () => {
      try {
        const res = await fetch(`/api/instances/${instanceId}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Instance settings request failed (${res.status}).`);
        }
        const data = readInstanceSettings(await res.json(), instanceId);
        if (!active) return;

        setIsSharedHost(!!data.host_id);
        setInitialTailscaleConfig(data.config?.privateAccess?.tailscale);
        const agent = data.config?.agentSettings;
        setCloudAccessEnabled(!!agent?.enableRootAccess);
        setCloudAccessEligible(data.advanced_cloud_access_eligible === true);
        setTerminalBackend(agent?.terminalBackend ?? 'local');
        setHasDaytonaKey(!!agent?.hasDaytonaApiKey);
        setCompressionProvider(agent?.compressionProvider ?? '');
        setCompressionModel(agent?.compressionModel ?? '');
        setContextEngine(agent?.contextEngine ?? '');
        setSettingsLoad({ instanceId, status: 'ready' });
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        // Defaults are not evidence of the saved configuration. Keep all
        // mutation controls hidden until a successful read establishes it.
        clientLog.warn('Configuration tab settings fetch failed; editing disabled', {
          source: 'instance-console',
          failureType: 'configuration_tab_fetch_failed',
          instanceId,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        setSettingsLoad({ instanceId, status: 'error' });
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [instanceId, settingsLoadAttempt]);

  const handleDeleteInstance = async () => {
    if (!settingsReady) return;
    if (!isDeleteConfirmationMatch(deleteInputText, instanceId)) {
      setDeleteConfirm(true);
      return;
    }

    const trimmedNote = deleteReasonNote.trim();
    // Client-side churn capture — fire before the request so it lands even if
    // the navigation away races the network. Best-effort: never throws.
    try {
      posthog.capture('instance_deleted', {
        source: 'instance-console',
        instance_id: instanceId,
        delete_reason: deleteReason,
        has_delete_reason_note: deleteReason === 'other' && trimmedNote.length > 0,
      });
    } catch {
      // Instrumentation must never block a delete.
    }

    setActionLoading(true);
    try {
      const res = await fetch(`/api/instances/${instanceId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // A case-insensitive match (iOS capitalises the first letter) is
          // sent as the exact id the server compares against.
          confirmation: instanceId,
          // Reason is optional and never gates the delete server-side.
          ...(deleteReason ? { deleteReason } : {}),
          ...(deleteReason === 'other' && trimmedNote ? { deleteReasonNote: trimmedNote } : {}),
        }),
      });
      const data = await res.json();
      if (data.success) {
        window.location.href = '/dashboard';
      } else {
        alert("Failed to delete this agent: " + data.error);
        setActionLoading(false);
      }
    } catch {
      alert("Error deleting this agent.");
      setActionLoading(false);
    }
};

  const handleToggleCloudAccess = async (next: boolean) => {
    if (!settingsReady) return;
    if (next && typeof window !== 'undefined' && !window.confirm(
      'Enable Advanced cloud access?\n\n' +
      'This gives the agent root privileges on its own computer and access to the isolated VM\'s Docker daemon. ' +
      'It can install software, run containers, delete data, or break its own setup. ' +
      'It cannot access the Proxmox host or another customer\'s VM. Continue?'
    )) {
      return;
    }
    setCloudAccessLoading(true);
    setCloudAccessError('');
    setCloudAccessMessage('');
    // Docker is the useful default for this opt-in: it is the mode that uses
    // the VM socket being granted. Preserve explicit cloud-sandbox choices,
    // and return Docker users to the safe local mode when access is removed.
    const nextTerminalBackend =
      next && terminalBackend === 'local'
        ? 'docker'
        : !next && terminalBackend === 'docker'
          ? 'local'
          : terminalBackend;
    let accessSaved = false;
    try {
      const patchRes = await fetch(`/api/instances/${instanceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentSettings: {
            enableRootAccess: next,
            terminalBackend: nextTerminalBackend,
          },
        }),
      });
      const patchJson = await patchRes.json().catch(() => null);
      if (!patchRes.ok || !patchJson?.success) {
        setCloudAccessError(patchJson?.error || 'Could not update Advanced cloud access.');
        return;
      }
      accessSaved = true;
      setCloudAccessEnabled(next);
      setTerminalBackend(nextTerminalBackend);
      setCloudAccessMessage('Access setting saved. Requesting a restart…');

      const applyRes = await fetch(`/api/instances/${instanceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'redeploy', applyTerminalBackend: true }),
      });
      const applyJson = await applyRes.json().catch(() => null);
      if (!applyRes.ok || !applyJson?.success) {
        setCloudAccessMessage('Access setting saved. Restart was not confirmed.');
        setCloudAccessError(
          'The access setting was saved, but applying it failed. Use Save & apply under Terminal Execution to retry.'
        );
        return;
      }

      setCloudAccessMessage(
        next
          ? 'Advanced cloud access saved as enabled. Restart requested — wait for the agent to reconnect before using it.'
          : 'Advanced cloud access saved as disabled. Restart requested — wait for the agent to reconnect.'
      );
    } catch {
      setCloudAccessMessage(accessSaved ? 'Access setting saved. Restart was not confirmed.' : '');
      setCloudAccessError(accessSaved
        ? 'The restart request failed. Use Save & apply under Terminal Execution to retry.'
        : 'Could not update Advanced cloud access.');
    } finally {
      setCloudAccessLoading(false);
    }
  };

  // Save the terminal backend (+ optional Daytona key) and apply it to the box.
  // Two steps on purpose: the PATCH persists (and encrypts the key), but for the
  // webfree runtime the PATCH does not live-push — settings only land on the box
  // at its next redeploy. So we redeploy right after, otherwise the user would
  // save a key and nothing would change.
  const handleSaveTerminal = async () => {
    if (!settingsReady) return;
    if (terminalBackend === 'docker' && !cloudAccessEnabled) {
      setTerminalError('Enable Advanced Cloud Access before saving Docker execution.');
      return;
    }
    const trimmedKey = daytonaKeyInput.trim();
    if (terminalBackend === 'daytona' && !trimmedKey && !hasDaytonaKey) {
      setTerminalError('Daytona needs an API key — paste one from daytona.io first.');
      return;
    }
    setTerminalSaving(true);
    setTerminalMessage('');
    setTerminalError('');
    let settingsSaved = false;
    try {
      const patchRes = await fetch(`/api/instances/${instanceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentSettings: {
            terminalBackend,
            ...(trimmedKey ? { daytonaApiKey: trimmedKey } : {}),
          },
        }),
      });
      const patchJson = await patchRes.json();
      if (!patchRes.ok || !patchJson.success) {
        setTerminalError(patchJson.error || 'Could not save terminal settings.');
        return;
      }
      if (trimmedKey) {
        setHasDaytonaKey(true);
        setDaytonaKeyInput('');
      }

      settingsSaved = true;
      setTerminalMessage('Settings saved. Requesting a restart…');
      const applyRes = await fetch(`/api/instances/${instanceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'redeploy', applyTerminalBackend: true }),
      });
      const applyJson = await applyRes.json();
      if (!applyRes.ok || !applyJson.success) {
        setTerminalMessage('Settings saved. Restart was not confirmed.');
        setTerminalError('Applying the saved settings failed. Use Save & apply here to retry.');
        return;
      }
      setTerminalMessage('Settings saved. Restart requested — wait for the agent to reconnect.');
    } catch {
      setTerminalMessage(settingsSaved ? 'Settings saved. Restart was not confirmed.' : '');
      setTerminalError(settingsSaved
        ? 'The restart request failed. Use Save & apply here to retry.'
        : 'Could not save terminal settings.');
    } finally {
      setTerminalSaving(false);
    }
  };

  // Save the auxiliary compression model + context engine, then redeploy to land
  // them on the box. Same two-step as the terminal backend: the PATCH persists,
  // the redeploy re-renders config.yaml (auxiliary.compression + context.engine)
  // and restarts the agent. Empty provider/model clears back to inherit-main;
  // empty engine leaves the box on the agent default.
  const handleSaveContext = async () => {
    if (!settingsReady) return;
    setContextSaving(true);
    setContextMessage('');
    setContextError('');
    try {
      const patchRes = await fetch(`/api/instances/${instanceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentSettings: {
            // Send empty strings explicitly so clearing a field reverts the box
            // to inherit-main (the merge treats "" as the clear signal).
            compressionProvider: compressionModel ? compressionProvider : '',
            compressionModel,
            ...(contextEngine ? { contextEngine } : {}),
          },
        }),
      });
      const patchJson = await patchRes.json();
      if (!patchRes.ok || !patchJson.success) {
        setContextError(patchJson.error || 'Could not save context settings.');
        return;
      }
      setContextMessage('Settings saved. Requesting a restart…');
      const applyRes = await fetch(`/api/instances/${instanceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'redeploy' }),
      });
      const applyJson = await applyRes.json();
      if (!applyRes.ok || !applyJson.success) {
        setContextError('Saved, but applying it failed — hit Redeploy on this agent to apply.');
        return;
      }
      setContextMessage('Settings saved. Restart requested — wait for the agent to reconnect.');
    } catch {
      setContextError('Could not save context settings.');
    } finally {
      setContextSaving(false);
    }
  };

  const handleOpenWebui = async () => {
    if (!settingsReady) return;
    setWebuiOpening(true);
    setWebuiNotice('');
    setWebuiError('');
    try {
      const result = await openWebuiWorkspaceInNewTab(instanceId);
      if (result.status === 'pending') {
        setWebuiNotice(result.message);
      } else if (result.status === 'blocked') {
        setWebuiError('Your browser blocked the new tab. Allow pop-ups for this site, then try again.');
      } else if (result.status === 'error') {
        setWebuiError(result.reason);
      }
    } finally {
      setWebuiOpening(false);
    }
  };


  if (settingsLoad.instanceId !== instanceId || settingsLoad.status === 'loading') {
    return <div role="status" aria-label="Loading settings" style={{ display: 'flex', padding: '3rem', justifyContent: 'center' }}><Loader2 className="animate-spin" size={24} style={{ opacity: 0.4 }} /></div>;
  }

  if (settingsLoad.status === 'error') {
    return (
      <div className="interrogation-box" style={{ padding: CARD_PADDING }}>
        <p role="alert" style={{ marginTop: 0 }}>Could not load settings. Retry before making changes.</p>
        <button
          type="button"
          onClick={() => {
            setSettingsLoad({ instanceId, status: 'loading' });
            setSettingsLoadAttempt((attempt) => attempt + 1);
          }}
        >
          Retry settings
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>

      <div className="interrogation-box" style={{ padding: CARD_PADDING }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
          <ExternalLink size={18} />
          <h3 className="serif" style={{ fontSize: '1.25rem', margin: 0, fontWeight: 700 }}>
            Open Workspace
          </h3>
        </div>

        <div style={{ display: 'grid', gap: '1rem', maxWidth: 560 }}>
          <p style={{ fontSize: 13, margin: 0, opacity: 0.8, lineHeight: 1.5 }}>
            Launch this agent&apos;s Hermes WebUI in its own full-screen browser tab, free of the
            embedded-frame limits. Your normal chat surface stays exactly the same.
          </p>

          <button
            type="button"
            data-testid="webui-open-workspace-action"
            onClick={handleOpenWebui}
            disabled={webuiOpening}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              alignSelf: 'flex-start',
              padding: '10px 16px',
              border: '1px solid var(--etched-border)',
              background: 'var(--bg-surface)',
              color: 'var(--ink-black)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              cursor: webuiOpening ? 'wait' : 'pointer',
            }}
          >
            {webuiOpening ? <Loader2 className="animate-spin" size={14} /> : <ExternalLink size={14} />}
            {webuiOpening ? 'Opening' : 'Open WebUI in a new tab'}
          </button>

          {webuiNotice && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>{webuiNotice}</div>
          )}
          {webuiError && (
            <div style={{ fontSize: 12, color: 'var(--danger, #b91c1c)' }}>{webuiError}</div>
          )}
        </div>
      </div>

      <div className="interrogation-box" style={{ padding: CARD_PADDING }} data-testid="hermes-desktop-backend-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
          <Monitor size={18} />
          <h3 className="serif" style={{ fontSize: '1.25rem', margin: 0, fontWeight: 700 }}>
            Hermes Desktop Backend
          </h3>
        </div>

        <div style={{ display: 'grid', gap: '1.25rem', maxWidth: 680 }}>
          <p style={{ fontSize: 13, margin: 0, opacity: 0.82, lineHeight: 1.55 }}>
            Run the native Hermes Desktop app on this agent’s computer — no local install, no Tailscale, no port-forwarding.
            The agent, memory, browser, scheduled tasks and tools all keep running here in the cloud.
          </p>
          <ConnectDesktopButton instanceId={instanceId} />
        </div>
      </div>

      <ConfigurationTailscalePanel
        instanceId={instanceId}
        initialConfig={initialTailscaleConfig}
        isSharedHost={isSharedHost}
      />

      <div className="interrogation-box" style={{ padding: CARD_PADDING }} data-testid="advanced-cloud-access-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
          <Terminal size={18} />
          <h3 className="serif" style={{ fontSize: '1.25rem', margin: 0, fontWeight: 700 }}>
            Advanced Cloud Access
          </h3>
        </div>

        <div style={{ display: 'grid', gap: '1rem', maxWidth: 680 }}>
          <p style={{ fontSize: 13, margin: 0, opacity: 0.8, lineHeight: 1.5 }}>
            Treat this isolated VM as your own cloud computer. When enabled, the agent gets
            root privileges on its computer and can use this VM&apos;s Docker daemon to
            install software, run your own containers, and host additional workloads. It
            remains isolated from the Proxmox host and every other customer VM.
          </p>

          {cloudAccessEligible ? (
            <>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: cloudAccessLoading ? 'wait' : 'pointer' }}>
                <input
                  type="checkbox"
                  aria-label="Advanced cloud access"
                  checked={cloudAccessEnabled}
                  disabled={cloudAccessLoading}
                  onChange={(event) => handleToggleCloudAccess(event.target.checked)}
                />
                <span className="mono" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0 }}>
                  {cloudAccessLoading ? 'Saving' : cloudAccessEnabled ? 'Enabled in settings' : 'Disabled in settings'}
                </span>
                {cloudAccessLoading && <Loader2 className="animate-spin" size={14} />}
              </label>

              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--text-secondary, #6b7280)', lineHeight: 1.5 }}>
                <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  You are responsible for custom system and Docker changes. They can break the
                  agent, and a repair or rebuild may replace disposable runtime files. Keep
                  important data in persistent volumes or backups.
                </span>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--text-secondary, #6b7280)', lineHeight: 1.5 }}>
              <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                This option is only available on isolated customer VMs. It is intentionally
                unavailable on legacy shared-host deployments so one customer can never reach
                another customer&apos;s containers.
              </span>
            </div>
          )}

          {cloudAccessMessage && (
            <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>{cloudAccessMessage}</div>
          )}
          {cloudAccessError && (
            <div style={{ fontSize: 12, color: 'var(--danger, #b91c1c)' }}>{cloudAccessError}</div>
          )}
        </div>
      </div>

      <div className="interrogation-box" style={{ padding: CARD_PADDING }} data-testid="terminal-execution-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
          <Cpu size={18} />
          <h3 className="serif" style={{ fontSize: '1.25rem', margin: 0, fontWeight: 700 }}>
            Terminal Execution
          </h3>
        </div>

        <div style={{ display: 'grid', gap: '1rem', maxWidth: 560 }}>
          <p style={{ fontSize: 13, margin: 0, opacity: 0.8, lineHeight: 1.5 }}>
            <code>local</code> runs commands inside the agent service on your VM. <code>docker</code>{' '}
            runs them in your chosen Docker image and needs Advanced Cloud Access. Saving
            requests a restart to apply.
          </p>

          <label style={{ display: 'grid', gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
              Backend
            </span>
            <select
              aria-label="Terminal execution backend"
              value={terminalBackend}
              disabled={terminalSaving || cloudAccessLoading}
              onChange={(event) => {
                setTerminalBackend(event.target.value as TerminalBackend);
                setTerminalMessage('');
                setTerminalError('');
              }}
              className={styles.field}
            >
              {TERMINAL_BACKENDS.map((backend) => (
                <option key={backend} value={backend}>
                  {backend === 'local'
                    ? 'local — inside the agent service (default)'
                    : backend === 'docker'
                      ? 'docker — your chosen Docker image'
                      : backend === 'modal'
                        ? 'modal — managed cloud sandbox'
                        : 'daytona — your Daytona cloud sandbox'}
                </option>
              ))}
            </select>
          </label>

          {terminalBackend === 'docker' && !cloudAccessEnabled && (
            <div role="alert" style={{ fontSize: 12, color: 'var(--danger, #b91c1c)' }}>
              Docker execution needs Advanced Cloud Access on — that is what exposes this VM&apos;s
              Docker daemon to the agent. Enable it above before saving Docker execution.
            </div>
          )}

          {terminalBackend === 'daytona' && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                Daytona API key {hasDaytonaKey && <span style={{ opacity: 0.6 }}>· saved</span>}
              </span>
              <input
                type="password"
                aria-label="Daytona API key"
                autoComplete="off"
                placeholder={hasDaytonaKey ? '•••••••• (saved — paste to replace)' : 'dtn_…'}
                value={daytonaKeyInput}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={terminalSaving}
                onChange={(event) => setDaytonaKeyInput(event.target.value)}
                className={`${styles.field} ${styles.fieldWide}`}
              />
              <span style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>
                From <code>daytona.io</code>. Stored encrypted. Commands run in Daytona&apos;s
                cloud (not on your agent&apos;s computer), your working tree lives there and syncs back on
                teardown, and Daytona caps sandbox disk at 10 GiB.
              </span>
            </label>
          )}

          <div>
            <button
              type="button"
              onClick={handleSaveTerminal}
              disabled={terminalSaving || cloudAccessLoading || (terminalBackend === 'docker' && !cloudAccessEnabled)}
              className={`mono ${styles.saveButton} ${styles.touchTarget}`}
              style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', padding: '0.5rem 1rem', cursor: terminalSaving ? 'wait' : 'pointer' }}
            >
              {terminalSaving ? 'Saving' : 'Save & apply'}
              {terminalSaving && <Loader2 className="animate-spin" size={14} style={{ marginLeft: 8, verticalAlign: 'middle' }} />}
            </button>
          </div>

          {terminalMessage && (
            <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>{terminalMessage}</div>
          )}
          {terminalError && (
            <div style={{ fontSize: 12, color: 'var(--danger, #b91c1c)' }}>{terminalError}</div>
          )}
        </div>
      </div>

      <div className="interrogation-box" style={{ padding: CARD_PADDING }} data-testid="context-engine-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
          <Layers size={18} />
          <h3 className="serif" style={{ fontSize: '1.25rem', margin: 0, fontWeight: 700 }}>
            Context &amp; Compression
          </h3>
        </div>

        <div style={{ display: 'grid', gap: '1.25rem', maxWidth: 560 }}>
          <p style={{ fontSize: 13, margin: 0, opacity: 0.8, lineHeight: 1.5 }}>
            How your agent keeps its context window affordable. The <strong>context engine</strong> chooses
            between batch summarization (<code>compressor</code>) and the streaming <code>sliding</code>{' '}
            engine. The <strong>compression model</strong> is the cheap model used to summarize old context —
            leave it on <em>inherit</em> to reuse your main model, or point it at a cheaper one. Saving
            requests a restart to apply.
          </p>

          <label style={{ display: 'grid', gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
              Context engine
            </span>
            <select
              aria-label="Context engine"
              value={contextEngine}
              disabled={contextSaving}
              onChange={(event) => {
                setContextEngine(event.target.value as ContextEngine | '');
                setContextMessage('');
                setContextError('');
              }}
              className={styles.field}
            >
              <option value="">agent default (compressor)</option>
              {CONTEXT_ENGINES.map((engine) => (
                <option key={engine} value={engine}>
                  {engine === 'compressor'
                    ? 'compressor — batch summarization (default)'
                    : 'sliding — streaming context engine'}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'grid', gap: 6 }}>
            <span className="mono" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
              Compression model provider
            </span>
            <select
              aria-label="Compression model provider"
              value={compressionProvider}
              disabled={contextSaving}
              onChange={(event) => {
                setCompressionProvider(event.target.value);
                // Provider changed — the previously-picked model no longer belongs
                // to it, so reset to the provider's first model (or inherit).
                setCompressionModel('');
                setContextMessage('');
                setContextError('');
              }}
              className={styles.field}
            >
              <option value="">inherit main model</option>
              {VISIBLE_PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>

          {compressionProvider && (
            <label style={{ display: 'grid', gap: 6 }}>
              <span className="mono" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                Compression model
              </span>
              <select
                aria-label="Compression model"
                value={compressionModel}
                disabled={contextSaving}
                onChange={(event) => {
                  setCompressionModel(event.target.value);
                  setContextMessage('');
                  setContextError('');
                }}
                className={`${styles.field} ${styles.fieldWide}`}
              >
                <option value="">inherit main model</option>
                {(VISIBLE_PROVIDERS.find((provider) => provider.id === compressionProvider)?.models ?? []).map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </select>
              <span style={{ fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>
                Only used for summarizing/compacting context — not for your agent&apos;s actual replies.
                Reuses this provider&apos;s key already on the box.
              </span>
            </label>
          )}

          <div>
            <button
              type="button"
              onClick={handleSaveContext}
              disabled={contextSaving}
              className={`mono ${styles.saveButton} ${styles.touchTarget}`}
              style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', padding: '0.5rem 1rem', cursor: contextSaving ? 'wait' : 'pointer' }}
            >
              {contextSaving ? 'Saving' : 'Save & apply'}
              {contextSaving && <Loader2 className="animate-spin" size={14} style={{ marginLeft: 8, verticalAlign: 'middle' }} />}
            </button>
          </div>

          {contextMessage && (
            <div role="status" style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>{contextMessage}</div>
          )}
          {contextError && (
            <div style={{ fontSize: 12, color: 'var(--danger, #b91c1c)' }}>{contextError}</div>
          )}
        </div>
      </div>

      <ConfigurationDangerZone
        instanceId={instanceId}
        deleteConfirm={deleteConfirm} setDeleteConfirm={setDeleteConfirm}
        deleteInputText={deleteInputText} setDeleteInputText={setDeleteInputText}
        actionLoading={actionLoading}
        handleDeleteInstance={handleDeleteInstance}
        deleteReason={deleteReason} setDeleteReason={setDeleteReason}
        deleteReasonNote={deleteReasonNote} setDeleteReasonNote={setDeleteReasonNote}
      />

    </div>
  );
}
