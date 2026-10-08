'use client';

import { useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
// The light async build loads the highlighter, then each language's grammar,
// the first time a block needs them, instead of every grammar Prism knows on
// every page that can show code. A block reads as plain code until then.
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-async-light';
import vscDarkPlus from 'react-syntax-highlighter/dist/cjs/styles/prism/vsc-dark-plus';
import { copyTextToClipboard } from '@/lib/client/clipboard';
import { prismLanguage } from './prism-languages';

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
        <span style={{ fontFamily: 'var(--font-mono), monospace', fontSize: 11, lineHeight: '16px', color: '#a3a3a3', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {parsedLang}
        </span>
        {/* 36px (44px on touch) target; the negative margin keeps the 16px
            header row the chat and blog layouts were designed around. Pixel
            values, because the 14px root makes rem spacing 3.5px a step. */}
        <button
          type="button"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={() => { void handleCopy(); }}
          className={`-my-[10px] -mr-[12px] min-h-[36px] pointer-coarse:-my-[14px] pointer-coarse:min-h-[44px] ${copied ? 'text-[#22c55e]' : 'text-[#a3a3a3] [@media(hover:hover)]:hover:text-[var(--bg-surface)]'}`}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', minWidth: 64, padding: '0 10px', background: 'none', border: 'none', borderRadius: 0, cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-mono), monospace', textTransform: 'uppercase' }}
        >
          {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
        </button>
      </div>
      <div style={{ overflowX: 'auto', background: '#0d0d0d' }}>
        <SyntaxHighlighter
          language={prismLanguage(parsedLang)}
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
