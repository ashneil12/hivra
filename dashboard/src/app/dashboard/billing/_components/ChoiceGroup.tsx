'use client';

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import styles from "../Billing.module.css";

/**
 * A segmented single choice (radiogroup), for choices that filter what the
 * page shows — cadence, payment method, $HermesOS mode. These are not tabs:
 * they do not own panels. Arrow keys move and select, like native radios;
 * only the checked option is in the Tab order.
 */
export function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** Accessible name of the group. */
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; icon?: ReactNode }>;
  onChange: (value: T) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedIndex = options.findIndex((option) => option.value === value);

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = options.length;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % count;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    onChange(options[next].value);
  }

  return (
    <div role="radiogroup" aria-label={label} className={styles.choice}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (checkedIndex === -1 && index === 0) ? 0 : -1}
            className={styles.choiceOption}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
