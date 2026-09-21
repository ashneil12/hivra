'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { ArrowLeft, ExternalLink, Globe, Loader2, PanelRight, RefreshCw, Star, Terminal, X } from 'lucide-react';

import { TerminalPanel } from '@/components/TerminalPanel';
import { useProfiles } from '@/lib/hooks/useProfiles';
import {
  getDefaultInstanceSurfacePreference,
  getStoredInstanceSurfacePreference,
  setStoredInstanceSurfacePreference,
  type InstanceSurfacePreference,
} from '@/lib/instance-surface-preference';
import { getHermesTuiTheme, resolveHermesTuiColorMode, type HermesTuiTheme } from '@/lib/tui-theme';

interface InstanceData {
  id: string;
  name: string;
  status: string;
  backend?: 'gateway' | 'webui' | null;
  provider: string;
  gateway_url?: string | null;
  config?: Record<string, unknown>;
}

type BrowserReadiness = 'checking' | 'ready' | 'unavailable';
function InfoCard({
  label,
  value,
  hint,
  theme,
}: {
  label: string;
  value: string;
  hint?: string;
  theme: HermesTuiTheme['workspace'];
}) {
  return (
    <div style={{
      border: `1px solid ${theme.border}`,
      borderRadius: 8,
      background: theme.panelBackground,
      padding: '12px',
      display: 'grid',
      gap: 6,
    }}>
      <span style={{
        fontFamily: 'var(--font-mono), monospace',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        color: theme.labelAccent,
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 14,
        fontWeight: 600,
        color: theme.textPrimary,
        wordBreak: 'break-word',
      }}>
        {value}
      </span>
      {hint ? (
        <span style={{ fontSize: 12, lineHeight: 1.5, color: theme.textMuted }}>{hint}</span>
      ) : null}
    </div>
  );
}

export default function DedicatedHermesTuiPage(_props: { params?: Promise<{ id: string }> }) {
  void _props;
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const mountedRef = useRef(true);
  const [instance, setInstance] = useState<InstanceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [preferredSurface, setPreferredSurface] = useState<InstanceSurfacePreference>('chat');
  const [utilityRailOpen, setUtilityRailOpen] = useState(false);
  const [refreshingWorkspace, setRefreshingWorkspace] = useState(false);
  const [panelSessionVersion, setPanelSessionVersion] = useState(0);
  const [browserReadiness, setBrowserReadiness] = useState<BrowserReadiness>('checking');
  const [browserStatusHint, setBrowserStatusHint] = useState('Checking the browser sidecar for this workspace.');
  const { profiles, isLoading: profilesLoading } = useProfiles(id, { summary: true });

  const fetchInstance = useCallback(async () => {
    try {
      const response = await fetch(`/api/instances/${id}?no_sync=true`);
      const payload = await response.json();
      if (!mountedRef.current) return;

      if (payload?.success && payload.data) {
        setInstance(payload.data);
      } else {
        setInstance(null);
      }
    } catch {
      if (mountedRef.current) {
        setInstance(null);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [id]);

  const fetchBrowserReadiness = useCallback(async () => {
    setBrowserReadiness('checking');
    setBrowserStatusHint('Checking the browser sidecar for this workspace.');

    try {
      const response = await fetch(`/api/instances/${id}/browser-sessions`, { cache: 'no-store' });
      if (!mountedRef.current) return;

      if (response.ok) {
        setBrowserReadiness('ready');
        setBrowserStatusHint('Browser automation is available. Open the live stream when the agent is actively browsing.');
        return;
      }

      setBrowserReadiness('unavailable');
      setBrowserStatusHint(response.status === 503
        ? 'The browser sidecar is not ready yet. Try again after the agent starts a browser task.'
        : 'Browser status could not be confirmed from this workspace.');
    } catch {
      if (!mountedRef.current) return;
      setBrowserReadiness('unavailable');
      setBrowserStatusHint('Browser status could not be reached from this workspace.');
    }
  }, [id]);

  useEffect(() => {
    setPreferredSurface(
      getStoredInstanceSurfacePreference(
        id,
        undefined,
        getDefaultInstanceSurfacePreference(instance?.backend)
      )
    );
  }, [id, instance?.backend]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchInstance();
    void fetchBrowserReadiness();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchBrowserReadiness, fetchInstance]);

  useEffect(() => {
    if (!utilityRailOpen || typeof window === 'undefined') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setUtilityRailOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [utilityRailOpen]);

  const workspaceName = instance?.name || 'Hermes';
  const runtimeModel = typeof instance?.config?.model === 'string' ? instance.config.model : 'Configured in agent';
  const runtimeProvider = instance?.provider || 'openrouter';
  const isDefaultWorkspace = preferredSurface === 'tui';
  const pagePadding = 'clamp(10px, 2vw, 18px)';
  const pagePaddingTop = `calc(env(safe-area-inset-top, 0px) + ${pagePadding})`;
  const utilityRailButtonLabel = utilityRailOpen ? 'Hide workspace details' : 'Open workspace details';
  const colorMode = useMemo(() => resolveHermesTuiColorMode(resolvedTheme), [resolvedTheme]);
  const tuiTheme = useMemo(() => getHermesTuiTheme(colorMode), [colorMode]);
  const workspaceTheme = tuiTheme.workspace;

  const toggleDefaultWorkspace = useCallback(() => {
    const nextSurface: InstanceSurfacePreference = isDefaultWorkspace ? 'chat' : 'tui';
    setStoredInstanceSurfacePreference(id, nextSurface);
    setPreferredSurface(nextSurface);
  }, [id, isDefaultWorkspace]);

  const connectionValue = useMemo(() => {
    if (!instance) return 'Unavailable';
    if (instance.status !== 'running') return `Instance ${instance.status}`;
    return 'Terminal bridge';
  }, [instance]);

  const gatewayValue = useMemo(() => {
    if (!instance?.gateway_url) return 'Not exposed';

    try {
      return new URL(instance.gateway_url).host;
    } catch {
      return instance.gateway_url;
    }
  }, [instance?.gateway_url]);

  const profilesValue = useMemo(() => {
    if (profilesLoading) return 'Loading profiles…';
    const count = Math.max(1, profiles.length);
    return `${count} agent ${count === 1 ? 'profile' : 'profiles'}`;
  }, [profiles, profilesLoading]);

  const profilesHint = useMemo(() => {
    if (profilesLoading) return 'Loading profile list.';
    const labels = profiles
      .slice(0, 3)
      .map((profile) => profile.display_name || (profile.name === 'default' ? 'main' : profile.name))
      .join(' · ');

    if (!profiles.length) {
      return 'No profiles found.';
    }

    return labels
      ? `${labels}${profiles.length > 3 ? '…' : ''}`
      : 'Profiles available in chat.';
  }, [profiles, profilesLoading]);

  const transportHint = 'Streaming terminal';
  const browserValue = browserReadiness === 'ready'
    ? 'Browser ready'
    : browserReadiness === 'checking'
      ? 'Checking browser'
      : 'Browser unavailable';

  const refreshWorkspace = useCallback(async () => {
    setRefreshingWorkspace(true);
    try {
      await Promise.all([fetchInstance(), fetchBrowserReadiness()]);
      setPanelSessionVersion((version) => version + 1);
    } finally {
      if (mountedRef.current) {
        setRefreshingWorkspace(false);
      }
    }
  }, [fetchBrowserReadiness, fetchInstance]);

  const openLiveBrowser = useCallback(() => {
    if (typeof window === 'undefined') return;
    window.open(`/api/instances/${id}/browser-stream`, '_blank', 'noopener,noreferrer');
  }, [id]);

  if (loading) {
    return (
      <div style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: workspaceTheme.loadingBackground,
      }}>
        <Loader2 size={20} style={{ color: workspaceTheme.loadingAccent, animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  return (
    <div style={{
      height: '100dvh',
      display: 'grid',
      boxSizing: 'border-box',
      background: workspaceTheme.pageBackground,
      color: workspaceTheme.textPrimary,
      padding: pagePadding,
      paddingTop: pagePaddingTop,
      overflow: 'hidden',
    }} data-testid="dedicated-tui-shell" data-color-mode={colorMode}>
      <div style={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        display: 'grid',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        gap: 10,
        overflow: 'hidden',
        }} data-testid="dedicated-tui-workspace">
        <div style={{
          border: `1px solid ${workspaceTheme.borderSoft}`,
          borderRadius: 8,
          background: workspaceTheme.panelBackgroundAlt,
          boxShadow: workspaceTheme.shadow,
          padding: '9px 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          minWidth: 0,
          flexWrap: 'wrap',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button
              onClick={() => router.push(`/dashboard/instances/${id}?surface=chat`)}
              style={getIconButtonStyle(workspaceTheme)}
              aria-label="Back to chat"
              title="Back to chat"
            >
              <ArrowLeft size={14} />
            </button>

            <div style={{
              width: 32,
              height: 32,
              borderRadius: 6,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: `1px solid ${workspaceTheme.buttonBorder}`,
              background: workspaceTheme.buttonBackgroundActive,
              color: workspaceTheme.labelAccent,
              flexShrink: 0,
            }}>
              <Terminal size={16} />
            </div>

            <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
                <span style={{
                  color: workspaceTheme.textPrimary,
                  fontSize: 14,
                  fontWeight: 700,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 360,
                }}>
                  {workspaceName}
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: 10,
                  color: workspaceTheme.textMuted,
                }}>
                  Hermes TUI
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono), monospace',
                  fontSize: 10,
                  color: workspaceTheme.textSubtle,
                }}>
                  {id.slice(0, 8)}
                </span>
              </div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                fontSize: 10,
                color: workspaceTheme.textMuted,
                fontFamily: 'var(--font-mono), monospace',
              }}>
                <span>{connectionValue}</span>
                <span>{runtimeProvider}</span>
                <span>{runtimeModel}</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={refreshWorkspace}
              style={getIconButtonStyle(workspaceTheme, refreshingWorkspace)}
              disabled={refreshingWorkspace}
              aria-label="Reconnect terminal"
              title="Reconnect terminal"
            >
              <RefreshCw
                size={14}
                style={refreshingWorkspace ? { animation: 'spin 1s linear infinite' } : undefined}
              />
            </button>
            <button
              onClick={openLiveBrowser}
              style={getIconButtonStyle(workspaceTheme, browserReadiness !== 'ready')}
              disabled={browserReadiness !== 'ready'}
              aria-label={browserReadiness === 'ready' ? 'Open live browser' : browserValue}
              title={browserReadiness === 'ready' ? 'Open live browser' : browserValue}
            >
              {browserReadiness === 'checking' ? (
                <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
              ) : browserReadiness === 'ready' ? (
                <ExternalLink size={14} />
              ) : (
                <Globe size={14} />
              )}
            </button>
            <button
              onClick={() => setUtilityRailOpen((open) => !open)}
              style={getIconButtonStyle(workspaceTheme)}
              aria-label={utilityRailButtonLabel}
              aria-controls="workspace-utility-rail"
              aria-expanded={utilityRailOpen}
              title={utilityRailButtonLabel}
            >
              <PanelRight size={14} />
            </button>
            <button
              onClick={toggleDefaultWorkspace}
              style={getIconButtonStyle(workspaceTheme, false, isDefaultWorkspace)}
              aria-label="Set as default workspace"
              title={isDefaultWorkspace ? 'Default workspace' : 'Set as default workspace'}
            >
              <Star size={14} fill={isDefaultWorkspace ? 'currentColor' : 'none'} />
            </button>
          </div>
        </div>

        <div style={{
          position: 'relative',
          display: 'flex',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
        }} data-tui-grid="main">
          <div style={{
            display: 'flex',
            flex: 1,
            width: '100%',
            minWidth: 0,
            minHeight: 0,
            height: '100%',
            border: `1px solid ${workspaceTheme.border}`,
            borderRadius: 8,
            background: workspaceTheme.terminalCardBackground,
            boxShadow: workspaceTheme.shadow,
            overflow: 'hidden',
          }} data-testid="dedicated-tui-terminal-card">
            <TerminalPanel
              key={`${id}:terminal:${panelSessionVersion}`}
              instanceId={id}
              isActive
              sessionMode="tui"
              colorMode={colorMode}
              surfaceKey="tui-fullpage"
            />
          </div>

          {utilityRailOpen ? (
            <aside
              id="workspace-utility-rail"
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                bottom: 0,
                width: 'min(320px, calc(100vw - 36px))',
                display: 'grid',
                gap: 10,
                alignContent: 'start',
                minWidth: 0,
                minHeight: 0,
                overflow: 'auto',
                overscrollBehavior: 'contain',
                padding: 12,
                background: workspaceTheme.utilityRailBackground,
                borderLeft: `1px solid ${workspaceTheme.borderSoft}`,
                boxShadow: workspaceTheme.overlayShadow,
                zIndex: 2,
              }}
              data-tui-rail="sidebar"
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                border: `1px solid ${workspaceTheme.borderSoft}`,
                borderRadius: 8,
                background: workspaceTheme.panelBackgroundAlt,
                padding: 12,
              }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <span style={{
                    fontFamily: 'var(--font-mono), monospace',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.14em',
                    color: workspaceTheme.labelAccent,
                  }}>
                    Workspace tools
                  </span>
                  <span style={{
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: workspaceTheme.textMuted,
                  }}>
                    {workspaceName} · {id.slice(0, 8)}
                  </span>
                </div>
                <button
                  onClick={() => setUtilityRailOpen(false)}
                  style={getIconButtonStyle(workspaceTheme)}
                  aria-label="Close utility rail"
                >
                  <X size={14} />
                </button>
              </div>

              <div style={{
                display: 'grid',
                gap: 12,
                border: `1px solid ${workspaceTheme.borderSoft}`,
                borderRadius: 8,
                background: workspaceTheme.panelBackgroundAlt,
                padding: 12,
              }}>
                <InfoCard
                  label="Connection"
                  value={connectionValue}
                  theme={workspaceTheme}
                  hint={transportHint}
                />
                <InfoCard
                  label="Agent profiles"
                  value={profilesValue}
                  theme={workspaceTheme}
                  hint={profilesHint}
                />
                <InfoCard
                  label="Runtime"
                  value={`${runtimeProvider} · ${runtimeModel}`}
                  theme={workspaceTheme}
                  hint={`Instance status: ${instance?.status || 'unknown'}`}
                />
                <InfoCard
                  label="Gateway"
                  value={gatewayValue}
                  theme={workspaceTheme}
                  hint="Live gateway"
                />
                <InfoCard
                  label="Browser"
                  value={browserValue}
                  theme={workspaceTheme}
                  hint={browserStatusHint}
                />
              </div>

              <div style={{
                display: 'grid',
                gap: 10,
                border: `1px solid ${workspaceTheme.borderSoft}`,
                borderRadius: 8,
                background: workspaceTheme.panelBackgroundAlt,
                padding: 12,
              }}>
                <button
                  onClick={() => router.push(`/dashboard/instances/${id}?surface=chat`)}
                  style={getActionButtonStyle(workspaceTheme)}
                >
                  <ArrowLeft size={14} /> Chat
                </button>
                <button
                  onClick={refreshWorkspace}
                  style={getActionButtonStyle(workspaceTheme, refreshingWorkspace)}
                  disabled={refreshingWorkspace}
                >
                  <RefreshCw
                    size={14}
                    style={refreshingWorkspace ? { animation: 'spin 1s linear infinite' } : undefined}
                  />
                  {refreshingWorkspace ? 'Reconnecting…' : 'Reconnect'}
                </button>
                <button
                  onClick={openLiveBrowser}
                  style={getActionButtonStyle(workspaceTheme, browserReadiness !== 'ready')}
                  disabled={browserReadiness !== 'ready'}
                >
                  {browserReadiness === 'checking' ? (
                    <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
                  ) : browserReadiness === 'ready' ? (
                    <ExternalLink size={14} />
                  ) : (
                    <Globe size={14} />
                  )}
                  {browserReadiness === 'checking' ? 'Checking…' : 'Browser'}
                </button>
              </div>
            </aside>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function getActionButtonStyle(theme: HermesTuiTheme['workspace'], disabled = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
    padding: '10px 12px',
    border: `1px solid ${theme.border}`,
    borderRadius: 6,
    background: theme.buttonBackground,
    color: theme.buttonText,
    cursor: disabled ? 'wait' : 'pointer',
    opacity: disabled ? 0.72 : 1,
    fontFamily: 'var(--font-mono), monospace',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
  };
}

function getIconButtonStyle(
  theme: HermesTuiTheme['workspace'],
  disabled = false,
  active = false,
): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: 6,
    border: `1px solid ${active ? theme.buttonBorder : theme.border}`,
    background: active ? theme.buttonBackgroundActive : theme.iconButtonBackground,
    color: active ? theme.labelAccent : theme.iconButtonText,
    cursor: disabled ? 'wait' : 'pointer',
    opacity: disabled ? 0.68 : 1,
    padding: 0,
  };
}
