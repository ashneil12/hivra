import CiteBlock from "@/components/tools/CiteBlock";
import Prose from "@/components/tools/InlineCode";
import { buildCite } from "@/lib/tools/cite";
import { SITE_URL } from "@/lib/seo-urls";
import { toolPath, type ToolEntry } from "@/lib/tools/tool-catalog";
import styles from "./tools.module.css";
import { monthYear } from "@/lib/tools/month-year";

// Server-rendered method section under a tool: what the answer rests on, every
// source linked, the date the facts were last checked, worked examples with the
// exact output, and a "cite this" block. It lives in the page's HTML, not in
// the client component, so crawlers that do not run scripts still read it.
// Tools without a `method` in the catalog render nothing here.
export default function ToolMethodSection({ entry }: { entry: ToolEntry }) {
  const { method, examples } = entry;
  if (!method) return null;

  const cite = buildCite({ name: entry.name, url: `${SITE_URL}${toolPath(entry.slug)}`, lastVerified: method.lastVerified });

  return (
    <section className={styles.method} aria-labelledby="method-heading" id="method">
      <h2 id="method-heading">{method.heading}</h2>
      {method.paragraphs.map((paragraph) => (
        <p key={paragraph.text}>
          <Prose text={paragraph.text} />
          {paragraph.sources && paragraph.sources.length > 0 && (
            <span className={styles.sources}>
              {" Sources: "}
              {paragraph.sources.map((source, index) => (
                <span key={source.url}>
                  {index > 0 && ", "}
                  <a href={source.url} rel="noopener">
                    {source.label}
                  </a>
                </span>
              ))}
              .
            </span>
          )}
        </p>
      ))}
      <p className={styles.verified}>{`Last checked ${monthYear(method.lastVerified)}.`}</p>

      {examples && examples.length > 0 && (
        <>
          <h2>Worked examples</h2>
          <div className={styles.examples}>
            {examples.map((example) => (
              <article key={example.title} className={styles.example}>
                <h3>{example.title}</h3>
                <p className={styles.exampleInputs}>{`Inputs: ${example.inputs}.`}</p>
                <pre className={styles.pre}>{example.command}</pre>
                <p>
                  <Prose text={example.result} />
                </p>
              </article>
            ))}
          </div>
        </>
      )}

      <CiteBlock sentence={cite.sentence} html={cite.html} />
    </section>
  );
}
