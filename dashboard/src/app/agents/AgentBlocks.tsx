import { CheckCircle } from "lucide-react";
import styles from "../../components/public-editorial/secondary-site.module.css";
import agentStyles from "./agents.module.css";
import { Inline } from "./AgentProse";
import { slugifyHeading } from "./content/markup";
import type { AgentBlock, AgentSection } from "./content/types";

/** Bold-led paragraphs as ruled rows: the lead line, then its text. Shared by the directory page. */
export function TermRows({ items }: { items: { term: string; text: string }[] }) {
  return (
    <dl className={agentStyles.terms}>
      {items.map(({ term, text }) => (
        <div className={agentStyles.term} key={term}>
          <dt>
            <Inline text={term} />
          </dt>
          <dd>
            <Inline text={text} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function BlockView({ block }: { block: AgentBlock }) {
  switch (block.kind) {
    case "prose":
      return (
        <>
          {block.paragraphs.map((paragraph) => (
            <p key={paragraph}>
              <Inline text={paragraph} />
            </p>
          ))}
        </>
      );
    case "terms":
      return <TermRows items={block.items} />;
    case "list":
      return (
        <div className={`${styles.included} ${agentStyles.listPanel}`}>
          <ul>
            {block.items.map((item) => (
              <li key={item}>
                <CheckCircle size={16} aria-hidden="true" />
                <span>
                  <Inline text={item} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "steps":
      return (
        <ol className={agentStyles.steps}>
          {block.steps.map((step, index) => (
            <li key={step.title}>
              <span className={agentStyles.stepNumber} aria-hidden="true">
                {index + 1}.
              </span>
              <div>
                <h3>{step.title}</h3>
                {step.paragraphs.map((paragraph) => (
                  <p key={paragraph}>
                    <Inline text={paragraph} />
                  </p>
                ))}
              </div>
            </li>
          ))}
        </ol>
      );
  }
}

/** One H2 section of an agent page. Its id is the slug of the heading, which the contents list links to. */
export function AgentSectionView({ section }: { section: AgentSection }) {
  return (
    <section id={slugifyHeading(section.heading)}>
      <h2>{section.heading}</h2>
      {section.blocks.map((block, index) => (
        <BlockView key={`${block.kind}-${index}`} block={block} />
      ))}
    </section>
  );
}
