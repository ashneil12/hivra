import { ArrowUpRight, Code2, GitFork, GitBranch, Server } from "lucide-react";
import styles from "./product.module.css";

export default function OpenSourceSection() {
  return <section id="open-source" className={`${styles.section} ${styles.openSource}`} aria-labelledby="open-source-heading">
    <div className={styles.openCopy}>
      <span className={styles.eyebrow}>Open source</span>
      <h2 id="open-source-heading">Built to be open.<br /><em>Yours to run.</em></h2>
      <p>The complete Hivra platform uses Apache 2.0. Read the code. Change it. Run it yourself. Host it for your clients.</p>
      <p>This software sits between an agent and things you care about. You should be able to inspect its decisions about access, and keep going without us if we change direction.</p>
      <a href="/docs/litepaper/index.html#platform" target="_blank" rel="noopener noreferrer">Read the open-source commitment<ArrowUpRight size={17} aria-hidden="true" /></a>
    </div>
    <div className={styles.sourcePanel}>
      <div className={styles.sourceTop}><GitBranch size={34} strokeWidth={1.4} aria-hidden="true" /><span>Hivra / source</span><GitFork size={21} aria-hidden="true" /></div>
      <pre>{"Apache License\nVersion 2.0\nJanuary 2004"}</pre>
      <div className={styles.sourceRights}><span><Code2 size={16} aria-hidden="true" />Inspect & change</span><span><Server size={16} aria-hidden="true" />Run & self-host</span></div>
      <div id="github-release" className={styles.releaseStatus}><strong>Public GitHub release coming soon.</strong><p>The repository link will be added here when the public release is ready.</p><button type="button" disabled aria-describedby="github-placeholder-note"><GitBranch size={17} aria-hidden="true" />GitHub link coming soon</button><small id="github-placeholder-note">Repository link placeholder</small></div>
    </div>
  </section>;
}
