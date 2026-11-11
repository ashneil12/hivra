"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// A fenced block as MonoCode draws it: a quiet rounded surface, a header row
// with the language and a copy icon, then numbered lines. MonoCode highlights
// with Shiki; Hivra keeps react-syntax-highlighter, loaded per language the
// first time a block needs it (a block reads as plain code until then).

import { useEffect, useRef, useState } from "react";
import { Check, Copy, FileCode } from "lucide-react";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-async-light";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import { prismLanguage } from "@/components/markdown/prism-languages";
import { chatSyntaxTheme } from "./syntaxTheme";
import styles from "./chat.module.css";

interface ChatCodeBlockProps {
  language: string;
  value: string;
}

export function CodeBlock({ language, value }: ChatCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const handleCopy = async () => {
    if (!(await copyTextToClipboard(value))) return;
    setCopied(true);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      setCopied(false);
      resetTimer.current = null;
    }, 2000);
  };

  const lang = language ? language.toLowerCase() : "text";
  const source = String(value).replace(/\n+$/, "");

  return (
    <div className={styles.code} dir="ltr">
      <div className={styles.codeHeader}>
        <span className={styles.codeLang}>
          <FileCode size={13} aria-hidden />
          {lang === "text" ? "text" : lang}
        </span>
        <button
          type="button"
          className={`${styles.codeCopy} ${copied ? styles.codeCopied : ""}`}
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          onClick={() => { void handleCopy(); }}
        >
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        </button>
      </div>
      <div className={styles.codeBody}>
        <SyntaxHighlighter
          language={prismLanguage(lang)}
          style={chatSyntaxTheme}
          showLineNumbers
          lineNumberStyle={{ minWidth: 34, paddingRight: 10, textAlign: "right", color: "var(--hg-text-3)", fontSize: 10, opacity: 0.7, userSelect: "none" }}
          customStyle={{ margin: 0, padding: "10px 12px 10px 0", background: "transparent", fontSize: 12, lineHeight: 1.6, fontFamily: "var(--font-mono), monospace" }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono), monospace" } }}
          PreTag="div"
        >
          {source}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
