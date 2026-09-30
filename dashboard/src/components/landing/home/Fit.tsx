import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { FIT } from "./content";
import styles from "./home.module.css";

/**
 * Where Hivra fits: the three places an agent can live today, and the one you
 * can check. A real table, server rendered; the reveal is CSS scroll-driven, so
 * it needs no script and everything is readable before and without it.
 */
export default function Fit() {
  const last = FIT.columns.length - 1;
  return (
    <section id="fit" className={styles.fit} aria-labelledby="fit-heading">
      <header className={styles.sectionHead}>
        <span className={styles.eyebrow}>{FIT.eyebrow}</span>
        <h2 id="fit-heading" className={styles.sectionTitle}>
          {FIT.title} <em>{FIT.titleTail}</em>
        </h2>
        <p className={styles.bodyText}>{FIT.lead}</p>
      </header>
      <div className={styles.fitTable} role="region" aria-label="Where each option stands" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <td />
              {FIT.columns.map((column, index) => (
                <th key={column} scope="col" className={index === last ? styles.fitHivra : undefined}>
                  {column}
                  <small>{FIT.examples[index]}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FIT.rows.map((row, rowIndex) => (
              <tr key={row.label} style={{ "--row": rowIndex } as CSSProperties}>
                <th scope="row">{row.label}</th>
                {row.cells.map((cell, index) => (
                  <td key={FIT.columns[index]} className={index === last ? styles.fitHivra : undefined}>
                    {cell === "Yes" || cell === "No" ? (
                      <>
                        <i className={cell === "Yes" ? styles.markYes : styles.markNo} aria-hidden="true" />
                        <span className={styles.srOnly}>{cell}</span>
                      </>
                    ) : (
                      <span className={styles.fitWord}>{cell}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.fitFoot}>
        <p className={styles.fitVerdict}>{FIT.verdict}</p>
        <a href={FIT.moreHref} className={styles.textCta} data-cta="fit-compare">
          {FIT.more}
          <ArrowRight size={16} aria-hidden="true" />
        </a>
      </div>
      <p className={styles.fitNote}>{FIT.note}</p>
    </section>
  );
}
