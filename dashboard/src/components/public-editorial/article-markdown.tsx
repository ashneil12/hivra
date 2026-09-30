import type { Components } from "react-markdown";

import { CodeBlock } from "@/components/markdown/CodeBlock";
import { EditorialMarkdownLink } from "@/components/public-editorial/Editorial";
import styles from "./secondary-site.module.css";

// One set of Markdown renderers for blog articles: the short answer and every section.
export const articleMarkdownComponents: Components = {
  a: ({ node, ...props }) => { void node; return <EditorialMarkdownLink {...props} />; },
  code({ children, className, node, ...rest }) {
    void node;
    const match = /language-(\w+)/.exec(className || "");
    return match ? <div className={styles.code}><CodeBlock language={match[1]} value={String(children).replace(/\n$/, "")} /></div> : <code {...rest}>{children}</code>;
  },
  pre: ({ children }) => <div className={styles.code}>{children}</div>,
  table: ({ children }) => <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Scrollable table"><table>{children}</table></div>,
  // A paragraph that holds only an image becomes a figure (a figure cannot sit inside a paragraph); the image title is the caption.
  p: ({ node, children }) => {
    const only = node?.children?.length === 1 && node.children[0].type === "element" && node.children[0].tagName === "img";
    return only ? <>{children}</> : <p>{children}</p>;
  },
  img: ({ node, src, alt, title }) => {
    void node;
    if (typeof src !== "string") return null;
    return (
      <figure>
        {/* eslint-disable-next-line @next/next/no-img-element -- article figures are static assets with their own size */}
        <img src={src} alt={alt ?? ""} loading="lazy" decoding="async" />
        {title ? <figcaption>{title}</figcaption> : null}
      </figure>
    );
  },
};
