"use client";

// A maker's own page for a catalog entry. Until their claim is proven it
// walks them through proving it: a file in the project's repository holding a
// line Hivra gave them. After that it shows how the agent is used on Hivra, a
// launch button for their README, and that earnings are not turned on.
// Reached from the entry's page in Launch; off unless maker claims are turned on.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";

import {
  catalogPageHref,
  type CatalogClaimView,
  type ClaimCheckResult,
  type MakerNumbers,
} from "@/lib/hivra/catalog-claim-types";
import { PROFILE_DETAILS, type LaunchProfileId } from "@/lib/launch/contracts";

import { fetchCatalogClaim, sendCatalogClaim } from "./catalog-claims-client";
import { CatalogRow, CopyButton } from "./LaunchCatalog";
import journey from "./LaunchJourney.module.css";
import styles from "./LaunchCatalog.module.css";

const LAUNCH_BUTTON_IMAGE = "/images/launch-on-hivra.svg";

const CHECK_WORDS: Record<ClaimCheckResult, string> = {
  verified: "Found",
  file_missing: "Not found yet",
  line_missing: "The file is there, but this line is not in it",
  unreachable: "GitHub did not answer. Try again in a minute.",
};

const GIVES: readonly (readonly [string, string])[] = [
  ["Your numbers", "See how people launch it and keep using it."],
  ["A launch button", "Put Launch on Hivra in your README and on your site."],
  ["Earnings, later", "When Hivra turns on maker earnings, they go to whoever holds the claim."],
];

const KEEPS: readonly (readonly [string, string])[] = [
  ["The order", "It comes from use. It cannot be bought or edited."],
  ["Fit badges", "Hivra works out what fits each person's plan."],
];

const whole = (value: number) => value.toLocaleString("en-US");

function Facts({ id, title, items }: { id: string; title: string; items: readonly (readonly [string, string])[] }) {
  return (
    <section className={journey.chooseSection} aria-labelledby={id}>
      <div className={journey.chooseHeading}><h2 id={id}>{title}</h2></div>
      <dl className={styles.facts}>
        {items.map(([term, words]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{words}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ClaimSteps({ claim, name, busy, problem, onStart, onCheck, backHref }: {
  claim: CatalogClaimView;
  name: string;
  busy: boolean;
  problem: string | null;
  onStart: () => void;
  onCheck: () => void;
  backHref: string;
}) {
  const mine = claim.mine;
  return (
    <>
      {mine ? (
        <div className={journey.planCard} role="group" aria-label="How to prove it">
          <CatalogRow
            label="Add this file"
            value={<code className={styles.code}>{claim.filePath}</code>}
            note={`On the default branch of github.com/${claim.repo}, containing the line below.`}
          />
          <CatalogRow
            label="With this line"
            value={<code className={styles.code}>{mine.line}</code>}
            action={<CopyButton text={mine.line} label="Copy the line" />}
          />
          <CatalogRow
            label="Status"
            value={<span role="status">{busy ? "Checking…" : mine.lastCheck ? CHECK_WORDS[mine.lastCheck] : "Not checked yet"}</span>}
            note="Hivra looks for the file when you press Check. A new file can take a few minutes to show."
          />
        </div>
      ) : (
        <div className={journey.planCard} role="group" aria-label="How to prove it">
          <CatalogRow
            label="How it works"
            value={`Hivra gives you a line to add to a file in github.com/${claim.repo}.`}
            note="Only someone who can change that repository can do it, so the line does not need to stay secret."
          />
        </div>
      )}
      {problem ? <p className={styles.empty} role="alert">{problem}</p> : null}
      <Facts id="maker-gives-heading" title="What claiming gives you" items={GIVES} />
      <Facts id="maker-keeps-heading" title="What stays out of your hands" items={KEEPS} />
      <footer className={journey.footer}>
        <Link className={journey.backAction} href={backHref}>
          <ArrowLeft size={14} aria-hidden /> {name}&apos;s page
        </Link>
        <button type="button" className={journey.primaryAction} disabled={busy} onClick={mine ? onCheck : onStart}>
          {mine ? "Check now" : "Get my line"} <ArrowRight size={15} aria-hidden />
        </button>
      </footer>
    </>
  );
}

function keptWords(numbers: MakerNumbers): { value: string; note: string } {
  if (numbers.twoWeekLaunches === 0) return { value: "Not enough launches yet", note: "Counted once an agent has had its first two weeks." };
  const percent = Math.round((numbers.twoWeekKept / numbers.twoWeekLaunches) * 100);
  return { value: `${percent}%`, note: `${whole(numbers.twoWeekKept)} of ${whole(numbers.twoWeekLaunches)} launched earlier.` };
}

function MakerNumbersView({ profileId, name, numbers, backHref }: {
  profileId: LaunchProfileId;
  name: string;
  numbers: MakerNumbers;
  backHref: string;
}) {
  // Read once the page is in the browser, so the snippet carries this site's own address.
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const snippet = `[![Launch on Hivra](${origin}${LAUNCH_BUTTON_IMAGE})](${origin}${catalogPageHref(profileId)})`;
  const kept = keptWords(numbers);
  return (
    <>
      <section className={journey.chooseSection} aria-labelledby="maker-numbers-heading">
        <div className={journey.chooseHeading}><h2 id="maker-numbers-heading">Last {numbers.days} days</h2></div>
        <div className={`${journey.planCard} ${styles.flushCard}`} role="group" aria-label={`${name} in the last ${numbers.days} days`}>
          <CatalogRow label="People using it" value={whole(numbers.people)} />
          <CatalogRow label="Launches" value={whole(numbers.launches)} />
          <CatalogRow label="Still running after two weeks" value={kept.value} note={kept.note} />
          <CatalogRow label="Hours in use" value={whole(numbers.activeHours)} />
          <CatalogRow label="Running now" value={whole(numbers.runningNow)} />
        </div>
      </section>
      <section className={journey.chooseSection} aria-labelledby="maker-button-heading">
        <div className={journey.chooseHeading}>
          <h2 id="maker-button-heading">A launch button for your README</h2>
          <p>One press takes people from your repository to {name}&apos;s page on Hivra.</p>
        </div>
        <div className={styles.launchButton}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the same file a README would show */}
          <img src={LAUNCH_BUTTON_IMAGE} alt="Launch on Hivra" width={164} height={34} />
          <code className={styles.code}>{snippet}</code>
          <CopyButton text={snippet} label="Copy the launch button" />
        </div>
      </section>
      <section className={journey.chooseSection} aria-labelledby="maker-earnings-heading">
        <div className={journey.chooseHeading}>
          <h2 id="maker-earnings-heading">Earnings</h2>
          <p>When Hivra turns on maker earnings, your share is worked out from hours in use. There is nothing to set up until then.</p>
        </div>
        <div className={`${journey.planCard} ${styles.flushCard}`} role="group" aria-label="Earnings">
          <CatalogRow label="Status" value="Not turned on yet" />
          <CatalogRow label={`Hours that would count, last ${numbers.days} days`} value={whole(numbers.activeHours)} />
        </div>
      </section>
      {/* Nothing to press here, so no bar that stays on screen as the journey's footer does on a phone. */}
      <nav className={styles.backRow} aria-label="Back">
        <Link className={journey.backAction} href={backHref}>
          <ArrowLeft size={14} aria-hidden /> {name}&apos;s page
        </Link>
      </nav>
    </>
  );
}

export function MakerPage({ profileId }: { profileId: LaunchProfileId }) {
  const name = PROFILE_DETAILS[profileId].name;
  const backHref = catalogPageHref(profileId);
  // What the server said, for which try. A try that has not answered yet is still loading.
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ attempt: number; claim: CatalogClaimView | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCatalogClaim(profileId, controller.signal).then(next => {
      if (!controller.signal.aborted) setAnswer({ attempt, claim: next });
    });
    return () => controller.abort();
  }, [profileId, attempt]);

  const loaded = answer?.attempt === attempt;
  const claim = loaded ? answer.claim : null;
  const setClaim = (next: CatalogClaimView) => setAnswer({ attempt, claim: next });

  const verified = claim?.mine?.status === "verified" && claim.numbers !== null;
  useEffect(() => {
    // Announce the page once it has something to say, and again when the claim is proven.
    if (loaded) headingRef.current?.focus();
  }, [loaded, verified]);

  const act = async (action: "start" | "check") => {
    setBusy(true);
    setProblem(null);
    const next = await sendCatalogClaim(profileId, action);
    setBusy(false);
    if (next) setClaim(next);
    else setProblem(action === "start" ? "Could not get your line. Try again." : "Could not check just now. Try again in a minute.");
  };

  return (
    <main className={journey.page} data-testid="maker-page">
      <header className={journey.header}>
        <span className={journey.brand}>Makers</span>
      </header>
      <section className={journey.stage} aria-labelledby="maker-heading">
        {!loaded ? (
          <p className={styles.empty} role="status">Loading…</p>
        ) : !claim || !claim.repo ? (
          <p className={styles.empty} role="alert">
            Could not load this page.{" "}
            <button type="button" className={journey.inlineAction} onClick={() => setAttempt(current => current + 1)}>Try again</button>
          </p>
        ) : verified && claim.numbers ? (
          <>
            <div className={journey.stageIntro}>
              <span className={journey.eyebrow}>Claimed by you</span>
              <h1 id="maker-heading" ref={headingRef} tabIndex={-1}>{name}</h1>
              <p>How people launch it and keep using it on Hivra.</p>
            </div>
            <MakerNumbersView profileId={profileId} name={name} numbers={claim.numbers} backHref={backHref} />
          </>
        ) : (
          <>
            <div className={journey.stageIntro}>
              <span className={journey.eyebrow}>Claim a page</span>
              <h1 id="maker-heading" ref={headingRef} tabIndex={-1}>Do you make {name}?</h1>
              <p>Prove you control the project and you can see how people use it on Hivra. It takes a few minutes.</p>
            </div>
            <ClaimSteps
              claim={claim}
              name={name}
              busy={busy}
              problem={problem}
              onStart={() => void act("start")}
              onCheck={() => void act("check")}
              backHref={backHref}
            />
          </>
        )}
      </section>
    </main>
  );
}
