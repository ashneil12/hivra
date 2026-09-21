import React from "react";

export default function Disclaimer({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="etched-card"
      style={{
        padding: "1.25rem",
        background: "var(--bg-elevated)",
        borderColor: "var(--etched-border)",
      }}
    >
      <p style={{ color: "var(--text-secondary)" }}>{children}</p>
    </div>
  );
}
