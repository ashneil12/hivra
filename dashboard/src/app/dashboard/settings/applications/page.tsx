import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, Monitor, Smartphone } from 'lucide-react';
import { DashboardPageShell } from '@/components/layout/DashboardPageShell';
import { PwaInstallPrompt } from '@/components/pwa/PwaInstallPrompt';
import styles from '../Settings.module.css';

export default function ApplicationsPage() {
  return (
    <DashboardPageShell maxWidth={824} padding="clamp(1rem, 3vw, 2rem)" topPadding="clamp(1rem, 3vw, 2rem)">
      <div className={styles.page}>
        <header className={styles.header}>
          <Link href="/dashboard/settings" className={styles.backLink}><ArrowLeft size={14} aria-hidden="true" />Back to settings</Link>
          <h1 className={styles.title}>Applications<span aria-hidden="true">.</span></h1>
          <p className={styles.intro}>Keep your Hivra workspace close, on your computer or phone.</p>
        </header>

        <section className={styles.contentPanel} aria-labelledby="browser-heading">
          <h2 id="browser-heading">Your workspace in the browser</h2>
          <p>Manage agents and computers from this dashboard. You can keep using Hivra here without installing anything.</p>
          <div className={styles.contentActions}>
            <Link href="/dashboard" className={styles.primaryLink}><Monitor size={15} aria-hidden="true" />Open workspace<ArrowUpRight size={14} aria-hidden="true" /></Link>
          </div>
        </section>

        <section className={styles.contentPanel} aria-labelledby="web-app-heading">
          <h2 id="web-app-heading">Add the Hivra web app</h2>
          <p>Supported browsers can add this workspace to your Dock, desktop or Home Screen. Installation options depend on your browser and device.</p>
          <div className={styles.installation}><PwaInstallPrompt expanded /></div>
          <p>If an install option is not shown here, check your browser menu. You can also bookmark Hivra and continue in the browser.</p>
        </section>

        <section className={styles.contentPanel} aria-labelledby="computer-access-heading">
          <h2 id="computer-access-heading">Connect to an agent computer</h2>
          <p>Open the computer you want to use for its available desktop and connection options. Access options depend on that computer&apos;s setup.</p>
          <div className={styles.contentActions}>
            <Link href="/dashboard/computers" className={styles.secondaryLink}><Smartphone size={15} aria-hidden="true" />Your computers<ArrowUpRight size={14} aria-hidden="true" /></Link>
          </div>
        </section>
      </div>
    </DashboardPageShell>
  );
}
