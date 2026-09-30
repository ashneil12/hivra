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
    // Phones drop the page margins and the display heading so the explorer gets
    // the height; desktop keeps the framed layout.
    <div
      className="mx-auto mt-8 mb-32 flex h-[calc(var(--workspace-viewport-height,100dvh)-8rem)] max-w-[1320px] flex-col px-[clamp(20px,5vw,40px)] max-md:m-0 max-md:h-full max-md:px-3 max-md:pb-3"
      style={{ paddingTop: 'calc(var(--dashboard-page-safe-top, env(safe-area-inset-top, 0px)) + 1rem)' }}
    >
      <button
        onClick={() => router.push(`/dashboard/instances/${id}`)}
        className="mb-8 max-md:mb-2"
        style={{ flexShrink: 0, alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, minHeight: 44, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono), monospace', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', padding: '0 8px', marginLeft: -8 }}
      >
        <ArrowLeft size={14} /> Back to chat
      </button>

      <div className="mb-10 shrink-0 max-md:hidden">
        <h1 className="serif" style={{ fontSize: 'clamp(2.5rem, 8vw, 3.5rem)', fontWeight: 400, lineHeight: 1, margin: 0, color: 'var(--ink-black)', wordBreak: 'break-word' }}>File Explorer.</h1>
        <p className="mono" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.5, marginTop: '1rem', color: 'var(--ink-black)' }}>
          Remote Server File System Integration
        </p>
      </div>
      <h1 className="mono mb-2 shrink-0 md:hidden" style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.14em', margin: '0 0 8px', color: 'var(--ink-black)' }}>
        File explorer
      </h1>

      <div className="max-md:!p-0" style={{ flex: 1, minHeight: 0, borderRadius: 0, border: '1px solid #1e1e30', overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.75)', padding: '12px', background: 'var(--bg-primary)' }}>
        <FileExplorer instanceId={id} defaultPath={resolveExplorerHome(id)} />
      </div>
    </div>
  );
}
