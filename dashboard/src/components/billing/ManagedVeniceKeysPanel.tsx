'use client';

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";

import { CopyButton } from "@/components/billing/TransferDetails";
import styles from "./ManagedVeniceKeysPanel.module.css";

export interface ManagedVeniceKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  status: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function isRevoked(key: ManagedVeniceKeySummary) {
  return key.status === "revoked" || Boolean(key.revokedAt);
}

function formatDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function keyMeta(key: ManagedVeniceKeySummary) {
  const parts: string[] = [];
  const created = formatDate(key.createdAt);
  if (created) parts.push(`Created ${created}`);
  if (isRevoked(key)) {
    const revoked = formatDate(key.revokedAt);
    if (revoked) parts.push(`Revoked ${revoked}`);
  } else {
    const lastUsed = formatDate(key.lastUsedAt);
    parts.push(lastUsed ? `Last used ${lastUsed}` : "Never used");
  }
  return parts.join(" · ");
}

function KeyRow({ keySummary, revoked = false }: { keySummary: ManagedVeniceKeySummary; revoked?: boolean }) {
  const meta = keyMeta(keySummary);
  const tone = keySummary.status === "active" || keySummary.status === "paused" ? keySummary.status : undefined;
  return (
    <li className={revoked ? `${styles.row} ${styles.revokedRow}` : styles.row}>
      <span className={styles.name}>{keySummary.name}</span>
      <code className={`notranslate ${styles.prefix}`} translate="no">
        {keySummary.keyPrefix}...
      </code>
      <span className={styles.status} data-tone={tone}>
        {keySummary.status}
      </span>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
    </li>
  );
}

export function ManagedVeniceKeysPanel(props: {
  keys: ManagedVeniceKeySummary[];
  createdPlaintextKey?: string | null;
}) {
  const [showRevoked, setShowRevoked] = useState(false);
  const revokedListId = useId();
  const liveKeys = props.keys.filter((key) => !isRevoked(key));
  const revokedKeys = props.keys.filter(isRevoked);
  const revokedCount = revokedKeys.length;

  return (
    <section className={styles.panel} aria-labelledby={`${revokedListId}-title`}>
      <span className={`mono ${styles.eyebrow}`}>Keys your agents use for model credits</span>
      <h3 id={`${revokedListId}-title`} className={`serif ${styles.title}`}>
        API access
      </h3>

      {props.createdPlaintextKey && (
        <div className={styles.created}>
          <span className={styles.createdNote}>Shown once. Store it before leaving this page.</span>
          <code className={`notranslate ${styles.secret}`} translate="no">
            {props.createdPlaintextKey}
          </code>
          <div>
            <CopyButton value={props.createdPlaintextKey} label="Copy key" />
          </div>
        </div>
      )}

      {props.keys.length === 0 ? (
        <p className={styles.empty}>No model-credit keys yet.</p>
      ) : (
        <>
          {liveKeys.length > 0 ? (
            <ul className={styles.list} aria-label="Keys">
              {liveKeys.map((key) => (
                <KeyRow key={key.id} keySummary={key} />
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>No active keys.</p>
          )}

          {revokedCount > 0 && (
            <>
              <button
                type="button"
                className={styles.revokedToggle}
                aria-expanded={showRevoked}
                aria-controls={revokedListId}
                onClick={() => setShowRevoked((open) => !open)}
              >
                {showRevoked
                  ? `Hide revoked ${revokedCount === 1 ? "key" : "keys"}`
                  : `Show ${revokedCount} revoked ${revokedCount === 1 ? "key" : "keys"}`}
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              <ul id={revokedListId} className={styles.list} aria-label="Revoked keys" hidden={!showRevoked}>
                {showRevoked &&
                  revokedKeys.map((key) => <KeyRow key={key.id} keySummary={key} revoked />)}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
