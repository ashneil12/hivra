import { ArrowRight } from "lucide-react";
import styles from "./home.module.css";
export default function VisionSection() {
  return <section className={styles.vision}>
    <span>Why we&apos;re building Hivra</span>
    <h2>Give the work room.<br />Keep hold of the rest.</h2>
    <p>An agent fixing your website needs the project. It doesn&apos;t need your personal documents, your bank session, or a route into every other device on your home network.</p>
    <p>A separate computer is somewhere to draw that line. Share the project. Connect the accounts you want it using. Keep control of what comes in.</p>
    <a href="/docs/litepaper/index.html#founder" target="_blank" rel="noopener noreferrer" className={styles.textLink}>Why Hivra<ArrowRight size={18} aria-hidden="true" /></a>
    <a href="/docs/litepaper/" target="_blank" rel="noopener noreferrer" className={styles.textLink}>Read the litepaper<ArrowRight size={18} aria-hidden="true" /></a>
  </section>;
}
