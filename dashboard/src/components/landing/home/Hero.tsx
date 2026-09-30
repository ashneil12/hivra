import Link from "next/link";
import { ArrowRight, Code2, KeyRound, Server } from "lucide-react";
import AgentsDeployedStat from "@/components/landing/AgentsDeployedStat";
import { AGENT_LAUNCH_HREF, GUARANTEE_LINE, HERO } from "./content";
import HeroScene from "./HeroScene";
import styles from "./home.module.css";

const PROOF_ICONS = [KeyRound, Server, Code2];

/**
 * The first screen. The headline, subhead and call to action are plain server
 * HTML with no entrance animation, so the H1 is the page's first contentful
 * and largest paint. Only decoration moves: the neon on "computer.", the rule
 * under the second line, and the machine on the right.
 */
export default function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="home-title">
      <div className={styles.heroBackdrop} aria-hidden="true" />
      <div className={styles.heroGrid}>
        <div className={styles.heroCopy}>
          <Link className={styles.heroEyebrow} href={HERO.eyebrowHref}>
            <i aria-hidden="true" />
            {HERO.eyebrow}
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
          <h1 id="home-title" className={styles.heroTitle}>
            {HERO.titleLead} <em className={styles.heroWord}>{HERO.titleWord}</em>{" "}
            <span className={styles.heroTail}>{HERO.titleTail}</span>
          </h1>
          <p className={styles.heroSubhead}>{HERO.subhead}</p>
          <div className={styles.heroActions}>
            <Link id="hero-primary-cta" href={AGENT_LAUNCH_HREF} className={styles.primaryCta} data-cta="hero-primary">
              <span>{HERO.primary}</span>
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
            <a href="#computers" className={styles.textCta} data-cta="hero-secondary">
              {HERO.secondary}
              <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
          <p className={styles.guarantee}>{GUARANTEE_LINE}</p>
          <ul className={styles.heroProof} aria-label="What you bring and where it runs">
            {HERO.proof.map((point, index) => {
              const Icon = PROOF_ICONS[index];
              return (
                <li key={point}>
                  <Icon size={14} aria-hidden="true" />
                  {point}
                </li>
              );
            })}
          </ul>
          <div className={styles.heroStat}>
            <AgentsDeployedStat />
          </div>
        </div>
        <HeroScene />
      </div>
    </section>
  );
}
