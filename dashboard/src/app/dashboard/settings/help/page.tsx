import Link from 'next/link';
import { ArrowUpRight, Mail, MessageCircle } from 'lucide-react';
import { DashboardPageShell } from '@/components/layout/DashboardPageShell';
import styles from '../Settings.module.css';

export default function HelpPage() {
  return (
    <DashboardPageShell maxWidth={900} padding="clamp(1rem, 3vw, 2rem)" topPadding="clamp(1rem, 3vw, 2rem)">
      <div className={styles.page}>
        <header className={styles.header}>
          <Link href="/dashboard/settings" className={styles.eyebrow}>Settings /</Link>
          <h1 className={styles.title}>A little <em>help.</em></h1>
          <p className={styles.intro}>Support and the Hivra community, in one place.</p>
        </header>

        <section className={styles.contentPanel} aria-labelledby="support-heading">
          <h2 id="support-heading">Get in touch</h2>
          <p>For help with your account or a resource, email support. Include what you were trying to do and any error message; leave out passwords and API keys.</p>
          <div className={styles.contentActions}>
            <a href="mailto:info@hermesos.cloud" className={styles.primaryLink}><Mail size={15} aria-hidden="true" />Email support</a>
            <a href="https://discord.gg/tDQZq8479F" target="_blank" rel="noopener noreferrer" className={styles.secondaryLink}><MessageCircle size={15} aria-hidden="true" />Discord<span className="sr-only"> (opens in a new tab)</span><ArrowUpRight size={14} aria-hidden="true" /></a>
          </div>
        </section>

        <section className={styles.contentPanel} aria-labelledby="updates-heading">
          <h2 id="updates-heading">Follow along</h2>
          <p>Find product updates and join the conversation on X.</p>
          <div className={styles.contentActions}>
            <a href="https://x.com/Wayland_Six" target="_blank" rel="noopener noreferrer" className={styles.secondaryLink}>X (Twitter)<span className="sr-only"> (opens in a new tab)</span><ArrowUpRight size={14} aria-hidden="true" /></a>
          </div>
        </section>

        <nav aria-label="Legal information" className={styles.legalLinks}>
          <Link href="/terms">Terms of Service</Link>
          <Link href="/privacy">Privacy Policy</Link>
        </nav>
      </div>
    </DashboardPageShell>
  );
}
