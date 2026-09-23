"use client";

import { useId, useState } from "react";

import { checkTokenAddress, type ConversionState, type TokenAddressCheck } from "@/lib/claim/conversion-state";

const RESULT_COPY: Record<TokenAddressCheck["kind"], { tone: "ok" | "warn" | "neutral"; text: string }> = {
  invalid: {
    tone: "neutral",
    text: "That is not a full Base contract address. Paste the whole address, starting with 0x.",
  },
  hermesos: {
    tone: "ok",
    text: "This is the official $HermesOS contract.",
  },
  hivra: {
    tone: "ok",
    text: "This is the official $HIVRA contract.",
  },
  "hivra-not-launched": {
    tone: "warn",
    text: "This is not a Hivra token. $HIVRA has not launched, so any token using the Hivra name today is not from Hivra.",
  },
  "not-official": {
    tone: "warn",
    text: "This is not a Hivra token. It does not match the official $HIVRA or $HermesOS contract.",
  },
};

const TONE_COLOR = {
  ok: "var(--green)",
  warn: "var(--red)",
  neutral: "var(--text-secondary)",
} as const;

export function TokenAddressChecker({ state }: { state: ConversionState }) {
  const inputId = useId();
  const [value, setValue] = useState("");
  const [result, setResult] = useState<TokenAddressCheck | null>(null);
  const copy = result ? RESULT_COPY[result.kind] : null;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setResult(checkTokenAddress(value, state));
      }}
      style={{ display: "grid", gap: 10 }}
    >
      <label htmlFor={inputId} style={{ fontSize: 14 }}>
        Contract address
      </label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <input
          id={inputId}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setResult(null);
          }}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          style={{
            flex: "1 1 260px",
            minWidth: 0,
            padding: "10px 12px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 13,
            border: "1px solid var(--etched-border)",
            borderRadius: 8,
            background: "transparent",
            color: "inherit",
          }}
        />
        <button
          type="submit"
          style={{
            padding: "10px 16px",
            border: "1px solid var(--etched-border)",
            borderRadius: 8,
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          Check
        </button>
      </div>
      <p role="status" aria-live="polite" style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: copy ? TONE_COLOR[copy.tone] : undefined }}>
        {copy?.text ?? ""}
      </p>
    </form>
  );
}
