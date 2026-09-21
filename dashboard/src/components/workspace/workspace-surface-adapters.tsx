import type { ReactElement } from "react";

import { HivraConsoleDesktop } from "@/components/hivra/HivraConsoleDesktop";
import { HivraFiles } from "@/components/hivra/HivraFiles";
import { HivraGit } from "@/components/hivra/HivraGit";
import { HivraOmarchyDesktop } from "@/components/hivra/HivraOmarchyDesktop";
import { HivraRemoteDesktop } from "@/components/hivra/HivraRemoteDesktop";
import { RuntimeSurfaceFrame } from "@/components/hivra/RuntimeSurfaceFrame";
import { ShellTerminalWorkspace } from "@/components/ShellTerminalWorkspace";
import { WebuiIframe } from "@/components/webui/WebuiIframe";
import type {
  AgentComputer,
  AgentComputerSurface,
} from "@/lib/agent-computers/contracts";
import {
  projectWorkspaceHermes,
  projectWorkspaceHivra,
} from "@/lib/agent-computers/workspace-projection";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { resolveResourceLanding } from "@/lib/hivra/resource-landing";
import type { WorkspaceSurfaceDescriptor } from "@/lib/workspace/workspace-contracts";

import { SurfaceFrame } from "./SurfaceFrame";

interface HermesWorkspaceSurfaceSource {
  kind: "hermes";
  uid: string;
  instance: {
    id: string;
    name: string;
    status: string;
    backend: string;
    gateway_url?: unknown;
    error?: unknown;
  };
}

interface HivraWorkspaceSurfaceSource {
  kind: "hivra";
  uid: string;
  agent: HivraAgent;
  /** Explicit live/source evidence only; catalog support alone is insufficient. */
  browserEnabled?: boolean;
}

export type WorkspaceSurfaceSource =
  | HermesWorkspaceSurfaceSource
  | HivraWorkspaceSurfaceSource;

export interface WorkspaceSurfaceAdapter {
  uid: string;
  computer: AgentComputer;
  descriptors: Array<
    WorkspaceSurfaceDescriptor & { surface: AgentComputerSurface }
  >;
  renderSurface: (
    surface: AgentComputerSurface,
    onBack: () => void,
  ) => ReactElement | null;
}

const LABELS: Record<AgentComputerSurface, string> = {
  workspace: "Workspace",
  files: "Files",
  git: "Git",
  terminal: "Terminal",
  browser: "Browser",
  desktop: "Desktop",
  native: "Native runtime",
};

// These sets are the "we can actually render this inline" half of the surface
// contract; the projector declares what the runtime CAN offer, and the tabs are
// the intersection. Keep them in step with projectors.ts — a surface listed here
// that has no renderer branch below turns into a tab that opens an empty pane.
//
// "workspace" is in neither set. For a dashboard-surface agent it rendered a
// second copy of the runtime the Conversation tab already embeds (under a tab
// labelled with the product name — "Agent Zero"), and for everything else it was
// a bare hand-off frame. Two tabs opening one thing is what made "Workspace"
// read as a feature nobody could explain.
const HERMES_IMPLEMENTED = new Set<AgentComputerSurface>(["terminal"]);

const HIVRA_IMPLEMENTED = new Set<AgentComputerSurface>([
  "files",
  "git",
  "terminal",
  "browser",
  // A computer's desktop IS its primary surface, and the projector has always
  // declared it. Leaving it out of this set filtered the desktop out of every
  // computer's tab strip, so a computer's only reachable surfaces were the
  // box's shell and files — the reason a desktop opened on a terminal.
  "desktop",
]);

function observedLabel(computer: AgentComputer): string {
  return `Observed: ${computer.state.observed}`;
}

function descriptorList(
  computer: AgentComputer,
  implemented: ReadonlySet<AgentComputerSurface>,
  labelFor: (surface: AgentComputerSurface) => string = (surface) => LABELS[surface],
  unavailable?: ReadonlySet<AgentComputerSurface>,
): Array<WorkspaceSurfaceDescriptor & { surface: AgentComputerSurface }> {
  return computer.capabilities.surfaces.flatMap((surface) => {
    if (!implemented.has(surface)) return [];
    const isUnavailable = unavailable?.has(surface) ?? false;
    return [
      {
        surface,
        label: labelFor(surface),
        availability: isUnavailable ? "unavailable" : "available",
        ...(isUnavailable
          ? { reason: `${labelFor(surface)} is unavailable right now.` }
          : {}),
      } satisfies WorkspaceSurfaceDescriptor,
    ];
  });
}

function hermesDestination(instanceId: string): string {
  return `/dashboard/instances/${encodeURIComponent(instanceId)}`;
}

function hivraDestination(agentId: string, tab: string): string {
  return `/dashboard/agent/${encodeURIComponent(agentId)}?tab=${tab}`;
}

function resolveHermesSurface(
  source: HermesWorkspaceSurfaceSource,
): WorkspaceSurfaceAdapter | null {
  const projection = projectWorkspaceHermes(source.instance);
  if (!projection.ok || projection.computer.id !== source.uid) return null;

  const computer = projection.computer;
  const descriptors = descriptorList(computer, HERMES_IMPLEMENTED, (surface) =>
    surface === "native" ? "Hermes" : LABELS[surface],
  );
  const usable = new Set(descriptors.map(({ surface }) => surface));
  const destination = hermesDestination(source.instance.id);

  return {
    uid: source.uid,
    computer,
    descriptors,
    renderSurface: (surface, onBack) => {
      if (!usable.has(surface)) return null;
      const label = surface === "native" ? "Hermes" : LABELS[surface];
      if (surface === "terminal") {
        return (
          <SurfaceFrame
            key={`${source.uid}:${surface}`}
            agentName={computer.name}
            surfaceLabel={label}
            accessLabel={observedLabel(computer)}
            destinationHref={destination}
            onBack={onBack}
          >
            <ShellTerminalWorkspace instanceId={source.instance.id} isActive />
          </SurfaceFrame>
        );
      }

      // The remaining declared surfaces (workspace/browser/native) are all
      // served by the instance's own web UI, which WebuiIframe already opens
      // with the same authenticated handoff the conversation pane uses. They
      // previously rendered an empty SurfaceFrame whose only content was an
      // "open in a new tab" link — a dead end in the pane.
      if (
        surface === "workspace" ||
        surface === "browser" ||
        surface === "native"
      ) {
        return (
          <SurfaceFrame
            key={`${source.uid}:${surface}`}
            agentName={computer.name}
            surfaceLabel={label}
            accessLabel={observedLabel(computer)}
            destinationHref={destination}
            onBack={onBack}
          >
            <WebuiIframe
              key={`${source.uid}:${surface}-frame`}
              instanceId={source.instance.id}
              instanceStatus={source.instance.status}
              className="h-full min-h-0 w-full"
            />
          </SurfaceFrame>
        );
      }

      return (
        <SurfaceFrame
          key={`${source.uid}:${surface}`}
          agentName={computer.name}
          surfaceLabel={label}
          accessLabel={observedLabel(computer)}
          destinationHref={destination}
          onBack={onBack}
        />
      );
    },
  };
}

function resolveHivraSurface(
  source: HivraWorkspaceSurfaceSource,
): WorkspaceSurfaceAdapter | null {
  const definition = getAgent(source.agent.type);
  if (!definition) return null;
  const surfaceKind = definition.surface;
  const definitionName = definition.name;

  const projection = projectWorkspaceHivra({
    id: source.agent.id,
    name: source.agent.name,
    status: source.agent.status,
    type: source.agent.type,
    computerProfile: source.agent.computer_profile,
    browserEnabled: source.browserEnabled === true,
  });
  if (!projection.ok || projection.computer.id !== source.uid) return null;

  const computer = projection.computer;
  const boxUrl = source.agent.chat_url?.trim() || null;
  const landing = resolveResourceLanding({
    source: "hivra",
    type: source.agent.type,
    computerProfile: source.agent.computer_profile,
    status: source.agent.status,
    chatUrl: boxUrl,
    surfaceKind,
    resourceKind: definition.resourceKind,
  });
  const unavailable = new Set<AgentComputerSurface>();
  if (!boxUrl) {
    unavailable.add("files");
    unavailable.add("git");
  }
  const descriptors = descriptorList(
    computer,
    HIVRA_IMPLEMENTED,
    (surface) =>
      surface === "workspace" && surfaceKind === "dashboard"
        ? definitionName
        : LABELS[surface],
    unavailable,
  );
  const usable = new Set(
    descriptors
      .filter(({ availability }) => availability === "available")
      .map(({ surface }) => surface),
  );
  const token = source.agent.api_token ?? null;

  function tabFor(surface: AgentComputerSurface): string {
    if (surface === "workspace") {
      return surfaceKind === "dashboard" ? "aeon" : "chat";
    }
    if (surface === "terminal" && surfaceKind === "dashboard") return "box";
    return surface;
  }

  return {
    uid: source.uid,
    computer,
    descriptors,
    renderSurface: (surface, onBack) => {
      if (!usable.has(surface)) return null;
      const label =
        surface === "workspace" && surfaceKind === "dashboard"
          ? definitionName
          : LABELS[surface];
      const destination = hivraDestination(source.agent.id, tabFor(surface));
      const frameProps = {
        agentName: computer.name,
        surfaceLabel: label,
        accessLabel: observedLabel(computer),
        destinationHref: destination,
        onBack,
      };

      // The desktop is the resource's own surface. Which transport renders it is
      // resolved once, in resource-landing, so this branch and the per-agent
      // page cannot pick differently. These components need no chat_url or
      // token — they issue their own authenticated session — which is why the
      // `!boxUrl` guards below must not reach them.
      if (surface === "desktop") {
        const transport = landing.desktopTransport;
        const desktopKey = `${source.uid}:desktop`;
        if (transport === "omarchy") {
          return (
            <SurfaceFrame key={desktopKey} {...frameProps}>
              <HivraOmarchyDesktop
                computerId={source.agent.id}
                name={computer.name}
                active
              />
            </SurfaceFrame>
          );
        }
        if (transport === "windows") {
          return (
            <SurfaceFrame key={desktopKey} {...frameProps}>
              <HivraConsoleDesktop
                computerId={source.agent.id}
                name={computer.name}
                profile="windows"
                active
                // Opens itself. The workspace is the desktop; making the user
                // click "Open fast desktop" here is the manual step the owner
                // reported.
                autoOpenFast={landing.desktopAutoOpen}
              />
            </SurfaceFrame>
          );
        }
        return (
          <SurfaceFrame key={desktopKey} {...frameProps}>
            <HivraRemoteDesktop
              computerId={source.agent.id}
              name={computer.name}
              active
              autoPrepare
            />
          </SurfaceFrame>
        );
      }

      if (surface === "files" && boxUrl) {
        return (
          <SurfaceFrame key={`${source.uid}:${surface}`} {...frameProps}>
            <HivraFiles boxUrl={boxUrl} token={token} />
          </SurfaceFrame>
        );
      }
      if (surface === "git" && boxUrl) {
        return (
          <SurfaceFrame key={`${source.uid}:${surface}`} {...frameProps}>
            <HivraGit boxUrl={boxUrl} token={token} />
          </SurfaceFrame>
        );
      }
      // The box serves its own ttyd shell and browser at these paths, and the
      // per-agent page already reaches them the same way. Without this the
      // surface rendered SurfaceFrame with no children — a bare header over an
      // empty pane reading "Open this authenticated compatibility surface in a
      // new tab", which is a dead end on a running box.
      if (surface === "terminal" && boxUrl) {
        return (
          <RuntimeSurfaceFrame
            key={`${source.uid}:${surface}`}
            url={`${boxUrl.replace(/\/$/, "")}/terminal/`}
            token={token}
            label={`${computer.name} · terminal`}
            description="Shell on this computer"
          />
        );
      }
      // The guest serves the watchable browser at /vnc (proxied to the box's
      // noVNC), not /browser — that path does not exist and would have been a
      // fresh dead end.
      if (surface === "browser" && boxUrl && source.browserEnabled === true) {
        return (
          <RuntimeSurfaceFrame
            key={`${source.uid}:${surface}`}
            url={`${boxUrl.replace(/\/$/, "")}/vnc`}
            token={token}
            label={`${computer.name} · browser`}
            description="Browser on this computer"
          />
        );
      }

      // Anything left genuinely has no in-app surface: the action is to open
      // the per-agent page, not to pretend the pane is a feature.
      return <SurfaceFrame key={`${source.uid}:${surface}`} {...frameProps} />;
    },
  };
}

export function resolveWorkspaceSurfaceAdapter(
  source: WorkspaceSurfaceSource,
): WorkspaceSurfaceAdapter | null {
  return source.kind === "hermes"
    ? resolveHermesSurface(source)
    : resolveHivraSurface(source);
}
