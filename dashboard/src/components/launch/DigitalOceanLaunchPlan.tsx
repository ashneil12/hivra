"use client";

import { useEffect, useId, useState } from "react";

import { useDigitalOceanBalance, DIGITALOCEAN_BILLING_URL } from "@/components/infrastructure/useDigitalOceanBalance";
import { formatDigitalOceanBalance, listDigitalOceanModels } from "@/lib/hivra/managed-session-client";
import { DIGITALOCEAN_HARNESS_LABELS } from "@/lib/hivra/managed-session-contracts";
import type { DigitalOceanDeploymentTargetDto, DigitalOceanHarness } from "@/lib/infrastructure/contracts";
import type { LaunchDigitalOceanChoice } from "@/lib/launch/contracts";
import {
  digitalOceanSizeFor,
  digitalOceanSizeLabel,
  digitalOceanVendorKey,
  effectiveDigitalOceanModelMode,
} from "@/lib/launch/digitalocean-launch";

import journeyStyles from "./LaunchJourney.module.css";
import styles from "./ModelAccessControl.module.css";

/** What DigitalOcean last said about the team's prepaid Managed Agents balance. */
export function digitalOceanBalanceProblem(
  balance: ReturnType<typeof useDigitalOceanBalance>["balance"],
): string | null {
  if (balance?.state === "blocked") {
    return `DigitalOcean is blocking new sessions for this team (prepaid balance ${formatDigitalOceanBalance(balance.balance)}). Add funds in DigitalOcean, then check again.`;
  }
  return null;
}

/**
 * The plan rows for a Launch agent that runs on the owner's DigitalOcean team:
 * the sandbox size, how it reaches a model, and what DigitalOcean bills. The
 * key typed here stays in the page's memory for this launch only.
 */
export function DigitalOceanLaunchPlan({
  target,
  harness,
  agentName,
  choice,
  onChange,
  pastedKey,
  onPastedKeyChange,
  problem,
  balance,
}: {
  target: DigitalOceanDeploymentTargetDto;
  harness: DigitalOceanHarness;
  agentName: string;
  choice: LaunchDigitalOceanChoice;
  onChange: (next: Partial<LaunchDigitalOceanChoice>) => void;
  pastedKey: string;
  onPastedKeyChange: (value: string) => void;
  problem: string | null;
  balance: ReturnType<typeof useDigitalOceanBalance>;
}) {
  const id = useId();
  const vendorKey = digitalOceanVendorKey(harness);
  const mode = effectiveDigitalOceanModelMode(harness, choice);
  const size = digitalOceanSizeFor(target, choice);
  const name = agentName.trim() || DIGITALOCEAN_HARNESS_LABELS[harness].name;
  // The model list DigitalOcean last returned, and for which team. Anything
  // else while Inference is chosen is still loading.
  const [read, setRead] = useState<{ connectionId: string; state: "ready" | "failed"; ids: string[]; error?: string } | null>(null);
  const wantModels = mode === "digitalocean-inference";
  const models = read && read.connectionId === target.connectionId
    ? read
    : { state: wantModels ? "loading" as const : "idle" as const, ids: [] as string[], error: undefined };

  // DigitalOcean's model list, read once Inference is chosen for this team.
  const alreadyRead = read?.connectionId === target.connectionId;
  useEffect(() => {
    if (!wantModels || alreadyRead) return;
    const controller = new AbortController();
    const connectionId = target.connectionId;
    listDigitalOceanModels(connectionId, controller.signal)
      .then((ids) => setRead({ connectionId, state: "ready", ids }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setRead({ connectionId, state: "failed", ids: [], error: cause instanceof Error ? cause.message : "DigitalOcean's model list could not be loaded." });
      });
    return () => controller.abort();
  }, [wantModels, alreadyRead, target.connectionId]);

  const balanceLine = balance.checking && !balance.balance
    ? "Checking this team's prepaid balance…"
    : balance.balance?.state === "ok"
      ? `Prepaid balance ${formatDigitalOceanBalance(balance.balance.balance)}${balance.balance.autoPrepay ? " · auto top-up on" : ""}.`
      : balance.balance?.state === "empty"
        ? "This team's prepaid Managed Agents balance is empty. DigitalOcean may refuse the sandbox until you add funds."
        : balance.balance?.state === "blocked"
          ? null
          : "Hivra couldn't read this team's prepaid balance. DigitalOcean still decides whether the sandbox starts.";

  return (
    <>
      <div className={journeyStyles.planRow}>
        <span className={journeyStyles.planLabel}>Size</span>
        <span className={journeyStyles.planValue}>
          <span className={styles.field}>
            <label htmlFor={`${id}-size`}>Sandbox size</label>
            <select id={`${id}-size`} value={size?.slug ?? ""} onChange={(event) => onChange({ size: event.target.value as LaunchDigitalOceanChoice["size"] })}>
              {target.capacity.sizes.map((option) => (
                <option key={option.slug} value={option.slug}>{digitalOceanSizeLabel(option)}</option>
              ))}
            </select>
            <small>DigitalOcean runs {name} in its own sandbox with a /workspace folder. No browser or desktop.</small>
          </span>
        </span>
      </div>

      <div className={journeyStyles.planRow}>
        <span className={journeyStyles.planLabel} aria-hidden>Model access</span>
        <span className={journeyStyles.planValue}>
          <div className={styles.control}>
            <div className={styles.options} role="group" aria-label="Model access">
              <div className={styles.option}>
                <button type="button" aria-pressed={mode === "vendor"} disabled={!vendorKey} onClick={() => onChange({ modelMode: "vendor" })}>
                  <strong>{vendorKey ? `Use my ${vendorKey}` : "Use my provider key"}</strong>
                  <small>{vendorKey
                    ? `${DIGITALOCEAN_HARNESS_LABELS[harness].name} signs in with it. Your provider bills its model usage.`
                    : `Not available for ${DIGITALOCEAN_HARNESS_LABELS[harness].name} on DigitalOcean. It uses DigitalOcean Inference.`}</small>
                </button>
              </div>
              <div className={styles.option}>
                <button type="button" aria-pressed={mode === "digitalocean-inference"} onClick={() => onChange({ modelMode: "digitalocean-inference" })}>
                  <strong>DigitalOcean Inference</strong>
                  <small>A model DigitalOcean serves, billed to this same team.</small>
                </button>
              </div>
              <div className={styles.option}>
                <button type="button" aria-pressed={false} disabled>
                  <strong>Sign in after it opens, or Hivra credits</strong>
                  <small>Not available on DigitalOcean: its sandbox needs a key when it starts.</small>
                </button>
              </div>
            </div>
            <div className={styles.details}>
              <div className={styles.field}>
                <label htmlFor={`${id}-key`}>{mode === "vendor" ? vendorKey : "DigitalOcean model access key"}</label>
                <input
                  id={`${id}-key`}
                  type="password"
                  value={pastedKey}
                  maxLength={512}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  data-ph-no-capture="true"
                  className="ph-no-capture"
                  placeholder={mode === "vendor" ? `Paste your ${vendorKey}` : "Paste a model access key"}
                  onChange={(event) => onPastedKeyChange(event.target.value)}
                />
                <small>Sent to DigitalOcean as a write-only secret for {name}&apos;s sandbox. Hivra doesn&apos;t store it, and it isn&apos;t kept in this browser.</small>
              </div>
              {mode === "digitalocean-inference" ? (
                <div className={styles.field}>
                  <label htmlFor={`${id}-model`}>DigitalOcean model</label>
                  {models.state === "ready" && models.ids.length > 0 ? (
                    <select id={`${id}-model`} value={choice.model} onChange={(event) => onChange({ model: event.target.value })}>
                      {!choice.model ? <option value="" disabled>Choose a model</option> : null}
                      {models.ids.map((model) => <option key={model} value={model}>{model}</option>)}
                    </select>
                  ) : (
                    <input
                      id={`${id}-model`}
                      value={choice.model}
                      maxLength={128}
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="model slug"
                      onChange={(event) => onChange({ model: event.target.value.trim() })}
                    />
                  )}
                  <small>{models.state === "loading"
                    ? "Loading DigitalOcean's models…"
                    : models.state === "failed"
                      ? `${models.error ?? "DigitalOcean's model list could not be loaded."} Type the model slug instead.`
                      : "The model it uses. DigitalOcean bills its usage to this team."}</small>
                </div>
              ) : null}
            </div>
            {problem ? <p className={styles.problem} role="status">{problem}</p> : null}
          </div>
        </span>
      </div>

      <div className={journeyStyles.planRow}>
        <span className={journeyStyles.planLabel}>Cost</span>
        <span className={journeyStyles.planValue}>
          <span className={journeyStyles.planSummary}>
            <strong>DigitalOcean bills this sandbox per second while it runs, to your team.</strong>
            {balanceLine ? <small>{balanceLine}{" "}
              <a className={journeyStyles.inlineAction} href={DIGITALOCEAN_BILLING_URL} target="_blank" rel="noreferrer">DigitalOcean billing</a>
              {" "}
              <button type="button" className={journeyStyles.inlineAction} onClick={balance.recheck} disabled={balance.checking}>Check again</button>
            </small> : null}
          </span>
        </span>
      </div>
      <div className={journeyStyles.planRow}>
        <span className={journeyStyles.planLabel}>What it can use</span>
        <span className={journeyStyles.planValue}>
          <span className={journeyStyles.planSummary}>
            <strong>Its own DigitalOcean sandbox and /workspace. Chat and files through Hivra. No browser, desktop or terminal.</strong>
          </span>
        </span>
      </div>
    </>
  );
}
