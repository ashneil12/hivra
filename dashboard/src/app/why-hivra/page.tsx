import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";
import ReactMarkdown from "react-markdown";
import PublicSite from "@/components/public-site/PublicSite";
import { EditorialMarkdownLink, Breadcrumbs } from "@/components/public-editorial/Editorial";
import { buildWebsiteMetadata } from "@/lib/metadata";
import styles from "@/components/public-editorial/secondary-site.module.css";
import founder from "./founder-page.module.css";
const TITLE = "Why I'm building Hivra";
const DESCRIPTION = "Ash on AI, accountability, Christian faith, and why the limits should live outside the model.";
// buildWebsiteMetadata sets only canonical, Open Graph and Twitter fields.
export const metadata: Metadata = { title: TITLE, description: DESCRIPTION, ...buildWebsiteMetadata({ path: "/why-hivra", title: TITLE, description: DESCRIPTION }) };
export default function WhyHivraPage() {
  const source = readFileSync(path.join(process.cwd(), "public/THOUGHTS.md"), "utf8");
  const introduction = "The platform is Apache 2.0. Self-hosting needs no token and no account, and card payment works everywhere. None of what follows is a condition of using Hivra.";
  const withIntroduction = source.replace("\n\n", `\n\n${introduction}\n\n`);
  return <PublicSite><main id="main-content" className={styles.main}>
    <Breadcrumbs items={[{label: "Why I'm building Hivra"}]} />
    <article className={`${styles.articleBody} ${founder.article}`}><ReactMarkdown components={{a: EditorialMarkdownLink}}>{withIntroduction}</ReactMarkdown>
    </article>
  </main></PublicSite>;
}
