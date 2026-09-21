import type { ReactElement } from "react";

import { HivraChat } from "@/components/hivra/HivraChat";
import { RuntimeSurfaceFrame } from "@/components/hivra/RuntimeSurfaceFrame";
import { WebuiIframe } from "@/components/webui/WebuiIframe";
import type { AgentComputer } from "@/lib/agent-computers/contracts";
import {
  projectWorkspaceHermes,
  projectWorkspaceHivra,
} from "@/lib/agent-computers/workspace-projection";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { getAgent } from "@/lib/hivra/agent-catalog";

interface HermesWorkspaceConversationSource {
  kind: "hermes";
  uid: string;
  instance: {
    id: string;
    name: string;
    status: string;
    backend: string;
  };
}

interface HivraWorkspaceConversationSource {
  kind: "hivra";
  uid: string;
  agent: HivraAgent;
}

export type WorkspaceConversationSource =
  | HermesWorkspaceConversationSource
  | HivraWorkspaceConversationSource;

/**
 * The generic workspace retains only parsed public identity and a family-owned
 * renderer. Hivra transport credentials remain captured inside the renderer
 * and are passed directly to HivraChat; they never become serializable fields.
 */
export interface WorkspaceConversationAdapter {
  uid: string;
  computer: AgentComputer;
  renderConversation: () => ReactElement;
}

function resolveHermesConversation(
  source: HermesWorkspaceConversationSource,
): WorkspaceConversationAdapter | null {
  const projection = projectWorkspaceHermes(source.instance);
  if (!projection.ok || projection.computer.id !== source.uid) return null;

  const { id, status } = source.instance;
  return {
    uid: source.uid,
    computer: projection.computer,
    renderConversation: () => (
      <WebuiIframe
        key={source.uid}
        instanceId={id}
        instanceStatus={status}
        className="h-full min-h-0 w-full"
      />
    ),
  };
}

function resolveHivraConversation(
  source: HivraWorkspaceConversationSource,
): WorkspaceConversationAdapter | null {
  const definition = getAgent(source.agent.type);
  if (!definition) return null;

  const boxUrl = source.agent.chat_url?.trim();

  const projection = projectWorkspaceHivra({
    id: source.agent.id,
    name: source.agent.name,
    status: source.agent.status,
    type: source.agent.type,
    computerProfile: source.agent.computer_profile,
  });
  if (!projection.ok || projection.computer.id !== source.uid) return null;

  const token = source.agent.api_token ?? null;
  const uid = source.uid;

  // A computer has no conversation. Its desktop is a SURFACE, resolved in
  // resource-landing and rendered by workspace-surface-adapters; this adapter
  // must return null so the workspace opens the desktop instead.
  //
  // This branch is where the bug lived: a computer that was neither omarchy nor
  // windows fell through to `${boxUrl}/terminal/`, so a running Ubuntu desktop
  // opened on a terminal — the terminal was never its landing surface, it was
  // the absence of a desktop branch.
  if (definition.surface === "computer") return null;

  // A `surface: "dashboard"` agent (Agent Zero, Aeon, OpenClaw) hosts its own web
  // UI on the box and exposes no chat-CLI endpoint, so there is no HivraChat to
  // render — but its runtime IS the thing the user came to talk to. Embed it
  // rather than falling through to the "no conversation" notice.

  if (definition.surface === "dashboard") {
    // Dashboard-surface agents (Agent Zero, Aeon, OpenClaw) host their own web
    // UI and expose no chat-CLI endpoint, so there is no HivraChat to render —
    // but their runtime IS the thing the user came to talk to. Embed it rather
    // than falling through to the "no conversation" notice.
    if (!boxUrl) return null;
    const origin = boxUrl.replace(/\/$/, "");
    const mountPath = definition.id === "aeon" ? "/aeon/" : `/${definition.id}/`;
    return {
      uid,
      computer: projection.computer,
      renderConversation: () => (
        <RuntimeSurfaceFrame
          key={uid}
          url={`${origin}${mountPath}`}
          token={token}
          label={`${definition.name} · runtime`}
          description={`${definition.name} runs its own interface on this computer`}
        />
      ),
    };
  }

  if (!definition.cliKind) return null;
  if (!boxUrl) return null;

  return {
    uid,
    computer: projection.computer,
    renderConversation: () => (
      <HivraChat
        key={uid}
        boxUrl={boxUrl}
        token={token}
        storageKey={uid}
        agentName={source.agent.name}
        agentKind={definition.cliKind}
        accent={definition.accent}
        goal={source.agent.goal}
        context={source.agent.context}
        firstTask={source.agent.first_task}
        emoji={source.agent.emoji}
        modelLabel={source.agent.llm_config?.model}
      />
    ),
  };
}

export function resolveWorkspaceConversation(
  source: WorkspaceConversationSource,
): WorkspaceConversationAdapter | null {
  return source.kind === "hermes"
    ? resolveHermesConversation(source)
    : resolveHivraConversation(source);
}
