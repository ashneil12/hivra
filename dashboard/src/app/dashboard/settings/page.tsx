'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { UserButton, useUser } from '@clerk/nextjs';
import {
  BrainCircuit,
  ChevronRight,
  CircleHelp,
  CreditCard,
  Download,
  Eraser,
  Gift,
  KeyRound,
  Languages,
  LayoutTemplate,
  LibraryBig,
  LogOut,
  Moon,
  MonitorSmartphone,
  Palette,
  Sun,
  Trash2,
  UserRound,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { accountCode } from '@/lib/account-code';
import { useSettings } from '@/hooks/use-settings';
import { LanguageSwitcher, useLocale } from '@/components/i18n/LocaleProvider';
import { DashboardPageShell } from '@/components/layout/DashboardPageShell';
import { useNativeWorkspace } from '@/components/layout/NativeWorkspaceBridge';
import { buildHermesFadeSlideVariants, buildHermesStaggerVariants } from '@/components/ui/motion';
import { isLocalAuthMode } from '@/lib/self-host/config';
import { clientLog } from '@/lib/client/logger';
import styles from './Settings.module.css';

/** How long the first press of "Clear cache" stays armed before it resets. */
const CLEAR_CACHE_CONFIRM_MS = 4000;

type LinkRowItem = {
  id: string;
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
};

type SettingsGroupItem = {
  id: string;
  heading: string;
  content: ReactNode;
  note?: ReactNode;
};

function RowIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className={styles.rowIcon} aria-hidden="true">
      <Icon size={16} strokeWidth={1.75} />
    </span>
  );
}

function LinkRows({ items }: { items: readonly LinkRowItem[] }) {
  return (
    <ul className={styles.panel} role="list">
      {items.map(({ id, href, icon, title, description }) => (
        <li key={id}>
          <Link
            href={href}
            className={styles.linkRow}
            aria-labelledby={`settings-${id}-title`}
            aria-describedby={`settings-${id}-description`}
          >
            <RowIcon icon={icon} />
            <span className={styles.rowText}>
              <span id={`settings-${id}-title`} className={styles.rowTitle}>{title}</span>
              <span id={`settings-${id}-description`} className={styles.rowDescription}>{description}</span>
            </span>
            <ChevronRight className={styles.chevron} size={16} aria-hidden="true" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ControlRow({ id, icon, title, description, children, className }: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={[styles.row, styles.controlRow, className].filter(Boolean).join(' ')}>
      <RowIcon icon={icon} />
      <div className={styles.rowText}>
        <span id={`${id}-label`} className={styles.rowTitle}>{title}</span>
        <p id={`${id}-description`} className={styles.rowDescription}>{description}</p>
      </div>
      <div className={styles.control}>{children}</div>
    </div>
  );
}

/**
 * Self-hosted sign-out. The self-host auth shim's UserButton is a bare "H"
 * avatar that signs out on one press, which reads as a profile menu in a row
 * titled for the account, so this row gets a labelled button instead.
 */
function SelfHostSignOutButton({ labels }: { labels: { signOut: string; signingOut: string; failed: string } }) {
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle');

  const signOut = async () => {
    setState('busy');
    try {
      const response = await fetch('/api/self-host/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error(`Self-hosted sign-out returned ${response.status}`);
      // A full load, not router.push: the local auth provider read the session
      // once on mount, so only a fresh document drops the signed-out user.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign('/sign-in');
    } catch (error) {
      clientLog.error('Self-hosted sign-out failed', error, {
        source: 'settings',
        failureType: 'self_host_sign_out_failed',
      });
      setState('failed');
    }
  };

  return (
    <div className={styles.signOutControl}>
      <button
        type="button"
        onClick={() => void signOut()}
        disabled={state === 'busy'}
        aria-describedby="account-profile-description"
        className={styles.signOutButton}
      >
        <LogOut size={14} aria-hidden="true" />
        {state === 'busy' ? labels.signingOut : labels.signOut}
      </button>
      <span role="status" className={state === 'failed' ? styles.controlError : 'sr-only'}>
        {state === 'failed' ? labels.failed : ''}
      </span>
    </div>
  );
}

export default function SettingsPage() {
  const { copy } = useLocale();
  const { theme, setTheme } = useTheme();
  const { clearCacheAndReload, isLoaded } = useSettings();
  const { user } = useUser();
  const ownerAccountCode = user?.id ? accountCode(user.id) : null;
  const { enabled: nativeWorkspace, ownerKey: nativeOwner } = useNativeWorkspace();
  const reduceMotion = Boolean(useReducedMotion());
  const sectionVariants = buildHermesFadeSlideVariants(reduceMotion, { offset: 12 });
  const sectionGroupVariants = buildHermesStaggerVariants(reduceMotion, 0.06);
  const settingsCopy = copy.dashboard.settings;
  const hub = settingsCopy.hub;
  const selfHosted = isLocalAuthMode();

  // Clearing wipes local state and reloads, so the first press only arms it.
  const [clearCacheArmed, setClearCacheArmed] = useState(false);
  const clearCacheTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (clearCacheTimerRef.current) clearTimeout(clearCacheTimerRef.current);
  }, []);

  const handleClearCache = () => {
    if (clearCacheTimerRef.current) clearTimeout(clearCacheTimerRef.current);
    clearCacheTimerRef.current = null;
    if (clearCacheArmed) {
      setClearCacheArmed(false);
      clearCacheAndReload();
      return;
    }
    setClearCacheArmed(true);
    clearCacheTimerRef.current = setTimeout(() => {
      clearCacheTimerRef.current = null;
      setClearCacheArmed(false);
    }, CLEAR_CACHE_CONFIRM_MS);
  };

  if (!isLoaded) {
    return (
      <DashboardPageShell maxWidth={824} padding="clamp(1rem, 3vw, 2rem)" topPadding="clamp(1rem, 3vw, 2rem)">
        <p role="status" className={styles.loading}>{settingsCopy.loading}</p>
      </DashboardPageShell>
    );
  }

  const email = user?.primaryEmailAddress?.emailAddress;
  const profile = hub.profile;
  // A replacer function, so "$&"-style sequences in an address are never expanded.
  const signedInDescription = email ? profile.signedInAs.replace('{email}', () => email) : null;
  const themes = [
    { id: 'light', label: settingsCopy.theme.light, icon: Sun },
    { id: 'dark', label: settingsCopy.theme.dark, icon: Moon },
    { id: 'system', label: settingsCopy.theme.system, icon: MonitorSmartphone },
  ];

  const billingRows: LinkRowItem[] = [
    { id: 'billing', href: '/dashboard/billing', icon: CreditCard, title: copy.dashboard.nav.billing, description: hub.rows.billing.description },
    // Agent wallets exist whether or not crypto billing is switched on.
    { id: 'wallets', href: '/dashboard/wallet', icon: Wallet, title: hub.rows.wallets.title, description: hub.rows.wallets.description },
  ];
  const connectionRows: LinkRowItem[] = [
    { id: 'api-keys', href: '/dashboard/vault', icon: KeyRound, title: hub.rows.apiKeys.title, description: hub.rows.apiKeys.description },
  ];
  const toolkitRows: LinkRowItem[] = [
    { id: 'memory', href: '/dashboard/settings/memory', icon: BrainCircuit, title: hub.rows.memory.title, description: hub.rows.memory.description },
    { id: 'tools', href: '/dashboard/tools', icon: Wrench, title: hub.rows.tools.title, description: hub.rows.tools.description },
    { id: 'library', href: '/dashboard/library', icon: LibraryBig, title: hub.rows.library.title, description: hub.rows.library.description },
    { id: 'templates', href: '/dashboard/templates', icon: LayoutTemplate, title: hub.rows.templates.title, description: hub.rows.templates.description },
    ...(process.env.NEXT_PUBLIC_HIVRA_REFERRAL_ENABLED === 'true'
      ? [{ id: 'referral', href: '/dashboard/settings/referral', icon: Gift, title: hub.rows.referral.title, description: hub.rows.referral.description }]
      : []),
  ];
  const appRows: LinkRowItem[] = [
    { id: 'applications', href: '/dashboard/settings/applications', icon: Download, title: hub.rows.applications.title, description: hub.rows.applications.description },
    { id: 'help', href: '/dashboard/settings/help', icon: CircleHelp, title: hub.rows.help.title, description: hub.rows.help.description },
  ];

  const groups: SettingsGroupItem[] = [
    // The native macOS shell renders its own account header on this route.
    ...(nativeWorkspace && nativeOwner ? [] : [{
      id: 'account',
      heading: hub.groups.account,
      content: (
        <div className={styles.panel}>
          {selfHosted ? (
            // Self-host has no profile or security management to promise.
            <ControlRow
              id="account-profile"
              icon={UserRound}
              title={profile.selfHostTitle}
              description={signedInDescription ?? profile.selfHostFallback}
            >
              <SelfHostSignOutButton
                labels={{ signOut: profile.signOut, signingOut: profile.signingOut, failed: profile.signOutFailed }}
              />
            </ControlRow>
          ) : (
            <ControlRow
              id="account-profile"
              icon={UserRound}
              title={profile.title}
              description={signedInDescription ?? profile.fallback}
              className={styles.accountRow}
            >
              <div className={styles.accountControl}><UserButton /></div>
            </ControlRow>
          )}
          {ownerAccountCode ? (
            <ControlRow
              id="account-code"
              icon={KeyRound}
              title="Account code"
              description="Hivra's server setup command shows this code before it connects a server to your account. Continue only if the codes match."
            >
              <code aria-labelledby="account-code-label">{ownerAccountCode}</code>
            </ControlRow>
          ) : null}
        </div>
      ),
    }]),
    ...(!selfHosted ? [{ id: 'billing', heading: hub.groups.billing, content: <LinkRows items={billingRows} /> }] : []),
    { id: 'connections', heading: hub.groups.connections, content: <LinkRows items={connectionRows} /> },
    { id: 'toolkit', heading: hub.groups.toolkit, content: <LinkRows items={toolkitRows} /> },
    {
      id: 'device',
      heading: hub.groups.device,
      content: (
        <div className={styles.panel}>
          <ControlRow id="theme" icon={Palette} title={settingsCopy.theme.label} description={settingsCopy.theme.description} className={styles.fixedControlRow}>
            <div role="group" aria-labelledby="theme-label" aria-describedby="theme-description" className={styles.segmented}>
              {themes.map(({ id, label, icon: Icon }) => (
                <button key={id} type="button" onClick={() => setTheme(id)} aria-pressed={theme === id}>
                  <Icon size={14} aria-hidden="true" />{label}
                </button>
              ))}
            </div>
          </ControlRow>
          <ControlRow id="language" icon={Languages} title={settingsCopy.language.label} description={settingsCopy.language.description} className={styles.fixedControlRow}>
            <div className={styles.languageControl}><LanguageSwitcher /></div>
          </ControlRow>
        </div>
      ),
      note: hub.motionNote,
    },
    { id: 'apps', heading: hub.groups.apps, content: <LinkRows items={appRows} /> },
    {
      id: 'reset',
      heading: hub.groups.reset,
      content: (
        <div className={styles.panel}>
          <ControlRow id="cache" icon={Eraser} title={settingsCopy.clearCache.label} description={settingsCopy.clearCache.description}>
            <button
              type="button"
              onClick={handleClearCache}
              aria-describedby="cache-description"
              data-armed={clearCacheArmed ? 'true' : undefined}
              className={styles.resetButton}
            >
              <Trash2 size={14} aria-hidden="true" />
              {clearCacheArmed ? hub.clearCacheConfirm : settingsCopy.clearCache.action}
            </button>
            <span role="status" className="sr-only">{clearCacheArmed ? hub.clearCacheArmed : ''}</span>
          </ControlRow>
        </div>
      ),
    },
  ];

  return (
    <DashboardPageShell maxWidth={824} padding="clamp(1rem, 3vw, 2rem)" topPadding="clamp(1rem, 3vw, 2rem)">
      <div className={styles.page}>
        <header className={styles.header}>
          <h1 className={styles.title}>{hub.title}<span aria-hidden="true">{settingsCopy.titleSuffix}</span></h1>
          <p className={styles.intro}>{hub.intro}</p>
        </header>

        <motion.div initial="hidden" animate="visible" variants={sectionGroupVariants} className={styles.sections}>
          {groups.map(({ id, heading, content, note }) => (
            <motion.section key={id} variants={sectionVariants} aria-labelledby={`settings-group-${id}`} className={styles.group}>
              {/* Unnumbered: these groups are not steps, and the set differs between hosted, self-host and the native shell. */}
              <h2 id={`settings-group-${id}`} className={styles.groupHeading}>{heading}</h2>
              {content}
              {note ? <p className={styles.groupNote}>{note}</p> : null}
            </motion.section>
          ))}
        </motion.div>
      </div>
    </DashboardPageShell>
  );
}
