"use client";

import { useId } from "react";

import { TOKEN_EXPIRY_CHOICES, todayDateString, type TokenExpiryChoice } from "@/lib/infrastructure/token-expiry";

import styles from "./Infrastructure.module.css";

/**
 * "When does this token expire?" DigitalOcean does not tell Hivra, so the
 * owner says, and Hivra reminds them a week before. "Not sure" records nothing.
 */
export function TokenExpiryField({
  choice,
  date,
  onChange,
  disabled,
  error,
}: {
  choice: TokenExpiryChoice;
  date: string;
  onChange: (next: { choice: TokenExpiryChoice; date: string }) => void;
  disabled?: boolean;
  error?: string | null;
}) {
  const selectId = useId();
  const dateId = useId();
  const hintId = `${selectId}-hint`;
  return (
    <div className={`${styles.field} ${styles.fullField}`}>
      <label className={styles.fieldLabel} htmlFor={selectId}>When does this token expire?</label>
      <select
        id={selectId}
        value={choice}
        disabled={disabled}
        aria-describedby={hintId}
        onChange={(event) => onChange({ choice: event.target.value as TokenExpiryChoice, date })}
      >
        {TOKEN_EXPIRY_CHOICES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {choice === "date" ? (
        <>
          <label className={styles.srOnly} htmlFor={dateId}>Expiry date</label>
          <input
            id={dateId}
            type="date"
            value={date}
            min={todayDateString()}
            disabled={disabled}
            aria-invalid={Boolean(error)}
            onChange={(event) => onChange({ choice, date: event.target.value })}
          />
        </>
      ) : null}
      <span id={hintId} className={error ? styles.fieldError : styles.fieldHint}>
        {error ?? "Pick what you chose in DigitalOcean. Hivra reminds you a week before it stops working."}
      </span>
    </div>
  );
}
