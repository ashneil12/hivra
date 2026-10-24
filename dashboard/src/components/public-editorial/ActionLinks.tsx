import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { isStaticDocument } from "@/components/public-site/PublicLink";
import styles from "./action-links.module.css";

export interface ActionLink {
  label: string;
  href: string;
  /** "primary" is the one button of the row; "secondary" is an underlined text link. */
  kind: "primary" | "secondary";
  /** Open in a new tab. Left out: true for an http(s) address off hivra.cloud, false for everything else. */
  external?: boolean;
  /** Written to `data-cta`, for the analytics hooks that read it. */
  cta?: string;
}

export interface ActionLinksProps {
  items: readonly ActionLink[];
  /** Names the row for assistive technology when it is more than a lone button. */
  label?: string;
}

/** True for an http(s) address that is not on hivra.cloud, or a protocol-relative one. */
export function isExternalHref(href: string): boolean {
  try {
    const url = new URL(href, "https://hivra.cloud");
    return /^https?:$/.test(url.protocol) && url.origin !== "https://hivra.cloud";
  } catch {
    return false;
  }
}

function renderLabel(label: string, icon: ReactNode) {
  return (
    <>
      <span>{label}</span>
      {icon}
    </>
  );
}

/**
 * The closing row of links under a section or page: one primary button and any
 * number of secondary text links. Internal routes go through next/link; external
 * addresses open in a new tab; static documents under /docs/, in-page anchors,
 * mailto and tel links are plain anchors. Renders nothing for an empty list, so a
 * page can filter out links it must not show (token links, for one).
 */
export function ActionLinks({ items, label }: ActionLinksProps) {
  if (!items.length) return null;

  return (
    <div className={styles.row} data-action-links="" {...(label ? { role: "group", "aria-label": label } : {})}>
      {items.map((item) => {
        const external = item.external ?? isExternalHref(item.href);
        const primary = item.kind === "primary";
        const className = primary ? styles.primary : styles.secondary;
        const icon = external || primary ? <ArrowUpRight size={primary ? 20 : 16} aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />;
        const common = {
          className,
          "data-kind": item.kind,
          ...(item.cta ? { "data-cta": item.cta } : {}),
        };
        const key = `${item.href}-${item.label}`;
        const content = renderLabel(item.label, icon);

        if (external) {
          return (
            <a key={key} href={item.href} target="_blank" rel="noopener noreferrer" {...common}>
              {content}
            </a>
          );
        }
        if (item.href.startsWith("/") && !item.href.startsWith("//") && !isStaticDocument(item.href)) {
          return (
            <Link key={key} href={item.href} {...common}>
              {content}
            </Link>
          );
        }
        return (
          <a key={key} href={item.href} {...common}>
            {content}
          </a>
        );
      })}
    </div>
  );
}

export default ActionLinks;
