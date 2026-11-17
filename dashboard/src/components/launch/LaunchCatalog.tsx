"use client";

// The catalog view of Launch's Choose step: a search and filters over the
// tiles, and a page for each agent or computer that the owner reads before
// Review. Shown only where isLaunchCatalogEnabled() is on.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Copy, Search, type LucideIcon } from "lucide-react";

import { getAgent } from "@/lib/hivra/agent-catalog";
import { makerPageHref, type CatalogClaimView } from "@/lib/hivra/catalog-claim-types";
import { PROFILE_DETAILS, profileHasBrowser, runsOnHivraCloudOnly, type LaunchProfileId } from "@/lib/launch/contracts";
import {
  catalogSourceRepo,
  isMakerClaimsEnabled,
  LAUNCH_CATALOG,
  primaryCatalogJob,
  type CatalogFilter,
  type CatalogJobId,
  type CatalogKind,
} from "@/lib/launch/launch-catalog";
import { capabilitySummary } from "@/lib/launch/launch-plan";
import { captureLaunchEventOnce } from "@/lib/launch/launch-telemetry";
import { modelAccessModes } from "@/lib/launch/model-access";

import { fetchCatalogClaim } from "./catalog-claims-client";
import journey from "./LaunchJourney.module.css";
import styles from "./LaunchCatalog.module.css";

const KINDS: readonly { id: CatalogKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "agent", label: "Agents" },
  { id: "computer", label: "Computers" },
];

export function LaunchCatalogToolbar({ filter, onChange, counts, jobs }: {
  filter: CatalogFilter;
  onChange: (next: CatalogFilter) => void;
  counts: Record<CatalogKind, number>;
  jobs: readonly { id: CatalogJobId; label: string; hint: string; count: number }[];
}) {
  return (
    <>
      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Search size={15} aria-hidden />
          <input
            type="search"
            aria-label="Search agents and computers"
            placeholder="Search, or say what you need done"
            value={filter.query}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={event => onChange({ ...filter, query: event.target.value })}
          />
        </label>
        <div className={styles.kinds} role="group" aria-label="Show">
          {KINDS.map(kind => (
            <button
              key={kind.id}
              type="button"
              aria-pressed={filter.kind === kind.id}
              // Jobs describe agents, so a job and Computers never hold together.
              onClick={() => onChange({ ...filter, kind: kind.id, job: kind.id === "computer" ? null : filter.job })}
            >
              {kind.label} <span>{counts[kind.id]}</span>
            </button>
          ))}
        </div>
      </div>
      {jobs.length > 0 && filter.kind !== "computer" ? (
        <section className={journey.chooseSection} aria-labelledby="launch-jobs-heading">
          <div className={journey.chooseHeading}>
            <h2 id="launch-jobs-heading">Browse by job</h2>
            <p>Pick what you need done.</p>
          </div>
          <div className={styles.jobs}>
            {jobs.map(job => (
              <button
                key={job.id}
                type="button"
                aria-pressed={filter.job === job.id}
                onClick={() => onChange({ ...filter, job: filter.job === job.id ? null : job.id })}
              >
                <strong>{job.label} <span>{job.count}</span></strong>
                <small>{job.hint}</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    // A browser that refuses the clipboard leaves the words on the page to select.
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
  };
  return (
    <button type="button" className={`${journey.inlineAction} ${styles.rowAction}`} aria-label={label} onClick={copy}>
      {copied ? <><Check size={13} aria-hidden /> Copied</> : <><Copy size={13} aria-hidden /> Copy</>}
    </button>
  );
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/** How its model use can be paid, in the words Review uses for each choice. */
function modelAccessLine(profileId: LaunchProfileId, name: string): string | null {
  const modes = modelAccessModes(profileId);
  if (modes.length === 0) return null;
  const words = [
    modes.includes("credits") ? "Hivra credits" : null,
    modes.includes("api-key") ? "your own key" : null,
    !modes.includes("native") ? null
      : profileId === "claude-code" ? "your own Claude login"
      : profileId === "codex" ? "your own ChatGPT login"
      : `${name}'s own setup`,
  ].filter((word): word is string => word !== null);
  const line = joinWords(words);
  return line.charAt(0).toUpperCase() + line.slice(1);
}

function whereItRuns(profileId: LaunchProfileId, selfHosted: boolean): string {
  const details = PROFILE_DETAILS[profileId];
  if (selfHosted || details.managedCapacity === "self-managed-only") return "A server you connected";
  if (runsOnHivraCloudOnly(profileId) || !details.ownServer) return "Hivra Cloud";
  return "Hivra Cloud, or a server you connect";
}

function sourceLabel(url: string): string {
  return url.replace(/^https:\/\//, "");
}

export function CatalogRow({ label, value, note, action }: { label: string; value: ReactNode; note?: string | null; action?: ReactNode }) {
  return (
    <div className={journey.planRow}>
      <span className={journey.planLabel}>{label}</span>
      <span className={journey.planValue}>
        <span className={journey.planSummary}>
          <strong>{value}</strong>
          {note ? <small>{note}</small> : null}
        </span>
        {action}
      </span>
    </div>
  );
}

export function LaunchCatalogPage({ profileId, name, description, icon: Icon, fit, selfHosted, related, onBack, onReview }: {
  profileId: LaunchProfileId;
  name: string;
  description: string;
  icon: LucideIcon | null;
  /** The same fit badge its tile shows. */
  fit: ReactNode;
  selfHosted: boolean;
  /** Tiles for other things that do the same job. */
  related: ReactNode[];
  onBack: () => void;
  onReview: () => void;
}) {
  const entry = LAUNCH_CATALOG[profileId];
  const details = PROFILE_DETAILS[profileId];
  const agent = getAgent(details.runtimeId);
  const computer = details.resourceKind === "computer";
  const job = primaryCatalogJob(profileId);
  const maker = computer ? null : agent?.vendor ?? null;
  const modelAccess = modelAccessLine(profileId, name);
  const uses = capabilitySummary(profileId, { browser: true }).replace(" Browser: on.", "");
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Announce the page and bring its top into view, as each journey step does.
    headingRef.current?.focus();
    captureLaunchEventOnce(`catalog-page:${profileId}`, "launch_catalog_page_viewed", { profile_id: profileId });
  }, [profileId]);
  // A page can be claimed where Hivra can read its maker's repository, on the
  // hosted service, and only while maker claims are turned on.
  const claimable = isMakerClaimsEnabled() && catalogSourceRepo(profileId) !== null && !selfHosted;
  const [claimRead, setClaimRead] = useState<CatalogClaimView | null>(null);
  useEffect(() => {
    if (!claimable) return;
    const controller = new AbortController();
    void fetchCatalogClaim(profileId, controller.signal).then(next => {
      if (!controller.signal.aborted) setClaimRead(next);
    });
    return () => controller.abort();
  }, [claimable, profileId]);
  // An answer for another page is not this page's.
  const claim = claimable && claimRead?.profileId === profileId ? claimRead : null;
  const makerWords = maker === name ? `the ${name} project` : maker;

  return (
    <section className={journey.stage} aria-labelledby="launch-about-heading" data-testid="launch-catalog-page">
      <div className={journey.stageIntro}>
        <span className={journey.eyebrow}>{computer ? "Computer" : job ? `Agent · ${job.label}` : "Agent"}</span>
        <h1 id="launch-about-heading" ref={headingRef} tabIndex={-1}>{name}</h1>
        <p>{description}</p>
      </div>
      <div className={styles.badges}>{fit}</div>
      {entry.cover ? (
        <figure className={styles.cover}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a static picture with its own size */}
          <img src={entry.cover.src} alt={entry.cover.alt} width={entry.cover.width} height={entry.cover.height} decoding="async" />
        </figure>
      ) : (
        <div
          className={styles.cover}
          data-art="true"
          aria-hidden
          style={agent?.accent ? { "--catalog-accent": agent.accent } as CSSProperties : undefined}
        >
          {Icon ? <Icon size={56} strokeWidth={1.4} /> : <span className={styles.coverLetter}>O.</span>}
          <span>{name}</span>
        </div>
      )}
      <div className={journey.planCard} role="group" aria-label={`About ${name}`}>
        {maker ? (
          <CatalogRow
            label="Made by"
            value={maker === name ? `The ${name} project` : maker}
            note={claim?.claimed
              ? "Hivra wrote this page. Its maker has claimed it."
              : `Hivra wrote this page and is independent of ${makerWords}.`}
            action={claimable ? (
              <Link className={`${journey.inlineAction} ${styles.rowAction}`} href={makerPageHref(profileId)}>
                {claim?.mine?.status === "verified" ? "Your maker page" : "Are you the maker?"}
              </Link>
            ) : null}
          />
        ) : null}
        {entry.talk ? <CatalogRow label="You talk to it" value={entry.talk} /> : null}
        <CatalogRow
          label={computer ? "What you get" : "It can use"}
          value={uses}
          note={profileHasBrowser(profileId) ? "A browser is optional. You choose in review." : null}
        />
        {modelAccess ? <CatalogRow label="Model access" value={modelAccess} note="You choose in review." /> : null}
        <CatalogRow label="Where it runs" value={whereItRuns(profileId, selfHosted)} />
        {entry.sourceUrl ? (
          <CatalogRow
            label="Its maker's page"
            value={sourceLabel(entry.sourceUrl)}
            action={(
              <a className={`${journey.inlineAction} ${styles.rowAction}`} href={entry.sourceUrl} target="_blank" rel="noreferrer">
                Open <ArrowUpRight size={13} aria-hidden />
              </a>
            )}
          />
        ) : null}
      </div>
      {entry.firstTasks.length > 0 ? (
        <section className={journey.chooseSection} aria-labelledby="launch-starters-heading">
          <div className={journey.chooseHeading}>
            <h2 id="launch-starters-heading">Good first tasks</h2>
            <p>Copy one and give it to {name} once it opens.</p>
          </div>
          <ul className={styles.starters}>
            {entry.firstTasks.map(task => (
              <li key={task.title}>
                <span className={journey.planSummary}>
                  <strong>{task.title}</strong>
                  <small>{task.prompt}</small>
                </span>
                <CopyButton text={task.prompt} label={`Copy the task “${task.title}”`} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {related.length > 0 ? (
        <section className={journey.chooseSection} aria-labelledby="launch-related-heading">
          <div className={journey.chooseHeading}>
            <h2 id="launch-related-heading">Others for the same job</h2>
          </div>
          <div className={journey.tileGrid}>{related}</div>
        </section>
      ) : null}
      <footer className={journey.footer}>
        <button type="button" className={journey.backAction} onClick={onBack}>
          <ArrowLeft size={14} aria-hidden /> Everything you can launch
        </button>
        <button type="button" className={journey.primaryAction} data-testid="launch-catalog-review" onClick={onReview}>
          Review and launch {name} <ArrowRight size={15} aria-hidden />
        </button>
      </footer>
    </section>
  );
}
