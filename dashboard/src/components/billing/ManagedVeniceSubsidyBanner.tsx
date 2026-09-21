export type ManagedVeniceDiscountRate =
  | "launch_20"
  | "standard_10"
  | "mixed_launch_standard"
  | "none";

export function formatMicroUsd(amountMicroUsd: number, decimals = 2) {
  return `$${(amountMicroUsd / 1_000_000).toFixed(decimals)}`;
}

export function ManagedVeniceSubsidyBanner(props: {
  rate: ManagedVeniceDiscountRate;
  discountBps: number;
  launchSubsidyUsedMicroUsd: number;
  launchSubsidyCapMicroUsd: number;
  killSwitchActive?: boolean;
}) {
  const used = Math.round(props.launchSubsidyUsedMicroUsd / 1_000_000);
  const cap = Math.round(props.launchSubsidyCapMicroUsd / 1_000_000);
  const percent = Math.round(props.discountBps / 100);
  const isLaunch = props.rate === "launch_20" || props.rate === "mixed_launch_standard";

  return (
    <div
      style={{
        border: "1px solid var(--ink-black)",
        padding: "12px 14px",
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
        background: "var(--bg-surface)",
      }}
    >
      <span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>
        Launch bonus cap: ${used} of ${cap} used
      </span>
      <span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>
        {isLaunch
          ? `Pay with $HermesOS for up to ${percent}% more credits`
          : `Standard $HermesOS bonus: ${percent}% more credits`}
      </span>
      {props.killSwitchActive && (
        <span className="mono" style={{ fontSize: 11, fontWeight: 700 }}>
          Demand exceeded launch wave allocation
        </span>
      )}
    </div>
  );
}
