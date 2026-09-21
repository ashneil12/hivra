export interface ManagedVeniceKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  status: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function ManagedVeniceKeysPanel(props: {
  keys: ManagedVeniceKeySummary[];
  createdPlaintextKey?: string | null;
}) {
  return (
    <section
      style={{
        border: "1px solid var(--ink-black)",
        background: "var(--bg-surface)",
        padding: "clamp(1.25rem, 3vw, 2rem)",
        marginBottom: "2rem",
        boxShadow: "4px 4px 0px var(--ink-black)",
      }}
    >
      <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", opacity: 0.58 }}>
        Managed Venice proxy keys
      </div>
      <h3 className="serif" style={{ fontSize: 28, margin: "4px 0 16px" }}>
        API access
      </h3>

      {props.createdPlaintextKey && (
        <div style={{ border: "1px solid var(--ink-black)", padding: 12, marginBottom: 16 }}>
          <div className="mono" style={{ fontSize: 11, fontWeight: 700, marginBottom: 6 }}>
            Shown once. Store it before leaving this page.
          </div>
          <code style={{ fontSize: 13, wordBreak: "break-all" }}>{props.createdPlaintextKey}</code>
        </div>
      )}

      {props.keys.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, opacity: 0.72 }}>
          No managed Venice proxy keys yet.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {props.keys.map((key) => (
            <div
              key={key.id}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(120px, 1fr) minmax(130px, auto) minmax(70px, auto)",
                gap: 12,
                alignItems: "center",
                borderTop: "1px solid var(--etched-border)",
                paddingTop: 10,
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 700 }}>{key.name}</span>
              <code style={{ fontSize: 12 }}>{key.keyPrefix}...</code>
              <span className="mono" style={{ fontSize: 11, textTransform: "uppercase" }}>
                {key.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
