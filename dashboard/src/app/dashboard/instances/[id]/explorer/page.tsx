'use client';

import { use } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { FileExplorer } from '@/components/explorer/FileExplorer';
import { resolveExplorerHome } from '@/lib/explorer-home';

export default function DedicatedFileExplorerPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const { id } = use(params);

  return (
    <div style={{ maxWidth: 1320, margin: '2rem auto 8rem', padding: '0 clamp(20px, 5vw, 40px)', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)', height: 'calc(100vh - 8rem)', display: 'flex', flexDirection: 'column' }}>
      <button 
        onClick={() => router.push(`/dashboard/instances/${id}`)}
        style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono), monospace', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', padding: 0, marginBottom: '2rem' }}
      >
        <ArrowLeft size={14} /> Back to Communications
      </button>
      
      <div style={{ marginBottom: '2.5rem', flexShrink: 0 }}>
        <h1 className="serif" style={{ fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', fontWeight: 400, lineHeight: 1, margin: 0, color: 'var(--ink-black)', wordBreak: 'break-word' }}>File Explorer.</h1>
        <p className="mono" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.5, marginTop: '1rem', color: 'var(--ink-black)' }}>
          Remote Server File System Integration
        </p>
      </div>

      <div style={{ flex: 1, borderRadius: 0, border: '1px solid #1e1e30', overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.75)', padding: '12px', background: 'var(--bg-primary)' }}>
        <FileExplorer instanceId={id} defaultPath={resolveExplorerHome(id)} />
      </div>
    </div>
  );
}
