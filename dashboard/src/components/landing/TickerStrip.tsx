"use client";

import { Fragment } from "react";

import { useLocale } from "@/components/i18n/LocaleProvider";
import styles from "./home.module.css";

export default function TickerStrip() {
  const { copy, locale } = useLocale();
  const proofPoints = locale.toLowerCase().startsWith("en")
    ? ["Ubuntu · Windows · Omarchy", "Bring your own model key", "Choose who runs it"]
    : copy.ticker.proofPoints;

  return (
    <div
      style={{
        width: "100%",
        borderTop: "1px solid var(--etched-border)",
        borderBottom: "1px solid var(--etched-border)",
        background: "rgba(255, 44, 45, 0.04)",
        padding: "0.85rem 1.5rem",
        margin: "0 0 4rem",
      }}
    >
      <div
        style={{
          maxWidth: 1000,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.5rem",
          flexWrap: "wrap",
        }}
      >
        {proofPoints.map((label, i) => (
          <Fragment key={label}>
            <span
              className={`mono ${styles.tickerLabel}`}
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.18em",
                color: "var(--text-secondary)",
                fontWeight: 600,
                textAlign: "center",
              }}
            >
              {label}
            </span>
            {i < proofPoints.length - 1 && (
              <span aria-hidden="true" className="mono" style={{ color: "var(--gold-leaf)", opacity: 0.6 }}>
                ·
              </span>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
