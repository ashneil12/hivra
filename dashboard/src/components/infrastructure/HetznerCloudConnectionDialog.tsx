"use client";

import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Cloud,
  ExternalLink,
  KeyRound,
  Loader2,
  LockKeyhole,
  ShieldCheck,
  X,
} from "lucide-react";
import { useId, useRef, useState, type FormEvent, type RefObject } from "react";

import {
  connectHetznerCloudProject,
  InfrastructureApiError,
  replaceHetznerCloudToken,
  type HetznerCloudTokenReplaceOutcome,
} from "@/lib/infrastructure/client";
import {
  HetznerCloudConnectionCreateSchema,
  type HetznerCloudConnectionDto,
  type HetznerCloudServerInventoryDto,
} from "@/lib/infrastructure/contracts";
import { hetznerStrayWriteCheckKeyMessage } from "@/lib/infrastructure/hetzner-cloud-token-contracts";

import styles from "./Infrastructure.module.css";
import { useInfrastructureDialog } from "./useInfrastructureDialog";

const HETZNER_PROJECTS_URL = "https://console.hetzner.com/projects";
const HETZNER_API_TOKEN_GUIDE_URL =
  "https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/";

type DialogBaseProps = {
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

type HetznerCloudConnectionDialogProps = DialogBaseProps & (
  | {
      replacing?: undefined;
      onConnected: (
        connection: HetznerCloudConnectionDto,
        inventory: HetznerCloudServerInventoryDto[],
      ) => void;
    }
  | {
      /** Replace this project's token instead of connecting a new one. */
      replacing: HetznerCloudConnectionDto;
      onReplaced: (result: HetznerCloudTokenReplaceOutcome) => void;
      /** The token was saved but not confirmed; re-read the connection. */
      onReplaceUnconfirmed?: () => void;
    }
);

type FieldErrors = {
  name?: string;
  apiToken?: string;
};

type Connected = {
  name: string;
  strayKeyName: string;
  finish: () => void;
};

export function HetznerCloudConnectionDialog(props: HetznerCloudConnectionDialogProps) {
  const { replacing, onClose, returnFocusRef } = props;
  const [name, setName] = useState(replacing?.name ?? "My Hetzner project");
  const [apiToken, setApiToken] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [operationError, setOperationError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState<Connected | null>(null);
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
      let finish: () => void;
      let strayKeyName: string | null;
      let savedName: string;
      if (props.replacing) {
        const result = await replaceHetznerCloudToken(props.replacing.id, parsed.data.credentials.apiToken);
        const { onReplaced } = props;
        finish = () => onReplaced(result);
        strayKeyName = result.writeCheck.strayKeyName;
        savedName = result.connection.name;
      } else {
        const result = await connectHetznerCloudProject(parsed.data);
        const { onConnected } = props;
        finish = () => onConnected(result.connection, result.inventory);
        strayKeyName = result.writeCheck.strayKeyName;
        savedName = result.connection.name;
      }
      setApiToken("");
      if (strayKeyName) {
        // Write access is proven, but a test key is left in the project. Say so
        // before moving on instead of hiding it.
        setConnected({ name: savedName, strayKeyName, finish });
        return;
      }
      finish();
    } catch (error) {
      if (props.replacing && error instanceof InfrastructureApiError && error.code === "replaced_unconfirmed") {
        // The swap happened; the page re-reads what the connection holds now.
        setApiToken("");
        props.onReplaceUnconfirmed?.();
      }
      setOperationError(
        error instanceof Error
          ? error.message
          : replacing
            ? "Hivra couldn't replace this project's token."
            : "Hivra couldn't connect this Hetzner project.",
      );
    } finally {
      setConnecting(false);
    }
  }

  const title = replacing ? "Replace Hetzner token" : "Connect Hetzner Cloud";

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
            <span className={styles.eyebrow}>{replacing ? replacing.name : "My cloud"}</span>
            <h1 id="hetzner-connection-title">{title}</h1>
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
          {connected ? (
            <div className={styles.capacityResult}>
              <div className={`${styles.capacityResultHero} ${styles.capacityResult_warning}`} role="status">
                <span aria-hidden="true"><CheckCircle2 size={24} /></span>
                <div>
                  <span className={styles.sectionLabel}>{connected.name}</span>
                  <h2>{replacing ? "Token replaced." : "Project connected."}</h2>
                  <p>{hetznerStrayWriteCheckKeyMessage(connected.strayKeyName)}</p>
                </div>
              </div>
              <div className={styles.resultActions}>
                <a className={styles.secondaryButton} href={HETZNER_PROJECTS_URL} target="_blank" rel="noreferrer">
                  Open Hetzner Console <ExternalLink size={13} aria-hidden="true" />
                  <span className={styles.srOnly}> (opens in a new tab)</span>
                </a>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={connected.finish}
                >
                  Continue
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate>
              <ol className={`${styles.providerSteps} ${styles.providerStepsInline}`} aria-label="Hetzner token steps">
                <li>
                  <span>1</span>
                  <div>
                    <strong>{replacing ? "Open the same project" : "Create or choose a project"}</strong>
                    <p>
                      {replacing
                        ? "Use the Hetzner project this connection already manages."
                        : "A separate project for Hivra keeps its servers and token easy to find and revoke."}
                    </p>
                    <a href={HETZNER_PROJECTS_URL} target="_blank" rel="noreferrer">
                      Hetzner Console → Projects <ExternalLink size={12} aria-hidden="true" />
                      <span className={styles.srOnly}> (opens in a new tab)</span>
                    </a>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <strong>Generate a Read &amp; Write API token</strong>
                    <p>Security → API tokens → Generate. Choose Read &amp; Write. Hetzner shows the token once.</p>
                    <a href={HETZNER_API_TOKEN_GUIDE_URL} target="_blank" rel="noreferrer">
                      Hetzner&apos;s token guide <ExternalLink size={12} aria-hidden="true" />
                      <span className={styles.srOnly}> (opens in a new tab)</span>
                    </a>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <strong>Paste it here</strong>
                    <p>Hivra encrypts it and never shows it back to this browser.</p>
                  </div>
                </li>
              </ol>

              <div className={styles.formSection}>
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

                  {replacing ? null : (
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
                  )}
                </div>
              </div>

              <div className={styles.providerSafetyNote}>
                <ShieldCheck size={17} aria-hidden="true" />
                <div>
                  <strong>{replacing ? "Your servers keep running. Nothing is bought." : "Connecting doesn't buy anything."}</strong>
                  <span>
                    {replacing
                      ? "Hivra checks that the new token can see the servers and keys it created in this project, then adds and removes a test SSH key named hivra-check to confirm it can write. The old token is swapped out; setup keys and servers carry over."
                      : "Hivra checks the token by listing your servers and adding, then removing, a test SSH key named hivra-check. Servers are only created after you review a price."}
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
                  ) : replacing ? (
                    <KeyRound size={15} aria-hidden="true" />
                  ) : (
                    <Cloud size={15} aria-hidden="true" />
                  )}
                  {connecting
                    ? "Checking the token…"
                    : replacing
                      ? "Replace token"
                      : "Connect and choose a server"}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
