"use client";

// Adapted from MonoCode (MIT License, Copyright (c) 2026 Nick); see THIRD_PARTY_LICENSES/monocode.txt.
//
// The reply's Markdown, drawn the way MonoCode's AgentMarkdown draws it:
// quiet headings, tight lists, an inline-code chip, soft tables, and a word
// fade-in while the reply streams. MonoCode renders through Streamdown; Hivra
// keeps react-markdown + remark-gfm and brings the same fade in as a rehype
// plugin.

import { Children, isValidElement, memo, useMemo, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AGENT_MARKDOWN_COMPONENTS } from "@/components/markdown/agent-markdown-image";
import { CodeBlock } from "./CodeBlock";
import { rehypeWordFade, useCadenceFade, useStreamedText, useWordFading } from "./wordFade";
import styles from "./chat.module.css";

const CHAT_REMARK_PLUGINS = [remarkGfm];
const FADING_REHYPE_PLUGINS = [rehypeWordFade];
const NO_REHYPE_PLUGINS: never[] = [];

// Fenced code (any <pre>, including one-line blocks with no language) is the
// syntax-highlighted CodeBlock, which scrolls inside its own box. Inline code
// is a small chip that wraps anywhere.
export const CHAT_MARKDOWN_COMPONENTS = {
  ...AGENT_MARKDOWN_COMPONENTS,
  pre(props: { children?: React.ReactNode }) {
    const child = Children.toArray(props.children)[0];
    if (isValidElement<{ className?: string; children?: React.ReactNode }>(child)) {
      const text = String(child.props.children ?? "").replace(/\n$/, "");
      const lang = /language-([\w-]+)/.exec(child.props.className || "")?.[1];
      return <CodeBlock language={lang || "text"} value={text} />;
    }
    return <CodeBlock language="text" value={String(props.children ?? "")} />;
  },
  code(props: { children?: React.ReactNode }) {
    return <code className={styles.inlineCode}>{props.children}</code>;
  },
  table({ children }: { children?: React.ReactNode }) {
    return <div className={`chat-md-table-wrapper ${styles.tableWrap}`}><table className={styles.table}>{children}</table></div>;
  },
  // Replies open links in a new tab so tapping one never navigates the
  // dashboard (or the installed PWA) away and aborts the running turn.
  a({ href, children }: { href?: string; children?: React.ReactNode }) {
    return <a href={href} target="_blank" rel="noopener noreferrer" className={styles.link}>{children}</a>;
  },
};

/** Markdown parse is the expensive part of a message row, so it is memoized on
 *  the rendered text: a poll tick or keystroke doesn't re-parse history. */
export const AssistantMarkdown = memo(function AssistantMarkdown({ text, streaming }: { text: string; streaming?: boolean }) {
  // Text that is already there when the row opens shows whole; a reply that
  // arrives while this row is open is let out a word at a time.
  const shown = useStreamedText(text, !!streaming);
  const cadence = useCadenceFade(shown.text);
  const fading = useWordFading(!!streaming || shown.revealing, cadence.durationMs);
  const fadeStyle = useMemo(
    () => ({ "--word-fade-ms": `${cadence.durationMs}ms`, "--word-fade-ease": cadence.easing }) as CSSProperties,
    [cadence.durationMs, cadence.easing],
  );
  return (
    <div className={`hivra-md ${styles.markdown} ${fading ? `${styles.wordFading} word-fading` : ""}`} style={fadeStyle}>
      <ReactMarkdown remarkPlugins={CHAT_REMARK_PLUGINS} rehypePlugins={fading ? FADING_REHYPE_PLUGINS : NO_REHYPE_PLUGINS} components={CHAT_MARKDOWN_COMPONENTS}>
        {shown.text}
      </ReactMarkdown>
    </div>
  );
});
