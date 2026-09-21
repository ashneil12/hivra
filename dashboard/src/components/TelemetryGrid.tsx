"use client";

import React, { useEffect, useState, useCallback } from 'react';
import { pollWhenVisible } from '@/lib/poll-when-visible';
import { Activity, Cpu, HardDrive, Box, Loader2, Sparkles, Zap } from 'lucide-react';
import { useUser } from "@clerk/nextjs";
import { useLocale } from '@/components/i18n/LocaleProvider';
import { readStoredJson, writeStoredJsonIfChanged } from '@/lib/client-storage';
import { clientLog } from '@/lib/client/logger';

export type OverviewData = { status: string; uptime: string; cpu: string; memory: string; network: string; };

function MetricCard({ label, value, icon: Icon, color, subText }: { label: string; value: string | number; icon: React.ElementType; color: string; subText?: string }) {
  return (
    <div style={{ padding: '1.25rem 1.5rem', border: '1px solid var(--etched-border)', background: 'var(--bg-surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '1rem', opacity: 0.7 }}>
        <Icon size={14} color={color} />
        <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <h3 className="serif" style={{ fontSize: '2rem', fontWeight: 400, margin: 0, lineHeight: 1.1 }}>{value}</h3>
        <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: color, boxShadow: `0 0 10px ${color}` }} />
      </div>
      {subText && <div className="mono" style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.5, marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--etched-border)' }}>{subText}</div>}
    </div>
  );
}

export function TelemetryGrid({ instanceId, provider, model, compact }: { instanceId: string; provider?: string; model?: string; compact?: boolean }) {
  const { copy, locale } = useLocale();
  const dashboardCopy = copy.dashboard.commandCenter;
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  const { user, isLoaded } = useUser();
  const userId = user?.id;

  useEffect(() => {
     if (!isLoaded || !userId) return;
     const cached = readStoredJson<OverviewData>(localStorage, `telemetry_${instanceId}_${userId}`);
     if (cached) {
        setData(cached);
        setLoading(false);
     }
  }, [instanceId, userId, isLoaded]);

  const fetchOverview = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetch(`/api/instances/${instanceId}/console/overview`, {
        headers: {
          'Accept': 'application/json'
        }
      });

      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
         const text = await res.text();
         clientLog.error("Telemetry endpoint returned non-JSON", new Error("Unexpected telemetry content type"), {
           source: "telemetry-grid",
           instanceId,
           status: res.status,
           contentType,
           bodyLength: text.length,
         });
         return;
      }

      const details = await res.json();
      if (details.success) {
         setData(details.data);
         writeStoredJsonIfChanged(localStorage, `telemetry_${instanceId}_${userId}`, details.data);
      } else {
         clientLog.error("Telemetry API returned success=false", new Error("Telemetry API failed"), {
           source: "telemetry-grid",
           instanceId,
           status: res.status,
         });
      }
    } catch (err) {
      clientLog.error("Failed to fetch telemetry", err, {
        source: "telemetry-grid",
        instanceId,
        failureType: "telemetry_fetch_failed",
      });
    } finally {
      setLoading(false);
    }
  }, [instanceId, userId]);

  useEffect(() => {
    if (!isLoaded || !userId) return;
    fetchOverview();
    const interval = setInterval(pollWhenVisible(fetchOverview), 30000);
    return () => clearInterval(interval);
  }, [fetchOverview, isLoaded, userId]);

  if (loading) {
    return (
      <div style={{ display: 'flex', padding: '2rem', justifyContent: 'center' }}>
        <Loader2 className="animate-spin" size={20} style={{ opacity: 0.4 }} />
      </div>
    );
  }

  if (!data) return null;

  const displayModel = model
    ? (model.length > 18 ? model.slice(0, 18) + '…' : model)
    : '—';
  const displayProvider = provider
    ? provider.charAt(0).toUpperCase() + provider.slice(1)
    : '—';
  const statusCopy = dashboardCopy.status;
  const normalizedStatus = data.status.toLowerCase() as keyof typeof statusCopy;
  const localizedStatus = statusCopy[normalizedStatus] ?? data.status;
  const displayStatus = locale === "en" ? localizedStatus.toUpperCase() : localizedStatus;
  const displayUptime = locale === "zh-CN" ? localizeChineseDuration(data.uptime) : data.uptime;

  return (
    <div style={{ marginBottom: compact ? 0 : '2rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div className={compact ? "grid grid-cols-2 gap-3" : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6"}>
        <MetricCard label={dashboardCopy.telemetry.containerState} value={displayStatus} icon={Activity} color="#22c55e" subText={`${dashboardCopy.telemetry.uptimePrefix}${dashboardCopy.labelSeparator}${displayUptime}`} />
        <MetricCard label={dashboardCopy.telemetry.cpuUtilization} value={data.cpu} icon={Cpu} color="#3b82f6" subText={dashboardCopy.telemetry.hostComputeNode} />
        <MetricCard label={dashboardCopy.telemetry.memoryAllocation} value={data.memory.split(' / ')[0]} icon={HardDrive} color="#a855f7" subText={`${dashboardCopy.telemetry.limitPrefix}${dashboardCopy.labelSeparator}${data.memory.split(' / ')[1] || dashboardCopy.telemetry.unrestricted}`} />
        <MetricCard label={dashboardCopy.telemetry.networkIo} value={data.network.split(' / ')[0]} icon={Box} color="#eab308" subText={`${dashboardCopy.telemetry.totalTxPrefix}${dashboardCopy.labelSeparator}${data.network.split(' / ')[1] || '0B'}`} />
      </div>
      {/* Active Model + Provider cards are hidden in compact mode (Command Center). */}
      {!compact && (provider || model) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <MetricCard label={dashboardCopy.telemetry.activeModel} value={displayModel} icon={Sparkles} color="#f472b6" subText={provider ? `${dashboardCopy.telemetry.providerPrefix}${dashboardCopy.labelSeparator}${displayProvider}` : dashboardCopy.instance.configuredInAgentSettings} />
          <MetricCard label={dashboardCopy.telemetry.provider} value={displayProvider} icon={Zap} color="#fb923c" subText={dashboardCopy.telemetry.llmInferenceEngine} />
        </div>
      )}
    </div>
  );
}

function localizeChineseDuration(value: string) {
  return value
    .replace(/\b(\d+)\s+hours?\b/gi, "$1 小时")
    .replace(/\b(\d+)\s+minutes?\b/gi, "$1 分钟")
    .replace(/\b(\d+)\s+seconds?\b/gi, "$1 秒")
    .replace(/\b(\d+)\s+days?\b/gi, "$1 天");
}
