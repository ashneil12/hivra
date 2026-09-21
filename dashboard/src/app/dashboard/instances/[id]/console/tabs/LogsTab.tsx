import { useState, useEffect, useCallback } from 'react';
import { pollWhenVisible } from '@/lib/poll-when-visible';
import { Loader2 } from 'lucide-react';

export default function LogsTab({ instanceId }: { instanceId: string }) {
  const [logs, setLogs] = useState<string>('');
  const [source, setSource] = useState<string>('');
  const [loading, setLoading] = useState(true);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`/api/instances/${instanceId}/console/logs`);
      const data = await res.json();
      if (data.success) {
        setLogs(data.data.logs);
        setSource(data.data.source || '');
      } else {
        setLogs(`Error finding logs: ${data.error}`);
        setSource('error');
      }
    } catch {
      // Network drop or a non-JSON error body (Safari rejects res.json() with a
      // DOMException). Keep any logs we already have and let the next poll retry.
      setLogs((prev) => prev || 'Unable to reach the gateway log stream. Retrying...');
      setSource('error');
    } finally { setLoading(false); }
  }, [instanceId]);

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(pollWhenVisible(fetchLogs), 10000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  return (
    <div className="interrogation-box" style={{ padding: '1rem', height: 640, display: 'flex', flexDirection: 'column', background: 'var(--ink-black)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: '1rem', borderBottom: '1px solid var(--overlay-bg)', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="indicator-pulse" />
            <div style={{ display: 'grid', gap: 4 }}>
              <span className="mono" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em', color: "var(--bg-surface)", fontWeight: 700 }}>Gateway Output Stream</span>
              <span className="mono" style={{ fontSize: 9, letterSpacing: '0.08em', color: "rgba(255,255,255,0.58)", textTransform: 'uppercase' }}>
                {source === 'docker-stdout'
                  ? 'Source: container stdout fallback'
                  : source === 'host-update-log'
                    ? 'Source: host update log'
                    : source === 'error'
                      ? 'Source: unavailable'
                      : source
                        ? `Source: ${source}`
                        : 'Source: resolving'}
              </span>
            </div>
          </div>
          <Loader2 size={14} className="animate-spin" style={{ color: "var(--bg-surface)", opacity: 0.5 }} />
       </div>
      {loading && !logs ? <div style={{ opacity: 0.3, color: "var(--bg-surface)" }} className="mono">Connecting to gateway...</div> : (
        <pre style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'var(--font-mono), monospace', fontSize: 11, overflowY: 'auto', color: '#a1a1aa', lineHeight: 1.55 }}>
          {logs || 'No logs available.'}
        </pre>
      )}
    </div>
  );
}
