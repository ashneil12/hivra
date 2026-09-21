"use client";

import { Clipboard, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { PwaInstallPrompt } from "@/components/pwa/PwaInstallPrompt";
import { ReportProblemLink } from "@/components/support/ReportProblemLink";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import type { UnifiedAgent } from "@/lib/hivra/unified-agent";
import {
  RELEASE_CAPABILITY_SURFACES,
  buildReleaseCapabilityMatrix,
  releaseAgentLabel,
  serializeReleaseCapabilityMatrix,
  type ReleaseAgentDetailLoader,
  type ReleaseCapabilityMatrix,
  type ReleaseCapabilityRow,
} from "@/lib/workspace/release-capability-matrix";
import type { ReleaseMetadata } from "@/lib/workspace/release-metadata";
import { useWorkspaceModalLayer } from "./WorkspaceModalLayerContext";

export const FIVE_MINUTE_WORKFLOW = [
  "Select two agents and confirm each keeps its own conversation.",
  "Send a message and confirm the real agent responds.",
  "Refresh and confirm the selected agent and surface return.",
  "Open one available computer surface, then return to the conversation.",
  "Install Hivra, open it in standalone mode, and confirm the same workspace is available.",
] as const;

const LIMITATIONS = [
  "Compatibility sessions are saved on this device and have no canonical run acknowledgement or durable cross-client history.",
  "Privileged terminal, browser, and desktop access still uses existing compatibility paths; short-lived tenant-scoped grants arrive in Phase 3.",
  "Unknown evidence stays unknown. A failed detail load never becomes a supported or unavailable claim.",
] as const;

const MAC_INSTALL_STEPS = [
  "Safari on Mac: open the canary URL, choose File, choose Add to Dock, then confirm Add.",
  "Chrome or Edge on Mac: open the browser menu, choose Install Hivra or Add to Dock, then confirm the install.",
  "Open the installed app and sign in. It uses the same authenticated workspace, APIs, and product state as the browser.",
] as const;

const SURFACE_LABELS = {
  workspace: "Workspace",
  files: "Files",
  git: "Git",
  terminal: "Terminal",
  browser: "Browser",
  desktop: "Desktop",
  native: "Native runtime",
} as const;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface MatrixResult {
  agentKey: string;
  loader: ReleaseAgentDetailLoader;
  matrix: ReleaseCapabilityMatrix;
}

export interface CanaryTestGuideProps {
  open: boolean;
  onClose: () => void;
  releaseMetadata: ReleaseMetadata;
  agents: readonly UnifiedAgent[];
  loadAgentDetail: ReleaseAgentDetailLoader;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function matrixAgentKey(agents: readonly UnifiedAgent[]): string {
  return agents.map(({ kind, uid }) => `${kind}:${uid}`).join("|");
}

function buildCopiedDetails(
  metadata: ReleaseMetadata,
  matrix: ReleaseCapabilityMatrix | null,
  checklist: readonly boolean[],
): string {
  const lines = [
    "Hivra canary test details",
    `Canary URL: ${metadata.canaryUrl}`,
    `Full Git revision: ${metadata.revision}`,
    `${metadata.buildGeneratedAtLabel}: ${metadata.buildGeneratedAt}`,
    "Build generated at is build-generation provenance only, not authoritative Vercel deployment time.",
    `Public deployment ID: ${metadata.deploymentId}`,
    `Target environment: ${metadata.targetEnvironment}`,
    "",
    matrix
      ? serializeReleaseCapabilityMatrix(matrix)
      : "Capability matrix\nLoading current agent evidence…",
    "",
    "Known limitations",
    ...LIMITATIONS.map((limitation) => `- ${limitation}`),
    "",
    "Install Hivra on Mac",
    ...MAC_INSTALL_STEPS.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Your test checklist",
    ...FIVE_MINUTE_WORKFLOW.map(
      (step, index) => `[${checklist[index] ? "x" : " "}] ${step}`,
    ),
  ];
  return lines.join("\n");
}

function CopyButton({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    const copied = await copyTextToClipboard(value);
    setStatus(copied ? "copied" : "failed");
  };

  const visibleLabel =
    status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : label;

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void copy()}
      className="mono inline-flex min-h-[44px] items-center gap-2 border border-[var(--etched-border)] px-4 text-[12px] font-semibold text-[var(--ink-black)] outline-none hover:bg-[var(--bg-elevated)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2"
    >
      <Clipboard aria-hidden="true" size={16} />
      {visibleLabel}
    </button>
  );
}

function GuideSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-[var(--etched-border)] px-4 py-6 sm:px-6">
      <h2 className="serif text-[20px] font-semibold leading-[1.2]">{title}</h2>
      <div className="mt-4 text-[14px] leading-[1.5] text-[var(--text-secondary)]">
        {children}
      </div>
    </section>
  );
}

function CapabilityRowView({ row }: { row: ReleaseCapabilityRow }) {
  return (
    <tr data-testid={`release-capability-${row.family}-${row.ordinal}`}>
      <th
        scope="row"
        className="min-w-[152px] border-b border-[var(--etched-border)] px-4 py-4 text-left align-top"
      >
        <span className="block text-[14px] font-semibold text-[var(--ink-black)]">
          {releaseAgentLabel(row)}
        </span>
        <span className="mono mt-1 block text-[12px] font-semibold text-[var(--text-muted)]">
          Detail {row.detailState}
        </span>
      </th>
      {RELEASE_CAPABILITY_SURFACES.map((surface) => (
        <td
          key={surface}
          className="min-w-[112px] border-b border-[var(--etched-border)] px-4 py-4 align-top"
        >
          <span className="mono block text-[12px] font-semibold text-[var(--text-muted)]">
            {SURFACE_LABELS[surface]}
          </span>
          <span className="mt-1 block text-[14px] text-[var(--ink-black)]">
            {capitalize(row.surfaces[surface].state)}
          </span>
        </td>
      ))}
    </tr>
  );
}

export function CanaryTestGuide({
  open,
  onClose,
  releaseMetadata,
  agents,
  loadAgentDetail,
}: CanaryTestGuideProps) {
  useWorkspaceModalLayer("test-guide", open);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [matrixResult, setMatrixResult] = useState<MatrixResult | null>(null);
  const [checklist, setChecklist] = useState<boolean[]>(() =>
    FIVE_MINUTE_WORKFLOW.map(() => false),
  );
  const agentKey = matrixAgentKey(agents);
  const matrix =
    matrixResult?.agentKey === agentKey &&
    matrixResult.loader === loadAgentDetail
      ? matrixResult.matrix
      : null;
  const copiedDetails = useMemo(
    () => buildCopiedDetails(releaseMetadata, matrix, checklist),
    [checklist, matrix, releaseMetadata],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void buildReleaseCapabilityMatrix(agents, loadAgentDetail, {
      signal: controller.signal,
    }).then((nextMatrix) => {
      if (controller.signal.aborted) return;
      setMatrixResult({ agentKey, loader: loadAgentDetail, matrix: nextMatrix });
    });
    return () => controller.abort();
  }, [agentKey, agents, loadAgentDetail, open]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const backgroundElements: Element[] = [];
    let activeBranch: Element | null = dialog;
    while (activeBranch?.parentElement) {
      const parent = activeBranch.parentElement;
      backgroundElements.push(
        ...Array.from(parent.children).filter(
          (element) => element !== activeBranch,
        ),
      );
      if (parent === document.body) break;
      activeBranch = parent;
    }
    const inertState = backgroundElements.map((element) => ({
      element,
      wasInert: element.hasAttribute("inert"),
    }));
    for (const { element } of inertState) element.setAttribute("inert", "");

    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (element) =>
          !element.hidden &&
          element.getAttribute("aria-hidden") !== "true" &&
          !element.closest("[inert]"),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      for (const { element, wasInert } of inertState) {
        if (!wasInert) element.removeAttribute("inert");
      }
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/60 min-[1200px]:items-center min-[1200px]:justify-center min-[1200px]:p-8"
      // Clicking the dimmed area dismisses, which is what every other overlay
      // here does. mousedown (not click) so a drag that starts inside the panel
      // and ends on the backdrop does not close it.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="canary-test-guide-title"
        tabIndex={-1}
        className="h-[100dvh] w-full overflow-y-auto bg-[var(--vellum-bg)] text-[var(--ink-black)] md:w-[min(760px,100%)] md:border-l md:border-[var(--etched-border)] md:bg-[var(--bg-surface)] min-[1200px]:h-[min(880px,calc(100dvh-64px))] min-[1200px]:w-[min(920px,calc(100vw-64px))] min-[1200px]:border"
      >
      <header className="sticky top-0 z-10 flex min-h-[64px] items-center gap-4 border-b border-[var(--etched-border)] bg-[var(--bg-surface)] px-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <p className="mono text-[12px] font-semibold leading-[1.3] text-[var(--text-muted)]">
            Canary preview
          </p>
          <h1
            id="canary-test-guide-title"
            className="serif truncate text-[20px] font-semibold leading-[1.2]"
          >
            Canary test guide
          </h1>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="Close test guide"
          onClick={onClose}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center border border-[var(--etched-border)] outline-none hover:bg-[var(--bg-elevated)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </header>

      <GuideSection title="Canary URL">
        <p className="break-all text-[14px] text-[var(--ink-black)]">
          {releaseMetadata.canaryUrl}
        </p>
        <div className="mt-4">
          <CopyButton label="Copy URL" value={releaseMetadata.canaryUrl} />
        </div>
      </GuideSection>

      <GuideSection title="Git revision">
        <p className="mono break-all text-[12px] font-semibold text-[var(--ink-black)]">
          {releaseMetadata.revision}
        </p>
        <p className="mt-2 text-[14px]">
          Visible short revision: <span className="mono">{releaseMetadata.shortRevision}</span>
        </p>
        <div className="mt-4">
          <CopyButton label="Copy revision" value={releaseMetadata.revision} />
        </div>
      </GuideSection>

      <GuideSection title="Build provenance">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="mono text-[12px] font-semibold text-[var(--text-muted)]">
              {releaseMetadata.buildGeneratedAtLabel}
            </dt>
            <dd className="mt-1 break-all text-[14px] text-[var(--ink-black)]">
              {releaseMetadata.buildGeneratedAt}
            </dd>
          </div>
          <div>
            <dt className="mono text-[12px] font-semibold text-[var(--text-muted)]">
              Target environment
            </dt>
            <dd className="mt-1 text-[14px] text-[var(--ink-black)]">
              {releaseMetadata.targetEnvironment}
            </dd>
          </div>
          <div>
            <dt className="mono text-[12px] font-semibold text-[var(--text-muted)]">
              Public deployment ID
            </dt>
            <dd className="mt-1 break-all text-[14px] text-[var(--ink-black)]">
              {releaseMetadata.deploymentId}
            </dd>
          </div>
        </dl>
        <p className="mt-4 text-[14px] text-[var(--yellow)]">
          Build generated at is build-generation provenance only, not authoritative Vercel deployment time.
        </p>
      </GuideSection>

      <GuideSection title="Capability matrix">
        {!matrix ? (
          <p role="status">Loading current agent evidence…</p>
        ) : matrix.rows.length === 0 ? (
          <p>No agents are currently loaded.</p>
        ) : (
          <div className="overflow-x-auto border border-[var(--etched-border)]">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="px-4 py-4 text-left text-[12px] font-semibold">Agent</th>
                  {RELEASE_CAPABILITY_SURFACES.map((surface) => (
                    <th
                      key={surface}
                      className="px-4 py-4 text-left text-[12px] font-semibold"
                    >
                      {SURFACE_LABELS[surface]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>{matrix.rows.map((row) => <CapabilityRowView key={`${row.family}-${row.ordinal}`} row={row} />)}</tbody>
            </table>
          </div>
        )}
      </GuideSection>

      <GuideSection title="Known limitations">
        <ul className="grid gap-2">
          {LIMITATIONS.map((limitation) => (
            <li key={limitation}>• {limitation}</li>
          ))}
        </ul>
      </GuideSection>

      <GuideSection title="Install Hivra on Mac">
        <ol className="grid gap-2">
          {MAC_INSTALL_STEPS.map((step, index) => (
            <li key={step}>{index + 1}. {step}</li>
          ))}
        </ol>
        <div className="mt-6">
          <PwaInstallPrompt expanded />
        </div>
      </GuideSection>

      <GuideSection title="Five-minute workflow">
        <ol className="grid gap-2">
          {FIVE_MINUTE_WORKFLOW.map((step, index) => (
            <li key={step}>{index + 1}. {step}</li>
          ))}
        </ol>
        <h3 className="serif mt-6 text-[20px] font-semibold leading-[1.2]">
          Your test checklist
        </h3>
        <p className="mt-2 text-[14px] text-[var(--text-muted)]">
          These checks stay in this guide and remain under your control.
        </p>
        <div className="mt-4 grid gap-2">
          {FIVE_MINUTE_WORKFLOW.map((step, index) => (
            <label
              key={step}
              className="flex min-h-[44px] items-start gap-2 border border-[var(--etched-border)] px-4 py-2"
            >
              <input
                type="checkbox"
                checked={checklist[index]}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setChecklist((current) =>
                    current.map((value, itemIndex) =>
                      itemIndex === index ? checked : value,
                    ),
                  );
                }}
                className="mt-1 accent-[var(--hivra-red)]"
              />
              <span>{step}</span>
            </label>
          ))}
        </div>
        <div className="mt-4">
          <CopyButton label="Copy test details" value={copiedDetails} />
        </div>
      </GuideSection>

      <GuideSection title="Feedback">
        <p className="mb-4 text-[14px] text-[var(--ink-black)]">Send feedback</p>
        <ReportProblemLink
          surface="canary-test-guide"
          summary="Hivra canary workspace feedback"
          showDiscord={false}
        />
      </GuideSection>
      </div>
    </div>
  );
}
