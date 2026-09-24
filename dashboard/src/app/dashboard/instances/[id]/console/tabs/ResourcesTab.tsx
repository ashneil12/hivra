'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Cpu, Loader2, MemoryStick, RefreshCw } from 'lucide-react';
import styles from '../console.module.css';
import { buildAgentLaunchHref } from '@/lib/hivra/launch-navigation';

type Feedback = { tone: 'success' | 'error'; message: string } | null;

interface Allocation {
  source: 'hermes' | 'hivra';
  id: string;
  name: string;
  status: string;
  cpu: number;
  /** Megabytes. */
  ram: number;
}

interface ResourceSnapshot {
  plan: { name: string; maxAgents: number; totalCpu: number; totalRam: number };
  usage: {
    agentCount: number;
    maxAgents: number;
    usedCpu: number;
    usedRam: number;
    totalCpu: number;
    totalRam: number;
    instances: Allocation[];
  };
}

function responseMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
    return data.error;
  }
  return fallback;
}

function readSnapshot(payload: unknown): ResourceSnapshot | null {
  if (!payload || typeof payload !== 'object' || !('success' in payload) || payload.success !== true || !('data' in payload)) {
    return null;
  }
  const data = payload.data;
  if (!data || typeof data !== 'object' || !('plan' in data) || !('usage' in data) || !data.plan || !data.usage) {
    return null;
  }
  return data as ResourceSnapshot;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function allocationHref(allocation: Allocation): string {
  return allocation.source === 'hivra'
    ? `/dashboard/agent/${encodeURIComponent(allocation.id)}`
    : `/dashboard/instances/${encodeURIComponent(allocation.id)}/console?tab=resources`;
}

export default function ResourcesTab({ instanceId }: { instanceId: string }) {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCpu, setSelectedCpu] = useState<number | null>(null);
  const [selectedRamMb, setSelectedRamMb] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const loadUsage = useCallback(async (): Promise<boolean> => {
    setLoadingUsage(true);
    setLoadError(null);
    try {
      const response = await fetch('/api/billing/usage', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      const nextSnapshot = readSnapshot(payload);
      if (!response.ok || !nextSnapshot) {
        throw new Error(responseMessage(payload, 'Could not load your compute pool.'));
      }
      const current = nextSnapshot.usage.instances.find(
        (allocation) => allocation.source === 'hermes' && allocation.id === instanceId,
      );
      if (!current) {
        throw new Error('This VM is not part of the active compute pool, so it cannot be resized here.');
      }
      setSnapshot(nextSnapshot);
      setSelectedCpu(current.cpu);
      setSelectedRamMb(current.ram);
      return true;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load your compute pool.');
      return false;
    } finally {
      setLoadingUsage(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const current = useMemo(
    () => snapshot?.usage.instances.find(
      (allocation) => allocation.source === 'hermes' && allocation.id === instanceId,
    ) ?? null,
    [instanceId, snapshot],
  );
  const totalCpu = snapshot?.usage.totalCpu ?? snapshot?.plan.totalCpu ?? 0;
  const totalRamMb = snapshot?.usage.totalRam ?? snapshot?.plan.totalRam ?? 0;
  const usedCpu = snapshot?.usage.usedCpu ?? 0;
  const usedRamMb = snapshot?.usage.usedRam ?? 0;
  const freeCpu = Math.max(0, totalCpu - usedCpu);
  const freeRamGb = Math.max(0, totalRamMb - usedRamMb) / 1024;
  const slotsUsed = snapshot?.usage.agentCount ?? 0;
  const maxAgents = snapshot?.usage.maxAgents ?? snapshot?.plan.maxAgents ?? 0;
  const canLaunch = slotsUsed < maxAgents && freeCpu >= 0.5 && freeRamGb >= 1;
  const dirty = Boolean(
    current && selectedCpu !== null && selectedRamMb !== null
      && (selectedCpu !== current.cpu || selectedRamMb !== current.ram),
  );

  const cpuOptions = useMemo(() => {
    if (!current) return [];
    const steps = Math.max(1, Math.floor(current.cpu * 2));
    const values = Array.from({ length: steps }, (_, index) => (index + 1) / 2);
    if (!values.includes(current.cpu)) values.push(current.cpu);
    return values.sort((a, b) => a - b);
  }, [current]);
  const ramOptions = useMemo(() => {
    if (!current) return [];
    const wholeGb = Math.max(1, Math.floor(current.ram / 1024));
    const values = Array.from({ length: wholeGb }, (_, index) => (index + 1) * 1024);
    if (!values.includes(current.ram)) values.push(current.ram);
    return values.sort((a, b) => a - b);
  }, [current]);

  const resizeCurrent = async () => {
    if (!current || selectedCpu === null || selectedRamMb === null || !dirty) return;
    const oldCpu = current.cpu;
    const oldRamMb = current.ram;
    setResizing(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/instances/${instanceId}/resource-reallocation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cpuLimit: selectedCpu, ramLimit: selectedRamMb }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(responseMessage(payload, `${current.name} could not be resized; no allocation was changed.`));
      }

      setConfirming(false);
      const resizedCpu = selectedCpu;
      const resizedRamMb = selectedRamMb;
      const refreshed = await loadUsage();
      const freedCpu = Math.max(0, oldCpu - resizedCpu);
      const freedRamGb = Math.max(0, oldRamMb - resizedRamMb) / 1024;
      setFeedback({
        tone: 'success',
        message: refreshed
          ? `${current.name} now uses ${formatNumber(resizedCpu)} vCPU and ${formatNumber(resizedRamMb / 1024)} GB RAM. ${formatNumber(freedCpu)} vCPU and ${formatNumber(freedRamGb)} GB were returned to your pool.`
          : `${current.name} was resized, but the pool could not be refreshed. Reload this page before launching another agent.`,
      });
    } catch (error) {
      setFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'The resize could not be completed.',
      });
    } finally {
      setResizing(false);
    }
  };

  return (
    <section aria-labelledby="resources-heading" style={{ maxWidth: 820, display: 'grid', gap: 20 }}>
      <div>
        <p className="mono" style={eyebrowStyle}>{snapshot?.plan.name ?? 'Plan'} compute</p>
        <h2 id="resources-heading" className="serif" style={{ margin: '6px 0 0', fontSize: '2rem', fontWeight: 400 }}>Shared compute pool</h2>
        <p style={{ margin: '10px 0 0', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          Allocate your plan&apos;s virtual CPU and RAM across active agents. Physical GPU allocation is not part of this pool.
        </p>
      </div>

      {loadingUsage && !snapshot ? (
        <div role="status" style={statusStyle}><Loader2 size={16} className="animate-spin" /> Loading current allocations…</div>
      ) : loadError && !snapshot ? (
        <div role="alert" style={{ ...statusStyle, borderColor: '#fecaca', color: '#991b1b' }}>
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadUsage()} style={secondaryButtonStyle}><RefreshCw size={13} /> Retry</button>
        </div>
      ) : snapshot && current ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
            <div style={cardStyle}><Cpu size={16} /><strong>{formatNumber(freeCpu)} vCPU free</strong><span style={subtleStyle}>{formatNumber(usedCpu)} of {formatNumber(totalCpu)} allocated</span></div>
            <div style={cardStyle}><MemoryStick size={16} /><strong>{formatNumber(freeRamGb)} GB RAM free</strong><span style={subtleStyle}>{formatNumber(usedRamMb / 1024)} of {formatNumber(totalRamMb / 1024)} GB allocated</span></div>
            <div style={cardStyle}><strong>{slotsUsed} of {maxAgents} agent slots used</strong><span style={subtleStyle}>{Math.max(0, maxAgents - slotsUsed)} slot{Math.max(0, maxAgents - slotsUsed) === 1 ? '' : 's'} available</span></div>
          </div>

          <div style={{ border: '1px solid var(--etched-border)', padding: 20, display: 'grid', gap: 14 }}>
            <div>
              <p className="mono" style={eyebrowStyle}>Active allocations</p>
              <h3 className="serif" style={sectionHeadingStyle}>Where your compute is assigned</h3>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {snapshot.usage.instances.map((allocation) => {
                const isCurrent = allocation.source === 'hermes' && allocation.id === instanceId;
                return (
                  <div key={`${allocation.source}-${allocation.id}`} style={allocationRowStyle}>
                    <div style={{ display: 'grid', gap: 3 }}>
                      <strong>{allocation.name}</strong>
                      <span style={subtleStyle}>{formatNumber(allocation.cpu)} vCPU · {formatNumber(allocation.ram / 1024)} GB RAM · {allocation.status}</span>
                    </div>
                    {isCurrent ? (
                      <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Resize below</span>
                    ) : (
                      <Link href={allocationHref(allocation)} className={styles.linkTarget} style={manageLinkStyle}>Manage <ArrowUpRight size={12} /></Link>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ border: '1px solid var(--etched-border)', padding: 20, display: 'grid', gap: 15 }}>
            <div>
              <p className="mono" style={eyebrowStyle}>Resize {current.name}</p>
              <h3 className="serif" style={sectionHeadingStyle}>Return compute to the pool</h3>
              <p style={{ margin: '8px 0 0', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                Choose a smaller allocation to make room for another agent. A visible CPU-core change may briefly restart this VM; RAM-only changes normally apply live.
              </p>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              <fieldset style={fieldsetStyle}>
                <legend className="mono" style={legendStyle}>vCPU</legend>
                <div style={choiceRowStyle}>
                  {cpuOptions.map((value) => (
                    <button key={value} type="button" aria-pressed={selectedCpu === value} onClick={() => { setSelectedCpu(value); setConfirming(false); setFeedback(null); }} className={styles.choiceTarget} style={choiceButtonStyle(selectedCpu === value)}>{formatNumber(value)} vCPU</button>
                  ))}
                </div>
              </fieldset>
              <fieldset style={fieldsetStyle}>
                <legend className="mono" style={legendStyle}>RAM</legend>
                <div style={choiceRowStyle}>
                  {ramOptions.map((value) => (
                    <button key={value} type="button" aria-pressed={selectedRamMb === value} onClick={() => { setSelectedRamMb(value); setConfirming(false); setFeedback(null); }} className={styles.choiceTarget} style={choiceButtonStyle(selectedRamMb === value)}>{formatNumber(value / 1024)} GB</button>
                  ))}
                </div>
              </fieldset>
            </div>

            {feedback && <p role={feedback.tone === 'error' ? 'alert' : 'status'} style={{ margin: 0, padding: 12, background: feedback.tone === 'success' ? 'var(--vellum-bg)' : '#fef2f2', color: feedback.tone === 'success' ? 'var(--ink-black)' : '#991b1b', border: `1px solid ${feedback.tone === 'success' ? 'var(--etched-border)' : '#fecaca'}`, lineHeight: 1.55 }}>{feedback.message}</p>}

            {confirming && selectedCpu !== null && selectedRamMb !== null ? (
              <div style={{ border: '1px solid rgba(192, 98, 63, 0.35)', background: 'rgba(192, 98, 63, 0.05)', padding: 14, display: 'grid', gap: 10 }}>
                <strong>Confirm {current.name}: {formatNumber(current.cpu)} vCPU / {formatNumber(current.ram / 1024)} GB → {formatNumber(selectedCpu)} vCPU / {formatNumber(selectedRamMb / 1024)} GB</strong>
                <span style={subtleStyle}>The new limits are applied to the VM and its running containers before capacity is shown as free.</span>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => void resizeCurrent()} disabled={resizing} style={primaryButtonStyle}>
                    {resizing ? <Loader2 size={14} className="animate-spin" /> : null} Confirm resize
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} disabled={resizing} style={secondaryButtonStyle}>Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} disabled={!dirty || resizing} style={{ ...primaryButtonStyle, opacity: dirty ? 1 : 0.45, cursor: dirty ? 'pointer' : 'default' }}>Review resize</button>
            )}
          </div>

          <div style={{ border: '1px solid var(--etched-border)', padding: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'grid', gap: 5 }}>
              <strong>{canLaunch ? 'Capacity is available for another agent' : slotsUsed >= maxAgents ? 'All agent slots are in use' : 'Shrink an allocation to make room'}</strong>
              <span style={subtleStyle}>{canLaunch ? `${formatNumber(freeCpu)} vCPU and ${formatNumber(freeRamGb)} GB RAM are currently free.` : 'The launch flow will enforce the minimum size and your remaining pool.'}</span>
            </div>
            {canLaunch ? <Link href={buildAgentLaunchHref()} style={primaryLinkStyle}>Launch another agent <ArrowUpRight size={14} /></Link> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

const eyebrowStyle = { margin: 0, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.1em', color: 'var(--text-muted)' };
const sectionHeadingStyle = { margin: '5px 0 0', fontSize: '1.4rem', fontWeight: 400 } as const;
const cardStyle = { border: '1px solid var(--etched-border)', padding: 16, display: 'grid', gap: 7, color: 'var(--ink-black)' } as const;
const subtleStyle = { fontSize: 13, color: 'var(--text-secondary)' } as const;
const statusStyle = { border: '1px solid var(--etched-border)', padding: 18, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, color: 'var(--text-secondary)' } as const;
const allocationRowStyle = { border: '1px solid var(--etched-border)', padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const };
const manageLinkStyle = { display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--ink-black)', fontFamily: 'var(--font-mono)', fontSize: 11, textTransform: 'uppercase' as const, textDecoration: 'none' };
const fieldsetStyle = { border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 } as const;
const legendStyle = { fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 8 };
const choiceRowStyle = { display: 'flex', gap: 8, flexWrap: 'wrap' as const };
const choiceButtonStyle = (selected: boolean) => ({ border: '1px solid var(--etched-border)', background: selected ? 'var(--gold-leaf)' : 'transparent', color: 'var(--ink-black)', padding: '7px 11px', fontFamily: 'var(--font-mono)', fontSize: 11, cursor: 'pointer' });
const primaryButtonStyle = { display: 'inline-flex', alignItems: 'center', gap: 8, width: 'fit-content', border: '1px solid var(--ink-black)', background: 'var(--ink-black)', color: 'var(--bg-surface)', padding: '10px 14px', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.06em', cursor: 'pointer' };
const secondaryButtonStyle = { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--etched-border)', background: 'transparent', color: 'var(--ink-black)', padding: '9px 13px', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.06em', cursor: 'pointer' };
const primaryLinkStyle = { ...primaryButtonStyle, textDecoration: 'none' };
