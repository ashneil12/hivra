import Link from "next/link";
import { ArrowRight, Cloud, KeyRound, Server, Unplug } from "lucide-react";
import styles from "./product.module.css";

const OPTIONS = [
  { name: "Hivra Cloud", icon: Cloud, sub: "Let us run it", body: "We handle the machines, updates, monitoring and recovery. You choose the work and what it can reach.", href: "/dashboard/launch?start=1", cta: "Explore Hivra Cloud" },
  { name: "Your infrastructure", icon: Server, sub: "Use what you already have", body: "Connect your own cloud account or a server. Put capacity you're already paying for to work, with you in control of where the computer lives.", href: "/dashboard/launch?start=1", cta: "Bring your capacity" },
  { name: "Self-host Hivra", icon: Unplug, sub: "Run the whole platform", body: "Your hardware, your sign-in, no Hivra account. Run the platform yourself and choose how to maintain it.", href: "/docs/litepaper/index.html#platform", cta: "Read about self-hosting" },
];

export default function HostingSection() {
  return <section id="hosting" className={styles.section} aria-labelledby="hosting-heading">
    <div className={styles.hostingHeading}><span className={styles.eyebrow}>Choose who runs it</span><h2 id="hosting-heading">Where it lives<br /><em>is your call.</em></h2><p>Keep it with us, connect a cloud account or server, or run Hivra yourself. Pick the setup that suits you.</p></div>
    <div className={styles.hostingList}>{OPTIONS.map(option => { const Icon = option.icon; return <article key={option.name}>
      <div className={styles.hostingName}><Icon size={26} strokeWidth={1.5} aria-hidden="true" /><div><small>{option.sub}</small><h3>{option.name}</h3></div></div>
      <p>{option.body}</p><Link href={option.href}>{option.cta}<ArrowRight size={17} aria-hidden="true" /></Link>
    </article>; })}</div>
    <div className={styles.modelChoice}><KeyRound size={21} aria-hidden="true" /><p><strong>Bring your own model connection.</strong> Use your own API key whether the computer runs with us or on your own hardware. Managed hosting keeps that choice in your hands.</p></div>
  </section>;
}
