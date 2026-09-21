'use client';

import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { BrainCircuit, ChevronRight, CircleHelp, CreditCard, Download, Gift, KeyRound, Moon, MonitorSmartphone, ServerCog, ShieldAlert, Sun, Trash2 } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useSettings } from '@/hooks/use-settings';
import { LanguageSwitcher, useLocale } from '@/components/i18n/LocaleProvider';
import { DashboardPageShell } from '@/components/layout/DashboardPageShell';
import { buildHermesFadeSlideVariants, buildHermesStaggerVariants } from '@/components/ui/motion';
import { isLocalAuthMode } from '@/lib/self-host/config';
import styles from './Settings.module.css';

function PreferenceSwitch({ id, label, description, checked, onChange }: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className={styles.preferenceRow}>
      <div>
        <span id={id + '-label'} className={styles.label}>{label}</span>
        <p id={id + '-description'} className={styles.description}>{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-labelledby={id + '-label'}
        aria-describedby={id + '-description'}
        aria-checked={checked}
        onClick={onChange}
        className={styles.switch}
      >
        <span className={styles.switchTrack} aria-hidden="true"><span /></span>
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const { copy } = useLocale();
  const { theme, setTheme } = useTheme();
  const { settings, updateSettings, clearCacheAndReload, isLoaded } = useSettings();
  const reduceMotion = Boolean(useReducedMotion());
  const sectionVariants = buildHermesFadeSlideVariants(reduceMotion, { offset: 12 });
  const sectionGroupVariants = buildHermesStaggerVariants(reduceMotion, 0.06);
  const settingsCopy = copy.dashboard.settings;
  const selfHosted = isLocalAuthMode();

  if (!isLoaded) {
    return (
      <DashboardPageShell maxWidth={1000}>
        <p role="status" className={styles.description}>{settingsCopy.loading}</p>
      </DashboardPageShell>
    );
  }

  const themes = [
    { id: 'light', label: settingsCopy.theme.light, icon: Sun },
    { id: 'dark', label: settingsCopy.theme.dark, icon: Moon },
    { id: 'system', label: settingsCopy.theme.system, icon: MonitorSmartphone },
  ];
  const destinations = [
    ...(!selfHosted ? [{ href: '/dashboard/billing', label: copy.dashboard.nav.billing, description: 'Plan, payments and credits.', icon: CreditCard }] : []),
    { href: '/dashboard/vault', label: 'Vault', description: 'Provider keys and agent assignments.', icon: KeyRound },
    { href: '/dashboard/infrastructure', label: copy.dashboard.nav.infrastructure, description: 'Connections, nodes and capacity.', icon: ServerCog },
    { href: '/dashboard/settings/applications', label: 'Applications', description: 'Use Hivra in your browser or as a web app.', icon: Download },
    { href: '/dashboard/settings/help', label: 'Help', description: 'Support, community and legal information.', icon: CircleHelp },
  ];

  return (
    <DashboardPageShell maxWidth={1000} padding="clamp(1rem, 3vw, 2rem)" topPadding="clamp(1rem, 3vw, 2rem)">
      <div className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>
            {settingsCopy.titlePrefix}{settingsCopy.titleSeparator}
            <em>{settingsCopy.titleEmphasis}</em>{settingsCopy.titleSuffix}
          </h1>
          <p className={styles.intro}>{settingsCopy.intro}</p>
        </header>

        <nav aria-label="Settings destinations" className={styles.destinations}>
          {destinations.map(({ href, label, description, icon: Icon }) => (
            <Link key={href} href={href} className={styles.destination}>
              <Icon size={17} aria-hidden="true" />
              <span><strong>{label}</strong><small>{description}</small></span>
              <ChevronRight size={14} aria-hidden="true" />
            </Link>
          ))}
        </nav>

        <motion.div initial="hidden" animate="visible" variants={sectionGroupVariants} className={styles.sections}>
          <motion.section variants={sectionVariants} aria-labelledby="appearance-heading">
            <h2 id="appearance-heading" className={styles.sectionHeading}>{settingsCopy.sections.appearance}</h2>
            <div className={styles.panel}>
              <div className={styles.themeRow}>
                <div>
                  <span id="theme-label" className={styles.label}>{settingsCopy.theme.label}</span>
                  <p id="theme-description" className={styles.description}>{settingsCopy.theme.description}</p>
                </div>
                <div role="group" aria-labelledby="theme-label" aria-describedby="theme-description" className={styles.themeChoices}>
                  {themes.map(({ id, label, icon: Icon }) => (
                    <button key={id} type="button" onClick={() => setTheme(id)} aria-pressed={theme === id}>
                      <Icon size={14} aria-hidden="true" />{label}
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.preferenceRow + ' ' + styles.languageRow}>
                <div>
                  <span className={styles.label}>{settingsCopy.language.label}</span>
                  <p className={styles.description}>{settingsCopy.language.description}</p>
                </div>
                <div className={styles.languageControl}><LanguageSwitcher /></div>
              </div>
              <PreferenceSwitch id="reduced-motion" {...settingsCopy.reducedMotion} checked={settings.reducedMotion} onChange={() => updateSettings({ reducedMotion: !settings.reducedMotion })} />
            </div>
          </motion.section>

          <motion.section variants={sectionVariants} aria-labelledby="chat-preferences-heading">
            <h2 id="chat-preferences-heading" className={styles.sectionHeading}>{settingsCopy.sections.chatInterface}</h2>
            <div className={styles.panel}>
              <PreferenceSwitch id="auto-scroll" {...settingsCopy.autoScroll} checked={settings.enableChatAutoScroll} onChange={() => updateSettings({ enableChatAutoScroll: !settings.enableChatAutoScroll })} />
              <PreferenceSwitch id="streaming-animations" {...settingsCopy.streamingAnimations} checked={settings.enableStreamingAnimations} onChange={() => updateSettings({ enableStreamingAnimations: !settings.enableStreamingAnimations })} />
              <PreferenceSwitch id="ai-reasoning" {...settingsCopy.aiReasoning} checked={settings.expandThinkingBlocks} onChange={() => updateSettings({ expandThinkingBlocks: !settings.expandThinkingBlocks })} />
            </div>
          </motion.section>

          <motion.section variants={sectionVariants} aria-labelledby="memory-heading">
            <h2 id="memory-heading" className={styles.sectionHeading}>Shared agent memory</h2>
            <Link href="/dashboard/settings/memory" className={styles.destination}>
              <BrainCircuit size={18} aria-hidden="true" />
              <span><strong>What all your agents should know</strong><small>Set account-wide context that every new agent starts with. Per-agent memory stays private.</small></span>
              <ChevronRight size={16} aria-hidden="true" />
            </Link>
          </motion.section>

          {process.env.NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED === 'true' && (
            <motion.section variants={sectionVariants} aria-labelledby="referral-heading">
              <h2 id="referral-heading" className={styles.sectionHeading}>Invite &amp; Earn</h2>
              <Link href="/dashboard/settings/referral" className={styles.destination}>
                <Gift size={18} aria-hidden="true" />
                <span><strong>Invite people, earn credits</strong><small>Share your link. When someone you invite gets going, you both get credits.</small></span>
                <ChevronRight size={16} aria-hidden="true" />
              </Link>
            </motion.section>
          )}

          <details className={styles.moreTools}>
            <summary>More tools</summary>
            <nav aria-label="More settings tools" className={styles.toolLinks}>
              <Link href="/dashboard/tools">Tools &amp; capabilities<ChevronRight size={14} aria-hidden="true" /></Link>
              <Link href="/dashboard/library">{copy.dashboard.nav.promptLibrary}<ChevronRight size={14} aria-hidden="true" /></Link>
              <Link href="/dashboard/templates">Templates<ChevronRight size={14} aria-hidden="true" /></Link>
              {!selfHosted && <Link href="/dashboard/wallet">{copy.dashboard.nav.wallet}<ChevronRight size={14} aria-hidden="true" /></Link>}
            </nav>
          </details>

          <motion.section variants={sectionVariants} aria-labelledby="danger-heading">
            <h2 id="danger-heading" className={styles.sectionHeading + ' ' + styles.dangerHeading}><ShieldAlert size={14} aria-hidden="true" />{settingsCopy.sections.dangerZone}</h2>
            <div className={styles.panel + ' ' + styles.dangerPanel}>
              <div className={styles.preferenceRow + ' ' + styles.cacheRow}>
                <div>
                  <span className={styles.label}>{settingsCopy.clearCache.label}</span>
                  <p id="cache-description" className={styles.description}>{settingsCopy.clearCache.description}</p>
                </div>
                <button type="button" onClick={clearCacheAndReload} aria-describedby="cache-description" className={styles.dangerButton}>
                  <Trash2 size={13} aria-hidden="true" />{settingsCopy.clearCache.action}
                </button>
              </div>
            </div>
          </motion.section>
        </motion.div>
      </div>
    </DashboardPageShell>
  );
}
