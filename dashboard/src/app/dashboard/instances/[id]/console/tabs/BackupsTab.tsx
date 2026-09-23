import { useState, useEffect } from 'react';
import { ShieldCheck, HardDrive, AlertTriangle, Loader2 } from 'lucide-react';
import Link from 'next/link';
import styles from '../console.module.css';

// iOS types "Restore"; the server requires the exact word, so compare loosely
// and send the canonical form.
function isRestoreConfirmation(input: string): boolean {
  return input.trim().toUpperCase() === 'RESTORE';
}

export default function BackupsTab({ instanceId }: { instanceId: string }) {
  const [backupsEnabled, setBackupsEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fetchingBackups, setFetchingBackups] = useState(false);
  const [backups, setBackups] = useState<{ id: string; created: string; description?: string; disk_size?: number | null; size_bytes?: number | null; sha256?: string; vmid?: number; pve_host?: string; mode?: string }[]>([]);
  const [backupError, setBackupError] = useState('');
  
  const [restoring, setRestoring] = useState(false);
  const [restoreConfirmBackupId, setRestoreConfirmBackupId] = useState<string | null>(null);
  const [restoreInputText, setRestoreInputText] = useState('');

  const loadBackups = async () => {
    setFetchingBackups(true);
    setBackupError('');
    try {
      const res = await fetch(`/api/instances/${instanceId}/backups`);
      if (!res.ok) throw new Error('Failed to fetch restore points');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to fetch restore points');
      const points = data.data.backups || [];
      setBackups(points);
      // Granular daily backups are included on paid plans; presence of restore
      // points (or the per-instance flag) means protection is active.
      if (points.length > 0) setBackupsEnabled(true);
      return points.length;
    } catch (e: unknown) {
      setBackupError(e instanceof Error ? e.message : 'Error communicating with infrastructure');
      return 0;
    } finally {
      setFetchingBackups(false);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/instances/${instanceId}`);
        const json = await res.json();
        if (json.success) {
          setBackupsEnabled(!!json.data.backups_enabled);
        }
        // Auto-load restore points so the user immediately sees their data is protected.
        await loadBackups();
      } catch {
        // Degrade into the existing error banner instead of an unhandled
        // rejection when the instance fetch fails or returns a non-JSON body.
        setBackupError('Error communicating with infrastructure');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  const restoreBackup = async (backupId: string) => {
    setRestoring(true);
    try {
      const res = await fetch(`/api/instances/${instanceId}/backups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backupId, confirm: isRestoreConfirmation(restoreInputText) ? 'RESTORE' : restoreInputText })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.data?.message || "Restore request recorded. Ops will verify the backup before cutover.");
      } else {
        alert("Restore request failed: " + data.error);
      }
    } catch {
      alert("Network error during restoration request.");
    } finally {
      setRestoring(false);
      setRestoreConfirmBackupId(null);
      setRestoreInputText('');
    }
  };

  if (loading) return <div style={{ display: 'flex', padding: '3rem', justifyContent: 'center' }}><Loader2 className="animate-spin" size={24} style={{ opacity: 0.4 }} /></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* Banner */}
      <div className="interrogation-box" style={{ 
        padding: '1.5rem', 
        border: backupsEnabled ? '1px solid #16a34a' : '1px solid var(--etched-border)',
        background: backupsEnabled ? 'rgba(22,163,74,0.05)' : 'var(--bg-surface)' 
      }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: 16, flex: '1 1 220px', minWidth: 0 }}>
            <div className={styles.backupsIcon} style={{
              borderRadius: '50%',
              background: backupsEnabled ? 'rgba(22,163,74,0.1)' : 'rgba(0,0,0,0.05)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
            }}>
              <ShieldCheck size={24} color={backupsEnabled ? '#16a34a' : 'var(--ink-black)'} style={{ opacity: backupsEnabled ? 1 : 0.4 }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 className="mono" style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.1em', margin: '0 0 8px 0', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                Daily Data Backups
                <span style={{ fontSize: 11, padding: '2px 6px', background: backupsEnabled ? '#16a34a' : '#d1d5db', color: backupsEnabled ? '#fff' : '#374151', borderRadius: 0 }}>
                  {backupsEnabled ? 'ACTIVE' : 'INACTIVE'}
                </span>
              </h3>
              {backupsEnabled ? (
                <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--ink-black)', opacity: 0.7, maxWidth: 600 }}>
                  Your chats, sessions and workspace files are backed up automatically every day, encrypted, and stored off-host. Each day is an independent restore point (7 daily, 4 weekly, 3 monthly). Any restore point can be recovered — down to a single chat.
                </p>
              ) : (
                <p style={{ margin: 0, fontSize: 11, lineHeight: 1.6, color: 'var(--ink-black)', opacity: 0.7, maxWidth: 600 }}>
                  Daily backups of your chats and workspace are included on paid plans. Your first restore point appears within a day of upgrading.
                </p>
              )}
            </div>
          </div>
          
          {!backupsEnabled && (
            <Link 
              href={`/dashboard/billing?intent=backups&instanceId=${encodeURIComponent(instanceId)}`}
              className={styles.upgradeLink}
              style={{
                display: 'inline-flex', alignItems: 'center',
                background: 'var(--ink-black)', color: 'var(--bg-surface)', border: 'none',
                padding: '10px 20px', fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase', letterSpacing: '0.05em', textDecoration: 'none', whiteSpace: 'nowrap'
              }}
            >
              Upgrade for Backups
            </Link>
          )}
        </div>
      </div>

      {/* Snapshot Management */}
      <div className="interrogation-box" style={{ padding: '1.5rem' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}>
             <h4 className="mono" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', margin: 0, fontWeight: 700 }}>Restore Points</h4>
             <p style={{ fontSize: 11, opacity: 0.5, margin: '4px 0 0', fontFamily: 'var(--font-mono)' }}>Encrypted daily snapshots of your chats &amp; workspace. Requesting a restore never overwrites your live agent.</p>
          </div>
          <button
             type="button"
             onClick={loadBackups}
             disabled={fetchingBackups}
             className={styles.touchTarget}
             style={{
               background: 'transparent', border: '1px solid var(--ink-black)', color: 'var(--ink-black)',
               padding: '8px 16px', fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', cursor: fetchingBackups ? 'not-allowed' : 'pointer',
               textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6, opacity: fetchingBackups ? 0.5 : 1
             }}
          >
             {fetchingBackups ? <Loader2 size={12} className="animate-spin" /> : <HardDrive size={12} />}
             {fetchingBackups ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {backupError && (
          <div style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)', padding: '10px', fontSize: 11, color: '#ef4444', marginBottom: 16 }}>
            {backupError}
          </div>
        )}

        {backups.length > 0 ? (
          <div style={{ border: '1px solid var(--etched-border)', background: 'rgba(0,0,0,0.01)' }}>
            {backups.map(b => (
               <div key={b.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--etched-border)' }}>
                 <div style={{ flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere' }}>
                   <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700 }}>{b.description || 'Data restore point'}</div>
                   <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                     {b.created ? new Date(b.created).toLocaleString() : 'unknown time'} • chats + workspace files • restore point {b.id}
                   </div>
                   {b.sha256 && (
                     <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                       sha256 {b.sha256.slice(0, 12)}…{b.sha256.slice(-8)}
                     </div>
                   )}
                 </div>
                 
                 {restoreConfirmBackupId === b.id ? (
                    <div className={styles.restoreConfirm} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                       <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#ef4444' }}>
                          <AlertTriangle size={14} />
                          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>Type RESTORE</span>
                       </div>
                       <input 
                         aria-label="Type RESTORE to confirm"
                         value={restoreInputText}
                         onChange={e => setRestoreInputText(e.target.value)}
                         placeholder="RESTORE"
                         autoCapitalize="characters"
                         autoCorrect="off"
                         spellCheck={false}
                         autoComplete="off"
                         style={{ flex: '1 1 120px', minWidth: 0, fontSize: 11, padding: '6px 8px', border: '1px solid var(--etched-border)', fontFamily: 'var(--font-mono)' }}
                       />
                       <div style={{ display: 'flex', gap: 10 }}>
                         <button 
                           type="button"
                           onClick={() => setRestoreConfirmBackupId(null)} 
                           className={styles.touchTarget}
                           style={{ background: 'transparent', border: '1px solid var(--etched-border)', color: 'var(--ink-black)', fontSize: 11, padding: '6px 12px', cursor: 'pointer' }}
                         >
                           Cancel
                         </button>
                         <button 
                           type="button"
                           onClick={() => restoreBackup(b.id)} 
                           disabled={restoring || !isRestoreConfirmation(restoreInputText)}
                           className={styles.touchTarget}
                           style={{ background: '#ef4444', color: '#fff', border: 'none', fontSize: 11, padding: '6px 12px', cursor: (restoring || !isRestoreConfirmation(restoreInputText)) ? 'not-allowed' : 'pointer', opacity: (restoring || !isRestoreConfirmation(restoreInputText)) ? 0.5 : 1, fontWeight: 700, textTransform: 'uppercase' }}
                         >
                           Confirm
                         </button>
                       </div>
                    </div>
                 ) : (
                   <button
                     type="button"
                     onClick={() => { setRestoreConfirmBackupId(b.id); setRestoreInputText(''); }}
                     className={styles.touchTarget}
                     style={{ background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', fontSize: 11, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', padding: '6px 16px', cursor: 'pointer', fontWeight: 700 }}
                   >
                     Request Restore
                   </button>
                 )}
               </div>
            ))}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '3rem 1rem', background: 'rgba(0,0,0,0.01)', border: '1px solid var(--etched-border)' }}>
             <HardDrive size={24} style={{ opacity: 0.2, marginBottom: 12 }} />
             <p style={{ fontSize: 12, margin: 0, color: 'var(--text-muted)' }}>
               {fetchingBackups ? 'Loading restore points...' : 'No restore points yet — your first daily backup will appear here automatically.'}
             </p>
          </div>
        )}
      </div>

    </div>
  );
}
