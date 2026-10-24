import type { CSSProperties, ReactNode } from "react";
import styles from "./comparison-table.module.css";

/** A data column: a plain label (it is also each cell's `data-label`) and an optional small line under it. */
export interface ComparisonColumn {
  label: string;
  note?: ReactNode;
}

export interface ComparisonRow {
  /** The row heading: the thing being compared. */
  label: ReactNode;
  /** One entry per column, in column order. A missing entry renders an empty cell; extras are not rendered. */
  cells: readonly ReactNode[];
}

export interface ComparisonTableProps {
  /** Names the table for assistive technology. Not shown, so the page text gains no extra line. */
  caption: string;
  /** The data columns. The row heading column is not listed here. */
  columns: readonly (string | ComparisonColumn)[];
  rows: readonly ComparisonRow[];
  /** Index (in `columns`) of the column that is Hivra's own, drawn with an accent edge. */
  highlight?: number;
  /** "editorial" follows the secondary pages (light or dark by theme); "home" follows the dark landing page tokens. */
  variant?: "editorial" | "home";
  /** Heading of the row heading column. Omitted: an empty corner cell. */
  rowHeading?: ReactNode;
}

/**
 * A comparison as a real table: `th scope="col"` for each column, `th scope="row"`
 * for each row, and a plain `data-label` on every data cell.
 *
 * Wide screens get the table, scrolling inside its own frame (keyboard reachable)
 * only when the columns need more room than the page has. At 700px and below each
 * row becomes a short block, its heading first and then one label and value pair
 * for every column, so nothing scrolls sideways and no text gets small. The ARIA
 * roles are written out because some browsers drop table semantics once a table is
 * laid out as blocks.
 */
export function ComparisonTable({ caption, columns, rows, highlight, variant = "editorial", rowHeading }: ComparisonTableProps) {
  const cols = columns.map((column): ComparisonColumn => (typeof column === "string" ? { label: column } : column));
  const flag = (index: number) => (index === highlight ? { "data-highlight": "true" } : {});

  return (
    <div
      className={styles.wrap}
      data-comparison-table=""
      data-variant={variant}
      role="region"
      aria-label={caption}
      tabIndex={0}
      style={{ "--ct-cols": cols.length } as CSSProperties}
    >
      <table className={styles.table} role="table" aria-label={caption}>
        <thead role="rowgroup">
          <tr role="row">
            {rowHeading ? (
              <th scope="col" role="columnheader" className={styles.corner}>{rowHeading}</th>
            ) : (
              <td role="cell" className={styles.corner} />
            )}
            {cols.map((column, index) => (
              <th key={`${column.label}-${index}`} scope="col" role="columnheader" {...flag(index)}>
                {column.label}
                {column.note ? <small className={styles.note}>{column.note}</small> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} role="row">
              <th scope="row" role="rowheader">{row.label}</th>
              {cols.map((column, index) => (
                <td key={`${column.label}-${index}`} role="cell" data-label={column.label} {...flag(index)}>
                  <div className={styles.value}>{row.cells[index] ?? null}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default ComparisonTable;
