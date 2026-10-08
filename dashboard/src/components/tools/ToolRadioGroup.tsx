// A labelled radio group for the tool inputs. Same markup and classes as the
// survival check's own group, so the tools look alike.

import styles from "@/app/tools/tools.module.css";

export interface RadioOption<T extends string> {
  value: T;
  label: string;
}

export default function ToolRadioGroup<T extends string>({
  name,
  label,
  options,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: RadioOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className={styles.fieldset}>
      <legend className={styles.legend}>{label}</legend>
      <div className={styles.radios}>
        {options.map((option) => (
          <label key={option.value} className={styles.radio} data-checked={value === option.value}>
            <input type="radio" name={name} checked={value === option.value} onChange={() => onChange(option.value)} />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
