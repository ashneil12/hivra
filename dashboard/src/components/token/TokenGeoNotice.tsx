import type { CSSProperties } from "react";

const noticeStyle: CSSProperties = {
  margin: "0 0 1.5rem",
  padding: "0.85rem 1rem",
  border: "1px solid var(--etched-border, var(--public-line, currentColor))",
  fontSize: 14,
  lineHeight: 1.6,
};

/**
 * The token geo-policy notice ("Token features aren't available to people in
 * …"). Rendered only for a viewer the server has blocked; the text comes from
 * lib/compliance/token-geo-policy.ts via the server's decision.
 */
export function TokenGeoNotice({ notice, style }: { notice: string; style?: CSSProperties }) {
  return (
    <p role="note" data-testid="token-geo-notice" style={{ ...noticeStyle, ...style }}>
      {notice}
    </p>
  );
}
