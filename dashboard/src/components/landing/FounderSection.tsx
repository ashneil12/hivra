import { ArrowUpRight } from "lucide-react";
import styles from "./founder-tokenomics.module.css";

// Exact paragraphs from the user-approved LITEPAPER.md. Keep quotation and
// personal perspective distinct from the site's technical product claims.
export const FOUNDER_EXCERPTS = [
  "Passing safety training doesn't prove a model has no hidden behaviour. That's why I want limits outside it.",
  "I'm also a Christian, and I genuinely think AI is leading somewhere beyond what the news says, or what people really want to believe.",
  "I think this ends up somewhere scripture already described. A world where taking part in the economy gets conditioned on compliance, where the ability to buy and sell runs through something that can exclude you, and where AI is what finally makes that possible at scale. I think it arrives looking reasonable, because that's how it would have to arrive.",
  "You don't have to agree with any of that. But it's why I care about where the limits live, and it's why I don't think a model producing moral language is the same as a model being answerable for anything.",
  "Someone has to be answerable. Someone decides what the agent reaches, where its authority stops, and how to pull the plug.",
  "Hivra is the practical part of that. Give the agent a computer. Make it good enough that people actually use it. Keep control of everything around it.",
] as const;

export default function FounderSection() {
  return <section id="founder" className={styles.founder} aria-labelledby="founder-heading">
    <div className={styles.founderTop}><span>A personal note from the founder</span><span>Ash / Hivra</span></div>
    <div className={styles.founderGrid}>
      <header className={styles.founderHeading}>
        <span className={styles.rule} aria-hidden="true" />
        <h2 id="founder-heading">Why I&apos;m<br />{" "}building it.</h2>
        <p>AI and power. Christian faith.<br />End-time prophecy. Evangelism.</p>
        <span className={styles.perspective}>Ash&apos;s personal perspective</span>
      </header>
      <div className={styles.founderCopy}>
        <blockquote>{FOUNDER_EXCERPTS.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</blockquote>
        <div className={styles.signature}><span className={styles.signatureMark} aria-hidden="true">A.</span><div><strong>Ash</strong><span>Founder, Hivra</span></div></div>
        <a className={styles.founderLink} href="/docs/litepaper/index.html#founder" target="_blank" rel="noopener noreferrer"><span>Read why I&apos;m building Hivra<small>The founder&apos;s note in the litepaper</small></span><ArrowUpRight size={32} strokeWidth={1.3} aria-hidden="true" /></a>
      </div>
    </div>
  </section>;
}
