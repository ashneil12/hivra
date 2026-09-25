import ReachScene from "./ReachScene";
import { REACH } from "./content";
import styles from "./home.module.css";

/** The problem, told with the litepaper's own lines. */
export default function Reach() {
  return (
    <section id="why" className={styles.reach} aria-labelledby="why-heading">
      <ReachScene copy={REACH} />
    </section>
  );
}
