'use client';

import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/cjs/styles/prism';
import { copyTextToClipboard } from '@/lib/client/clipboard';

interface ChatCodeBlockProps {
  language: string;
  value: string;
}

export function CodeBlock({ language, value }: ChatCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const copiedResetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current !== null) {
        window.clearTimeout(copiedResetTimerRef.current);
        copiedResetTimerRef.current = null;
      }
    };
  }, []);

  const handleCopy = async () => {
    const didCopy = await copyTextToClipboard(value);
    if (!didCopy) {
      return;
    }

    setCopied(true);
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current);
    }
    copiedResetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedResetTimerRef.current = null;
    }, 2000);
  };

  const parsedLang = language ? language.toLowerCase() : 'text';

  return (
    <div style={{ margin: '1rem 0', overflow: 'hidden', border: '1px solid var(--ink-black)', borderRadius: 0, background: '#0d0d0d' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: "var(--ink-black)", borderBottom: '1px solid #2a2a2a' }}>
        <span style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 10, color: '#a3a3a3', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {parsedLang}
        </span>
        <button
          onClick={() => { void handleCopy(); }}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: copied ? '#22c55e' : '#a3a3a3', cursor: 'pointer', fontSize: 10, fontFamily: 'var(--font-mono), monospace', textTransform: 'uppercase' }}
          onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = 'var(--bg-surface)'; }}
          onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = '#a3a3a3'; }}
        >
          {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
        </button>
      </div>
      <div style={{ overflowX: 'auto', background: '#0d0d0d' }}>
        <SyntaxHighlighter
          language={parsedLang}
          style={vscDarkPlus}
          customStyle={{ margin: 0, padding: '16px', background: '#0d0d0d', fontSize: '13px', lineHeight: 1.5, fontFamily: 'var(--font-mono), monospace' }}
          PreTag="div"
        >
          {String(value).replace(/\n$/, '')}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
