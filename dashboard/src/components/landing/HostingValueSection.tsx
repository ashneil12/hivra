import styles from "./relaunch.module.css";

export default function HostingValueSection() {
  return <section className={styles.value} aria-labelledby="hosting-value-heading">
    <h2 id="hosting-value-heading">What you&apos;re<br /><em>paying for.</em></h2>
    <div>
      <p>A bare server costs less than this. We know, because we rent ours from the same people you would.</p>
      <p>What you get here is the afternoon you didn&apos;t spend installing things, and the Tuesday you didn&apos;t spend working out why it stopped. Your agent is running before you&apos;ve finished reading this sentence. When it crashes at 3am it comes back on its own, and you find out on Wednesday, from a log, if you care to look.</p>
      <p className={styles.payoff}>That&apos;s the trade. Slightly less hardware, none of the evenings.</p>
    </div>
  </section>;
}
