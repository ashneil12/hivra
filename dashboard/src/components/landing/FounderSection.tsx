import { ArrowUpRight } from "lucide-react";
import styles from "./founder-tokenomics.module.css";

// Complete excerpts from the owner-approved Litepaper. Keep the full essay linked.
export const FOUNDER_EXCERPTS = [
  "I run agents every day. I build software with them, dig through problems with them, and get through work that would otherwise take a week. I want to keep doing that as they get better.",
  "I'm also a Christian, and I genuinely think AI is leading somewhere beyond what the news says, or what people really want to believe.",
  "I think this ends up somewhere scripture already described. A world where taking part in the economy gets conditioned on compliance, where the ability to buy and sell runs through something that can exclude you, and where AI is what finally makes that possible at scale. I think it arrives looking reasonable, because that's how it would have to arrive.",
  "Someone has to be answerable. Someone decides what the agent reaches, where its authority stops, and how to pull the plug.",
  "Hivra is the practical part of that. Give the agent a computer. Make it good enough that people actually use it. Keep control of everything around it."
] as const;
export default function FounderSection() {
  return <section id="founder" className={styles.founder} aria-labelledby="founder-heading">
    <div className={styles.founderTop}><span>A personal note from the founder</span><span>Ash / Hivra</span></div>
    <div className={styles.founderGrid}>
      <header className={styles.founderHeading}><span className={styles.rule} aria-hidden="true" /><h2 id="founder-heading">Why I&apos;m<br />building it.</h2></header>
      <div className={styles.founderCopy}><blockquote>{FOUNDER_EXCERPTS.map(paragraph => <p key={paragraph}>{paragraph}</p>)}</blockquote>
        <a className={styles.founderLink} href="/why-hivra" target="_blank" rel="noopener noreferrer"><span>Read why I&apos;m building Hivra</span><ArrowUpRight size={26} aria-hidden="true" /></a>
        <div className={styles.signature}><span className={styles.signatureMark} aria-hidden="true">A.</span><div><strong>Ash</strong><span>Founder</span></div></div>
      </div>
    </div>
  </section>;
}
