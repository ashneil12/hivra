import { Fragment } from "react";
import Link from "next/link";
import { isExternalHref } from "@/components/public-editorial/ActionLinks";
import { parseInline } from "@/lib/inline-copy";
import compare from "./compare.module.css";

/**
 * Renders a comparison copy string: plain text, **bold**, `code` and [label](href).
 * Internal routes go through next/link; an address off hivra.cloud opens in a new tab.
 */
export default function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((token, index) => {
        switch (token.kind) {
          case "strong":
            return <strong key={index}>{token.text}</strong>;
          case "code":
            return (
              <code key={index} className={compare.code}>
                {token.text}
              </code>
            );
          case "link":
            return isExternalHref(token.href) ? (
              <a key={index} href={token.href} target="_blank" rel="noopener noreferrer">
                {token.label}
              </a>
            ) : (
              <Link key={index} href={token.href}>
                {token.label}
              </Link>
            );
          default:
            return <Fragment key={index}>{token.text}</Fragment>;
        }
      })}
    </>
  );
}
