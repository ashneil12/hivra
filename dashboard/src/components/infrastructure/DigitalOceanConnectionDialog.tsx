"use client";

import { AlertTriangle, ArrowLeft, Bot, CheckCircle2, ExternalLink, Loader2, LockKeyhole, ShieldCheck, X } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type RefObject } from "react";

import { connectDigitalOceanAccount, replaceDigitalOceanAccountToken } from "@/lib/hivra/managed-session-client";
import {
  DigitalOceanConnectionCreateSchema,
  type DigitalOceanConnectionDto,
  type DigitalOceanDeploymentTargetDto,
} from "@/lib/infrastructure/contracts";

import styles from "./Infrastructure.module.css";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

const DIGITALOCEAN_TOKENS_URL = "https://cloud.digitalocean.com/account/api/tokens";
const DIGITALOCEAN_MANAGED_AGENTS_URL = "https://cloud.digitalocean.com/managed-agents/harness-runtime";
const DIGITALOCEAN_DOCS_URL = "https://docs.digitalocean.com/products/managed-agents/";

export function DigitalOceanConnectionDialog({
  onClose,
  returnFocusRef,
  onConnected,
  replacing,
}: {
  /** When set, replace this connection's token instead of creating one. */
  replacing?: DigitalOceanConnectionDto;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onConnected: (connection: DigitalOceanConnectionDto, target: DigitalOceanDeploymentTargetDto) => void;
}) {
  const [name, setName] = useState(replacing?.name ?? "My DigitalOcean team");
  const [apiToken, setApiToken] = useState("");
  const [errors, setErrors] = useState<{ name?: string; apiToken?: string }>({});
  const [operationError, setOperationError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const nameId = useId();
  const tokenId = useId();
  const tokenHelpId = `${tokenId}-help`;
  const dialogRef = useInfrastructureDialog({ onClose, closeOnEscape: !connecting, initialFocusRef: closeButtonRef, returnFocusRef });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});
    setOperationError(null);
    const parsed = DigitalOceanConnectionCreateSchema.safeParse({
      name: name.trim(),
      provider: "digitalocean",
      operatingMode: "self-managed",
      setupMode: "simple",
      credentials: { apiToken },
    });
    if (!parsed.success) {
      const next: { name?: string; apiToken?: string } = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === "name") next.name ??= issue.message;
        if (issue.path.join(".") === "credentials.apiToken") next.apiToken ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setConnecting(true);
    try {
      const result = replacing
        ? await replaceDigitalOceanAccountToken(replacing.id, parsed.data.credentials.apiToken)
        : await connectDigitalOceanAccount(parsed.data);
      setApiToken("");
      onConnected(result.connection, result.target);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Hivra could not connect this DigitalOcean team.");
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className={styles.modalBackdrop}>
      <section
        ref={dialogRef}
        className={`${styles.wizard} ${styles.providerConnectionDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="digitalocean-connection-title"
        tabIndex={-1}
      >
        <header className={styles.wizardHeader}>
          <div>
            <span className={styles.eyebrow}>{replacing ? replacing.name : "Managed Agents · Public preview"}</span>
            <h1 id="digitalocean-connection-title">{replacing ? "Replace DigitalOcean token" : "Connect DigitalOcean"}</h1>
          </div>
          <button ref={closeButtonRef} type="button" className={styles.closeButton} onClick={onClose} disabled={connecting} aria-label="Close DigitalOcean setup">
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.wizardBody}>
          <div className={styles.providerGuide}>
            <span className={styles.providerGuideIcon} aria-hidden="true"><Bot size={20} /></span>
            <div>
              <strong>{replacing ? "Paste a new token from the same DigitalOcean team." : "Paste one token. No terminal, no doctl."}</strong>
              <p>
                {replacing
                  ? "Hivra checks that the new token can reach this connection’s agents, then swaps it in. Your agents keep running and keep their conversations."
                  : "Hivra checks the token against DigitalOcean Managed Agents, encrypts it, and then launches Claude Code, Codex, or Hermes sessions in your team from this browser."}
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <div className={styles.formSection}>
              <div className={styles.formSectionHeading}>
                <span className={styles.sectionNumber}>01</span>
                <div>
                  <h2>Enter a DigitalOcean API token</h2>
                  <p>Use a personal access token with write access to a team enrolled in Managed Agents.</p>
                </div>
              </div>
              <div className={styles.formGrid}>
                <label className={`${styles.field} ${styles.fullField}`} htmlFor={tokenId}>
                  <span className={styles.fieldLabel}>DigitalOcean personal access token</span>
                  <span className={styles.secretField}>
                    <LockKeyhole size={17} aria-hidden="true" />
                    <input
                      id={tokenId}
                      type="password"
                      value={apiToken}
                      onChange={(event) => { setApiToken(event.target.value); setErrors((current) => ({ ...current, apiToken: undefined })); }}
                      placeholder="dop_v1_…"
                      maxLength={512}
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      aria-describedby={tokenHelpId}
                      aria-invalid={Boolean(errors.apiToken)}
                      data-lpignore="true"
                      required
                    />
                  </span>
                  <span id={tokenHelpId} className={errors.apiToken ? styles.fieldError : styles.fieldHint}>
                    {errors.apiToken ?? "Encrypted before storage and never returned to this browser."}
                  </span>
                </label>
                {replacing ? null : <details className={`${styles.connectionNameDisclosure} ${styles.fullField}`}>
                  <summary>Customize connection name</summary>
                  <label className={styles.field} htmlFor={nameId}>
                    <span className={styles.fieldLabel}>Connection name</span>
                    <input
                      id={nameId}
                      value={name}
                      onChange={(event) => { setName(event.target.value); setErrors((current) => ({ ...current, name: undefined })); }}
                      maxLength={80}
                      autoComplete="off"
                      aria-invalid={Boolean(errors.name)}
                      required
                    />
                    {errors.name ? <span className={styles.fieldError}>{errors.name}</span> : null}
                  </label>
                </details>}
              </div>
            </div>

            <div className={styles.providerSafetyNote}>
              <ShieldCheck size={17} aria-hidden="true" />
              <div>
                <strong>Connecting does not start anything.</strong>
                <span>
                  Sessions bill your DigitalOcean team per active second while they run, and Managed Agents
                  needs a positive prepaid balance. Each launch is a separate step you confirm.
                </span>
              </div>
            </div>

            {operationError ? (
              <div className={styles.formError} role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <span>{operationError}</span>
              </div>
            ) : null}

            <div className={styles.wizardActions}>
              <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={connecting}>
                <ArrowLeft size={14} aria-hidden="true" /> Cancel
              </button>
              <button type="submit" className={styles.primaryButton} disabled={connecting}>
                {connecting ? <Loader2 size={15} className={styles.spin} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
                {connecting ? "Checking Managed Agents access…" : replacing ? "Replace token" : "Connect DigitalOcean"}
              </button>
            </div>
          </form>

          <details className={styles.providerHelpDisclosure}>
            <summary>
              <span>Need Managed Agents access or a token?</span>
              <small>Open the two-step guide</small>
            </summary>
            <ol className={styles.providerSteps} aria-label="DigitalOcean setup steps">
              <li>
                <span>1</span>
                <div>
                  <strong>Open Managed Agents in your team</strong>
                  <p>Managed Agents is in public preview. Open it once in the control panel and add a prepaid balance.</p>
                  <a href={DIGITALOCEAN_MANAGED_AGENTS_URL} target="_blank" rel="noreferrer">
                    Open Managed Agents <ExternalLink size={12} aria-hidden="true" /><span className={styles.srOnly}> (opens in a new tab)</span>
                  </a>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Generate a personal access token with write scope</strong>
                  <p>API → Tokens → Generate New Token. DigitalOcean shows it once; you can revoke it any time.</p>
                  <a href={DIGITALOCEAN_TOKENS_URL} target="_blank" rel="noreferrer">
                    Open API tokens <ExternalLink size={12} aria-hidden="true" /><span className={styles.srOnly}> (opens in a new tab)</span>
                  </a>
                </div>
              </li>
            </ol>
            <p><a href={DIGITALOCEAN_DOCS_URL} target="_blank" rel="noreferrer">DigitalOcean Managed Agents documentation <ExternalLink size={12} aria-hidden="true" /><span className={styles.srOnly}> (opens in a new tab)</span></a></p>
          </details>
        </div>
      </section>
    </div>
  );
}
