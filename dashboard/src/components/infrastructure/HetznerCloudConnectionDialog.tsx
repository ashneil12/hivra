"use client";

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Cloud,
  ExternalLink,
  Loader2,
  LockKeyhole,
  ShieldCheck,
  X,
} from "lucide-react";
import { useId, useRef, useState, type FormEvent, type RefObject } from "react";

import { connectHetznerCloudProject } from "@/lib/infrastructure/client";
import {
  HetznerCloudConnectionCreateSchema,
  type HetznerCloudConnectionDto,
  type HetznerCloudServerInventoryDto,
} from "@/lib/infrastructure/contracts";

import styles from "./Infrastructure.module.css";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

const HETZNER_PROJECTS_URL = "https://console.hetzner.com/projects";
const HETZNER_API_TOKEN_GUIDE_URL =
  "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/";

type HetznerCloudConnectionDialogProps = {
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onConnected: (
    connection: HetznerCloudConnectionDto,
    inventory: HetznerCloudServerInventoryDto[],
  ) => void;
};

type FieldErrors = {
  name?: string;
  apiToken?: string;
};

export function HetznerCloudConnectionDialog({
  onClose,
  returnFocusRef,
  onConnected,
}: HetznerCloudConnectionDialogProps) {
  const [name, setName] = useState("My Hetzner project");
  const [apiToken, setApiToken] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [operationError, setOperationError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const nameId = useId();
  const tokenId = useId();
  const tokenHelpId = `${tokenId}-help`;
  const dialogRef = useInfrastructureDialog({
    onClose,
    closeOnEscape: !connecting,
    initialFocusRef: closeButtonRef,
    returnFocusRef,
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});
    setOperationError(null);

    const parsed = HetznerCloudConnectionCreateSchema.safeParse({
      name: name.trim(),
      provider: "hetzner-cloud",
      operatingMode: "self-managed",
      setupMode: "simple",
      credentials: { apiToken },
    });
    if (!parsed.success) {
      const nextErrors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === "name") nextErrors.name ??= issue.message;
        if (issue.path.join(".") === "credentials.apiToken") {
          nextErrors.apiToken ??= issue.message;
        }
      }
      setErrors(nextErrors);
      return;
    }

    setConnecting(true);
    try {
      const result = await connectHetznerCloudProject(parsed.data);
      setApiToken("");
      onConnected(result.connection, result.inventory);
    } catch (error) {
      setOperationError(
        error instanceof Error
          ? error.message
          : "Hivra could not connect this Hetzner project.",
      );
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
        aria-labelledby="hetzner-connection-title"
        tabIndex={-1}
      >
        <header className={styles.wizardHeader}>
          <div>
            <span className={styles.eyebrow}>Simple mode</span>
            <h1 id="hetzner-connection-title">Connect Hetzner Cloud</h1>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            disabled={connecting}
            aria-label="Close Hetzner Cloud setup"
          >
            <X size={19} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.wizardBody}>
          <div className={styles.providerGuide}>
            <span className={styles.providerGuideIcon} aria-hidden="true">
              <Cloud size={20} />
            </span>
            <div>
              <strong>Paste one key, then choose your server.</strong>
              <p>
                Hivra validates and encrypts the project token, then loads live Hetzner
                sizes and rates. Nothing is purchased on this screen.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <div className={styles.formSection}>
              <div className={styles.formSectionHeading}>
                <span className={styles.sectionNumber}>01</span>
                <div>
                  <h2>Enter your Hetzner API key</h2>
                  <p>Use a Read &amp; Write token from the project Hivra should manage.</p>
                </div>
              </div>

              <div className={styles.formGrid}>
                <label className={`${styles.field} ${styles.fullField}`} htmlFor={tokenId}>
                  <span className={styles.fieldLabel}>Hetzner Read &amp; Write project API token</span>
                  <span className={styles.secretField}>
                    <LockKeyhole size={17} aria-hidden="true" />
                    <input
                      id={tokenId}
                      type="password"
                      value={apiToken}
                      onChange={(event) => {
                        setApiToken(event.target.value);
                        setErrors((current) => ({ ...current, apiToken: undefined }));
                      }}
                      placeholder="Paste the token shown by Hetzner"
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
                  <span
                    id={tokenHelpId}
                    className={errors.apiToken ? styles.fieldError : styles.fieldHint}
                  >
                    {errors.apiToken
                      ?? "Encrypted before storage and never returned to this browser."}
                  </span>
                </label>

                <details className={`${styles.connectionNameDisclosure} ${styles.fullField}`}>
                  <summary>Customize connection name</summary>
                  <label className={styles.field} htmlFor={nameId}>
                    <span className={styles.fieldLabel}>Connection name</span>
                    <input
                      id={nameId}
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setErrors((current) => ({ ...current, name: undefined }));
                      }}
                      maxLength={80}
                      autoComplete="off"
                      aria-invalid={Boolean(errors.name)}
                      required
                    />
                    {errors.name ? <span className={styles.fieldError}>{errors.name}</span> : null}
                  </label>
                </details>
              </div>
            </div>

            <div className={styles.providerSafetyNote}>
              <ShieldCheck size={17} aria-hidden="true" />
              <div>
                <strong>Connecting does not charge you.</strong>
                <span>
                  The token can change this project, but Hivra asks again after showing a
                  fresh quote before it creates a billable server.
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
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={onClose}
                disabled={connecting}
              >
                <ArrowLeft size={14} aria-hidden="true" /> Cancel
              </button>
              <button type="submit" className={styles.primaryButton} disabled={connecting}>
                {connecting ? (
                  <Loader2 size={15} className={styles.spin} aria-hidden="true" />
                ) : (
                  <CheckCircle2 size={15} aria-hidden="true" />
                )}
                {connecting ? "Validating project…" : "Connect and choose a server"}
              </button>
            </div>
          </form>

          <details className={styles.providerHelpDisclosure}>
            <summary>
              <span>Need a Hetzner project or API token?</span>
              <small>Open the two-step guide</small>
            </summary>
            <ol className={styles.providerSteps} aria-label="Hetzner project setup steps">
              <li>
                <span>1</span>
                <div>
                  <strong>Create or choose a project</strong>
                  <p>A separate Hivra project keeps its servers and token easy to revoke.</p>
                  <a href={HETZNER_PROJECTS_URL} target="_blank" rel="noreferrer">
                    Open Hetzner projects <ExternalLink size={12} aria-hidden="true" />
                    <span className={styles.srOnly}> (opens in a new tab)</span>
                  </a>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Generate a Read &amp; Write API token</strong>
                  <p>
                    Open Security → API tokens in that project. Hetzner displays the full
                    token once, and you can revoke it at any time.
                  </p>
                  <a href={HETZNER_API_TOKEN_GUIDE_URL} target="_blank" rel="noreferrer">
                    Follow Hetzner&apos;s token guide <ExternalLink size={12} aria-hidden="true" />
                    <span className={styles.srOnly}> (opens in a new tab)</span>
                  </a>
                </div>
              </li>
            </ol>
          </details>
        </div>
      </section>
    </div>
  );
}
