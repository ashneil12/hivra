import ComparisonTable from "@/components/public-editorial/ComparisonTable";
import type { FeatureBlock } from "../_content/types";
import { renderInline } from "./Inline";
import styles from "../features.module.css";

function Block({ block }: { block: FeatureBlock }) {
  switch (block.kind) {
    case "p":
      return <p>{renderInline(block.text)}</p>;
    case "note":
      return <p className={styles.note}>{renderInline(block.text)}</p>;
    case "scenario":
      return <p className={styles.scenario}>{renderInline(block.text)}</p>;
    case "terms":
      return (
        <div className={styles.terms}>
          {block.items.map(({ term, text }) => (
            <p key={term} className={styles.term}>
              <strong>{term}</strong> <span>{renderInline(text)}</span>
            </p>
          ))}
        </div>
      );
    case "steps":
      return (
        <ol className={styles.steps}>
          {block.items.map((item) => (
            <li key={item}>
              <span>{renderInline(item)}</span>
            </li>
          ))}
        </ol>
      );
    case "workflows":
      return (
        <div className={styles.workflows}>
          {block.items.map(({ title, text }) => (
            <div key={title} className={styles.workflow}>
              <h3>{title}</h3>
              <p>{renderInline(text)}</p>
            </div>
          ))}
        </div>
      );
    case "table":
      return (
        <ComparisonTable
          caption={block.caption}
          rowHeading={block.rowHeading}
          columns={block.columns}
          rows={block.rows.map((row) => ({ label: row.label, cells: row.cells.map((cell) => renderInline(cell)) }))}
        />
      );
  }
}

/** The blocks of one section, in order. */
export function FeatureBlocks({ blocks }: { blocks: readonly FeatureBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </>
  );
}

export default FeatureBlocks;
