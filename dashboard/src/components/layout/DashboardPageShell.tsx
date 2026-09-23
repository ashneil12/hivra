import type { CSSProperties, ReactNode } from "react";

type DashboardPageShellProps = {
  children: ReactNode;
  maxWidth?: CSSProperties["maxWidth"];
  marginBottom?: string;
  padding?: string;
  topPadding?: string;
  style?: CSSProperties;
};

export function DashboardPageShell({
  children,
  maxWidth = 1100,
  marginBottom = "5rem",
  padding = "clamp(1rem, 5vw, 3rem)",
  topPadding = "clamp(1rem, 5vw, 3rem)",
  style,
}: DashboardPageShellProps) {
  return (
    <div
      data-testid="dashboard-page-shell"
      style={{
        maxWidth,
        width: "100%",
        margin: `1rem auto ${marginBottom}`,
        padding,
        // The mobile header already clears the inset and sets this to 0px;
        // header-less routes fall back to the inset.
        paddingTop: `calc(var(--dashboard-page-safe-top, env(safe-area-inset-top, 0px)) + ${topPadding})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
