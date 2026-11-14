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
    <div style={{ margin: '1rem 0', overflow: 'hidden', border: '1px solid var(--hg-stroke)', borderRadius: 10, background: 'var(--hg-surface-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--hg-fill-2)', borderBottom: '1px solid var(--hg-stroke-subtle)' }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, lineHeight: '16px', color: 'var(--hg-text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {parsedLang}
        </span>
        {/* 36px (44px on touch) target; the negative margin keeps the 16px
            header row the chat and blog layouts were designed around. Pixel
            values, because the 14px root makes rem spacing 3.5px a step. */}
        <button
          type="button"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={() => { void handleCopy(); }}
          className={`-my-[10px] -mr-[12px] min-h-[36px] pointer-coarse:-my-[14px] pointer-coarse:min-h-[44px] ${copied ? 'text-[var(--hg-ok)]' : 'text-[var(--hg-text-3)] [@media(hover:hover)]:hover:text-[var(--hg-text)]'}`}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', minWidth: 64, padding: '0 10px', background: 'none', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-sans)', fontWeight: 600, textTransform: 'uppercase' }}
        >
          {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
        </button>
      </div>
      <div style={{ overflowX: 'auto', background: 'var(--hg-surface-2)' }}>
        <SyntaxHighlighter
          language={prismLanguage(parsedLang)}
          style={vscDarkPlus}
          customStyle={{ margin: 0, padding: '16px', background: 'var(--hg-surface-2)', fontSize: '13px', lineHeight: 1.5, fontFamily: 'var(--font-mono), monospace' }}
          PreTag="div"
        >
          {String(value).replace(/\n$/, '')}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
