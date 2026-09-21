"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, Download, Lock, Shield, Zap } from "lucide-react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import styles from "./home.module.css";
import { AGENT_LAUNCH_HREF } from "./public-home-content";
import { PUBLIC_PROJECT_LINKS } from "@/lib/public-project-links";
interface HeroSectionProps { agentsCounter?: ReactNode; liveStat?: ReactNode }
export default function HeroSection({ agentsCounter, liveStat }: HeroSectionProps = {}) {
  const { copy, locale } = useLocale();
  const hero = copy.hero;
  const english = locale.toLowerCase().startsWith("en");
  const downloadsPending = !Object.values(PUBLIC_PROJECT_LINKS.desktop).some(release => release.status === "published");
  const proofIcons = [Zap, Lock, Shield];
  return <section className={styles.hero} aria-labelledby="home-title">
    <div className={styles.heroTopline}><span><i />{english ? "Agent computers" : hero.eyebrow}</span><a href="/docs/litepaper/" target="_blank" rel="noopener noreferrer">The Hivra litepaper <ArrowRight size={14} /></a></div>
    <div className={styles.heroGrid}>
      <div className={styles.heroCopy}>
        <h1 id="home-title">{english ? <>Your agent needs a <em>computer.</em><span>It doesn&apos;t need yours.</span></> : <>{hero.headlinePrefix}<em>{hero.headlineEmphasis}</em></>}</h1>
        <p className={styles.heroDescription}>{english ? "Give it room to work. Decide what it can reach. Launch an agent on a computer of its own, or start with a computer and use it yourself." : hero.primary}</p>
        <div className={styles.heroActions}>
          <Link id="hero-primary-cta" href={english ? AGENT_LAUNCH_HREF : "/get-started?plan=free"} className={styles.primary}>{english ? "Launch an agent" : hero.primaryCta}<ArrowRight size={18} aria-hidden="true" /></Link>
          {english ? <Link id="hero-secondary-cta" href="/download" className={styles.secondary} aria-describedby={downloadsPending ? "desktop-availability" : undefined}>Download the app<Download size={18} aria-hidden="true" /></Link> : <a id="hero-secondary-cta" href="#how-it-works" className={styles.secondary}>{hero.secondaryCta}<ChevronDown size={16} aria-hidden="true" /></a>}
        </div>
        {english && downloadsPending && <p id="desktop-availability" className={styles.downloadAvailability}>Mac and Windows apps are coming soon. Browser access is available now.</p>}
        <p className={styles.heroNote}>{english ? "Ubuntu, Windows or Omarchy. Hivra Cloud or your own infrastructure. Your model key stays your choice." : hero.secondary}</p>
      </div>
      {agentsCounter}
    </div>
    <div className={styles.heroBottom}>
      <div className={styles.heroProof}>{(english ? ["Your own workspace", "Your choice of interface", "Your choice of hosting"] : hero.proofPoints).map((point, index) => { const Icon = proofIcons[index % proofIcons.length]; return <span key={point}><Icon size={14} />{point}</span>; })}</div>
      {liveStat}
    </div>
    <div className={styles.heroQuickLinks}>
      <Link href="#founder"><span>Why I&apos;m building Hivra<small>AI, faith and the future</small></span><ArrowRight size={18} aria-hidden="true" /></Link>
      <Link href="/tokenomics"><span>The tokenomics<small>Access, useful work and what comes next</small></span><ArrowRight size={16} aria-hidden="true" /></Link>
    </div>
  </section>;
}
