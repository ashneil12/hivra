/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";

import { HivraChat } from "@/components/hivra/HivraChat";
import { WebuiIframe } from "@/components/webui/WebuiIframe";
import { captureClient } from "@/lib/telemetry/posthog-client";

import { WorkspaceConversation } from "../WorkspaceConversation";
import { resolveWorkspaceConversation } from "../workspace-conversation-adapters";

jest.mock("@/components/hivra/HivraChat", () => ({
  HivraChat: jest.fn(() => <div data-testid="real-hivra-chat">Hivra conversation</div>),
}));

jest.mock("@/components/webui/WebuiIframe", () => ({
  WebuiIframe: jest.fn(() => <div data-testid="real-hermes-chat">Hermes conversation</div>),
}));

jest.mock("@/lib/telemetry/posthog-client", () => ({
  captureClient: jest.fn(),
}));

const mockedHivraChat = jest.mocked(HivraChat);
const mockedWebuiIframe = jest.mocked(WebuiIframe);
const mockedCaptureClient = jest.mocked(captureClient);

const SECRET_TOKEN = "SECRET_CONVERSATION_TOKEN";
const SECRET_BOX_URL = "https://secret-box.example.com/?access=SECRET_BOX_QUERY";

const hermesSource = {
  kind: "hermes" as const,
  uid: "h-hermes-1",
  instance: {
    id: "hermes-1",
    name: "Hermes One",
    status: "running",
    backend: "webui",
  },
};

const hivraSource = {
  kind: "hivra" as const,
  uid: "x-cli-1",
  agent: {
    id: "cli-1",
    type: "codex" as const,
    name: "Codex One",
    status: "running" as const,
    cpu: 2,
    ram: 4,
    chat_url: SECRET_BOX_URL,
    api_token: SECRET_TOKEN,
    goal: "build",
    context: "Work in the selected repository.",
    first_task: "Inspect the failing test.",
    emoji: "C",
    llm_config: {
      provider: "venice" as const,
      mode: "byok" as const,
      model: "qwen3-coder",
      keyPrefix: null,
      walletType: null,
      enabledAt: "2026-08-24T19:00:00.000Z",
    },
  },
};

describe("workspace conversation adapters", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: jest.fn() },
    });
  });

  it("renders Hermes through its real backing instance", () => {
    const adapter = resolveWorkspaceConversation(hermesSource);
    expect(adapter).not.toBeNull();
    expect(Object.keys(adapter!).sort()).toEqual([
      "computer",
      "renderConversation",
      "uid",
    ]);
    expect(adapter!.uid).toBe("h-hermes-1");
    expect(adapter!.computer.id).toBe("h-hermes-1");
    expect(adapter!.renderConversation().key).toBe("h-hermes-1");

    render(<WorkspaceConversation adapter={adapter!} />);

    expect(screen.getByTestId("real-hermes-chat")).toBeInTheDocument();
    expect(mockedWebuiIframe.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        instanceId: "hermes-1",
        instanceStatus: "running",
      }),
    );
  });

  it("renders a supported Hivra CLI with its source-qualified React and storage key", () => {
    const adapter = resolveWorkspaceConversation(hivraSource);
    expect(adapter).not.toBeNull();
    expect(Object.keys(adapter!).sort()).toEqual([
      "computer",
      "renderConversation",
      "uid",
    ]);
    expect(adapter!.uid).toBe("x-cli-1");
    expect(adapter!.computer.id).toBe("x-cli-1");
    expect(adapter!.renderConversation().key).toBe("x-cli-1");

    render(<WorkspaceConversation adapter={adapter!} />);

    expect(screen.getByTestId("real-hivra-chat")).toBeInTheDocument();
    expect(mockedHivraChat.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        boxUrl: SECRET_BOX_URL,
        token: SECRET_TOKEN,
        storageKey: "x-cli-1",
        agentName: "Codex One",
        agentKind: "codex",
        modelLabel: "qwen3-coder",
      }),
    );
  });

  it("keeps family credentials outside generic state, copy, links, logs, and analytics", () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const clipboardWrite = jest.mocked(navigator.clipboard.writeText);

    try {
      const adapter = resolveWorkspaceConversation(hivraSource);
      const serialized = JSON.stringify(adapter);
      expect(serialized).not.toContain(SECRET_TOKEN);
      expect(serialized).not.toContain(SECRET_BOX_URL);
      expect(serialized).not.toContain("SECRET_BOX_QUERY");

      const view = render(<WorkspaceConversation adapter={adapter!} />);
      const rendered = view.container.innerHTML;
      expect(rendered).not.toContain(SECRET_TOKEN);
      expect(rendered).not.toContain(SECRET_BOX_URL);
      expect(rendered).not.toContain("SECRET_BOX_QUERY");
      expect(
        Array.from(view.container.querySelectorAll("a, iframe")).map((element) => ({
          href: element.getAttribute("href"),
          src: element.getAttribute("src"),
          title: element.getAttribute("title"),
        })),
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ href: expect.stringContaining("SECRET_") }),
        ]),
      );
      expect(clipboardWrite).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(mockedCaptureClient).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("renders a working conversation without a run-acknowledgement disclaimer", () => {
    // This pane previously carried an unconditional "Legacy session — this
    // session has no canonical run acknowledgement" header. It rendered only
    // AFTER the no-conversation guard, so it labelled every healthy conversation
    // legacy while describing a run-acknowledgement model that does not exist.
    const hermes = resolveWorkspaceConversation(hermesSource);
    const hivra = resolveWorkspaceConversation(hivraSource);
    const view = render(<WorkspaceConversation adapter={hermes!} />);

    expect(screen.queryByText(/no canonical run acknowledgement/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("real-hermes-chat")).toBeInTheDocument();

    view.rerender(<WorkspaceConversation adapter={hivra!} />);
    expect(screen.queryByText(/no canonical run acknowledgement/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("real-hivra-chat")).toBeInTheDocument();
    // Still must not fabricate run state it cannot observe.
    expect(view.container).not.toHaveTextContent(/run complete|queued|synced|\d+%/i);
  });

  it("fails closed for a mismatched UID or a Hivra agent without a reachable runtime", () => {
    expect(
      resolveWorkspaceConversation({
        ...hermesSource,
        uid: "h-someone-else",
      }),
    ).toBeNull();
    expect(
      resolveWorkspaceConversation({
        ...hivraSource,
        agent: { ...hivraSource.agent, chat_url: null },
      }),
    ).toBeNull();
  });

  it("embeds the on-box runtime for a dashboard-surface agent", () => {
    // Agent Zero and Aeon host their own web UI instead of a chat-CLI endpoint.
    // They used to resolve to no conversation at all, so opening one from the
    // Chat rail showed a compatibility notice with no route to the runtime.
    // The frame probes /api/meta before it will send a token anywhere. jsdom
    // ships no fetch, so define one rather than spy on a missing property.
    const originalFetch = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
    }));
    const adapter = resolveWorkspaceConversation({
      ...hivraSource,
      agent: { ...hivraSource.agent, type: "aeon" as const },
    });

    expect(adapter).not.toBeNull();
    render(<WorkspaceConversation adapter={adapter!} />);
    expect(screen.getByTestId("runtime-surface-frame")).toBeInTheDocument();
    // The bootstrap token must never reach a URL or the accessible name.
    expect(document.body.innerHTML).not.toContain(SECRET_TOKEN);
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  });

  it.each([
    { type: "agent-zero" as const, destination: "/agent-zero/" },
    { type: "openclaw" as const, destination: "/openclaw/" },
    { type: "aeon" as const, destination: "/aeon/" },
  ])("embeds $type at its native mount $destination", async ({ type, destination }) => {
    const originalFetch = (globalThis as { fetch?: unknown }).fetch;
    const requestSubmit = jest.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(() => undefined);
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ agentKind: type, surfaceAuth: "post-cookie-v1" }),
    }));
    try {
      const adapter = resolveWorkspaceConversation({
        ...hivraSource,
        agent: { ...hivraSource.agent, type, chat_url: "https://box.example.com" },
      });
      render(<WorkspaceConversation adapter={adapter!} />);
      const form = await waitFor(() => {
        const found = document.querySelector('form[target^="hivra-runtime-"]');
        expect(found).not.toBeNull();
        return found!;
      });
      expect(form.querySelector('input[name="destination"]')).toHaveValue(destination);
      await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
    } finally {
      requestSubmit.mockRestore();
      (globalThis as { fetch?: unknown }).fetch = originalFetch;
    }
  });

  it.each(["omarchy", "windows", "ubuntu-desktop", null] as const)(
    "gives a computer (%s) no conversation, with or without a chat endpoint",
    (profile) => {
      // A computer's desktop is a SURFACE now (see workspace-surface-adapters),
      // not a conversation. It used to resolve here, and a profile that was
      // neither omarchy nor windows fell through to the box's /terminal/ — which
      // is why an Ubuntu desktop opened on a terminal.
      jest.isolateModules(() => {
        const { resolveWorkspaceConversation: resolve } =
          jest.requireActual<
            typeof import("../workspace-conversation-adapters")
          >("../workspace-conversation-adapters");

        for (const chatUrl of [null, SECRET_BOX_URL]) {
          const adapter = resolve({
            ...hivraSource,
            uid: `x-${profile ?? "unset"}-one`,
            agent: {
              ...hivraSource.agent,
              id: `${profile ?? "unset"}-one`,
              type: "linux-desktop",
              computer_profile: profile,
              chat_url: chatUrl,
            },
          });
          expect(adapter).toBeNull();
        }
      });
    },
  );
});
