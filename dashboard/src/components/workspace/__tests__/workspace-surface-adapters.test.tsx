/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { FileExplorer } from "@/components/explorer/FileExplorer";
import { HivraFiles } from "@/components/hivra/HivraFiles";
import { HivraGit } from "@/components/hivra/HivraGit";
import { ShellTerminalWorkspace } from "@/components/ShellTerminalWorkspace";
import { captureClient } from "@/lib/telemetry/posthog-client";

import { SurfaceFrame } from "../SurfaceFrame";
import {
  resolveWorkspaceSurfaceAdapter,
  type WorkspaceSurfaceSource,
} from "../workspace-surface-adapters";

jest.mock("@/components/explorer/FileExplorer", () => ({
  FileExplorer: jest.fn(() => <div data-testid="real-hermes-files">Hermes files</div>),
}));

jest.mock("@/components/hivra/HivraFiles", () => ({
  HivraFiles: jest.fn(() => <div data-testid="real-hivra-files">Hivra files</div>),
}));

jest.mock("@/components/hivra/HivraGit", () => ({
  HivraGit: jest.fn(() => <div data-testid="real-hivra-git">Hivra Git</div>),
}));

jest.mock("@/components/ShellTerminalWorkspace", () => ({
  ShellTerminalWorkspace: jest.fn(() => (
    <div data-testid="real-hermes-terminal">Hermes terminal</div>
  )),
}));

jest.mock("@/lib/telemetry/posthog-client", () => ({
  captureClient: jest.fn(),
}));

// The desktop transports open their own authenticated session and touch
// WebCodecs/WebSocket on mount. jsdom has neither, so stand in markers — these
// specs are about WHICH transport is chosen, not how it streams.
jest.mock("@/components/hivra/HivraRemoteDesktop", () => ({
  HivraRemoteDesktop: () => <div data-testid="real-remote-desktop">Remote desktop</div>,
}));
jest.mock("@/components/hivra/HivraOmarchyDesktop", () => ({
  HivraOmarchyDesktop: () => <div data-testid="real-omarchy-desktop">Omarchy desktop</div>,
}));
jest.mock("@/components/hivra/HivraConsoleDesktop", () => ({
  HivraConsoleDesktop: ({ autoOpenFast }: { autoOpenFast?: boolean }) => (
    <div data-testid="real-windows-desktop" data-auto-open={String(Boolean(autoOpenFast))}>
      Windows desktop
    </div>
  ),
}));

const mockedFileExplorer = jest.mocked(FileExplorer);
const mockedHivraFiles = jest.mocked(HivraFiles);
const mockedHivraGit = jest.mocked(HivraGit);
const mockedShellTerminal = jest.mocked(ShellTerminalWorkspace);
const mockedCaptureClient = jest.mocked(captureClient);

const SECRET_TOKEN = "SECRET_SURFACE_TOKEN";
const SECRET_BOX_URL =
  "https://secret-box.example.invalid/?signed=SECRET_SIGNED_QUERY#SECRET_FRAGMENT";
const SECRET_ERROR = "Bearer SECRET_RAW_ERROR";

const hermesSource: WorkspaceSurfaceSource = {
  kind: "hermes",
  uid: "h-hermes:one",
  instance: {
    id: "hermes:one",
    name: "Hermes One",
    status: "running",
    backend: "webui",
    gateway_url: `${SECRET_BOX_URL}&token=${SECRET_TOKEN}`,
    error: SECRET_ERROR,
  },
};

const hivraSource: WorkspaceSurfaceSource = {
  kind: "hivra",
  uid: "x-codex:one",
  browserEnabled: true,
  agent: {
    id: "codex:one",
    type: "codex",
    name: "Codex One",
    status: "running",
    cpu: 2,
    ram: 4,
    chat_url: SECRET_BOX_URL,
    api_token: SECRET_TOKEN,
    error: SECRET_ERROR,
  },
};

function expectNoSecret(value: string): void {
  expect(value).not.toContain(SECRET_TOKEN);
  expect(value).not.toContain(SECRET_BOX_URL);
  expect(value).not.toContain("SECRET_SIGNED_QUERY");
  expect(value).not.toContain("SECRET_FRAGMENT");
  expect(value).not.toContain(SECRET_ERROR);
}

describe("workspace surface adapters", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: jest.fn() },
    });
    // The box-backed surfaces render RuntimeSurfaceFrame, which probes the
    // runtime's /api/meta before it would send a token. jsdom ships no fetch,
    // so stand one in that fails the probe (the surfaces still render).
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
    }));
  });

  it.each([
    {
      label: "Hermes",
      source: hermesSource,
      expected: ["terminal"],
    },
    {
      label: "Hivra CLI",
      source: hivraSource,
      expected: ["files", "git", "terminal", "browser"],
    },
    {
      label: "Hivra dashboard",
      source: {
        ...hivraSource,
        uid: "x-aeon-one",
        browserEnabled: false,
        agent: {
          ...hivraSource.agent,
          id: "aeon-one",
          name: "Aeon One",
          type: "aeon",
          chat_url: `${SECRET_BOX_URL}&dashboard=1`,
        },
      } satisfies WorkspaceSurfaceSource,
      expected: [],
    },
  ])("emits the exact parsed capability and implemented-support intersection for $label", ({ source, expected }) => {
    const adapter = resolveWorkspaceSurfaceAdapter(source);

    expect(adapter).not.toBeNull();
    expect(adapter!.descriptors.map(({ surface }) => surface)).toEqual(expected);
    expect(adapter!.descriptors.map(({ surface }) => surface)).toEqual(
      adapter!.computer.capabilities.surfaces,
    );
    expect(adapter!.descriptors.every(({ availability }) => availability === "available")).toBe(
      true,
    );
  });

  it("serves matching files, Git, and terminal contracts through bounded real components", () => {
    const hermes = resolveWorkspaceSurfaceAdapter(hermesSource)!;
    const hivra = resolveWorkspaceSurfaceAdapter(hivraSource)!;
    const onBack = jest.fn();

    const view = render(hermes.renderSurface("terminal", onBack)!);
    expect(screen.getByTestId("real-hermes-terminal")).toBeInTheDocument();
    expect(mockedShellTerminal.mock.calls.at(-1)?.[0]).toEqual({
      instanceId: "hermes:one",
      isActive: true,
    });

    view.rerender(hivra.renderSurface("files", onBack)!);
    expect(screen.getByTestId("real-hivra-files")).toBeInTheDocument();
    expect(mockedHivraFiles.mock.calls.at(-1)?.[0]).toEqual({
      boxUrl: SECRET_BOX_URL,
      token: SECRET_TOKEN,
    });

    view.rerender(hivra.renderSurface("git", onBack)!);
    expect(screen.getByTestId("real-hivra-git")).toBeInTheDocument();
    expect(mockedHivraGit.mock.calls.at(-1)?.[0]).toEqual({
      boxUrl: SECRET_BOX_URL,
      token: SECRET_TOKEN,
    });

    expect(mockedFileExplorer).not.toHaveBeenCalled();
  });

  it("gives a Windows computer its desktop instead of generic Linux tools", () => {
    // This test used to assert `descriptors` was EMPTY — and it passed. That was
    // the bug, encoded as an expectation: Windows declares exactly ["desktop"],
    // "desktop" was missing from HIVRA_IMPLEMENTED, so the filter removed
    // everything and the tab strip had nothing to show but a manual
    // "Open fast desktop" button.
    const adapter = resolveWorkspaceSurfaceAdapter({
      ...hivraSource,
      uid: "x-windows-one",
      agent: {
        ...hivraSource.agent,
        id: "windows-one",
        type: "linux-desktop",
        computer_profile: "windows",
      },
    });

    expect(adapter?.computer.capabilities.surfaces).toEqual(["desktop"]);
    expect(adapter?.descriptors.map(({ surface }) => surface)).toEqual(["desktop"]);
    // The Windows box has no Linux Files or web-terminal runtime, so those must
    // stay absent rather than being advertised and then failing to render.
    expect(adapter?.renderSurface("files", jest.fn())).toBeNull();
    expect(adapter?.renderSurface("terminal", jest.fn())).toBeNull();
    expect(adapter?.renderSurface("desktop", jest.fn())).not.toBeNull();
    expect(mockedHivraFiles).not.toHaveBeenCalled();
    expect(mockedHivraGit).not.toHaveBeenCalled();
  });

  it("gives an Ubuntu desktop its desktop and never a terminal fall-through", () => {
    // The owner-visible bug: an Ubuntu computer opened on a terminal. It was
    // neither omarchy nor windows, so the conversation adapter's desktop branch
    // skipped it and it fell through to the box's /terminal/ endpoint.
    const adapter = resolveWorkspaceSurfaceAdapter({
      ...hivraSource,
      uid: "x-ubuntu-one",
      agent: {
        ...hivraSource.agent,
        id: "ubuntu-one",
        type: "linux-desktop",
        computer_profile: "ubuntu-desktop",
      },
    });

    expect(adapter?.descriptors.map(({ surface }) => surface)).toEqual([
      "files",
      "terminal",
      "desktop",
    ]);
    const desktop = render(adapter!.renderSurface("desktop", jest.fn())!);
    expect(desktop.container.querySelector('[data-testid="surface-frame"]')).not.toBeNull();
  });

  it("opens a profile-less computer on the general Linux desktop", () => {
    // A null computer_profile is Ubuntu — the only image before profiles existed.
    const adapter = resolveWorkspaceSurfaceAdapter({
      ...hivraSource,
      uid: "x-profileless-one",
      agent: {
        ...hivraSource.agent,
        id: "profileless-one",
        type: "linux-desktop",
        computer_profile: null,
      },
    });

    expect(adapter?.descriptors.map(({ surface }) => surface)).toContain("desktop");
  });

  it("renders no surface through the bare hand-off frame", () => {
    // Every declared surface now has a real renderer. The bare SurfaceFrame —
    // whose only affordance was "Open this authenticated compatibility surface
    // in a new tab" — must never be the thing a user lands on. SurfaceFrame
    // itself still sanitizes destinations for the renderers that embed it, and
    // that contract is covered by its own describe block below.
    const hermes = resolveWorkspaceSurfaceAdapter(hermesSource)!;
    const hivra = resolveWorkspaceSurfaceAdapter(hivraSource)!;
    const onBack = jest.fn();

    for (const adapter of [hermes, hivra]) {
      for (const { surface } of adapter.descriptors) {
        const view = render(adapter.renderSurface(surface, onBack)!);
        expect(
          screen.queryByText(/Open this authenticated compatibility surface/i),
        ).not.toBeInTheDocument();
        expectNoSecret(view.container.innerHTML);
        view.unmount();
      }
    }
  });

  it("embeds the box's own terminal rather than dead-ending the pane", () => {
    // Hivra declares `terminal` implemented, but the adapter previously rendered
    // SurfaceFrame with no children: a bare header over "Open this authenticated
    // compatibility surface in a new tab". The box serves a real shell at
    // /terminal/, which is what the per-agent page already opens.
    const hivra = resolveWorkspaceSurfaceAdapter(hivraSource)!;
    const view = render(hivra.renderSurface("terminal", jest.fn())!);

    expect(screen.getByTestId("runtime-surface-frame")).toBeInTheDocument();
    expect(
      screen.queryByText(/Open this authenticated compatibility surface/i),
    ).not.toBeInTheDocument();
    // The surface is credentialed — the token must not reach the markup.
    expectNoSecret(view.container.innerHTML);
  });

  it("keeps secret sentinels out of generic adapter state, DOM, clipboard, logs, and analytics", () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      for (const source of [hermesSource, hivraSource]) {
        const adapter = resolveWorkspaceSurfaceAdapter(source)!;
        expect(Object.keys(adapter).sort()).toEqual([
          "computer",
          "descriptors",
          "renderSurface",
          "uid",
        ]);
        expectNoSecret(JSON.stringify(adapter));

        for (const descriptor of adapter.descriptors) {
          const element = adapter.renderSurface(descriptor.surface, jest.fn());
          expect(element).not.toBeNull();
          const view = render(element!);
          expectNoSecret(view.container.innerHTML);
          for (const node of view.container.querySelectorAll("a, iframe")) {
            expectNoSecret(node.getAttribute("href") ?? "");
            expectNoSecret(node.getAttribute("src") ?? "");
            expectNoSecret(node.getAttribute("title") ?? "");
          }
          view.unmount();
        }
      }

      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
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

  it("fails closed for unknown, unsupported, mismatched, stopped, or non-advertised surfaces", () => {
    expect(
      resolveWorkspaceSurfaceAdapter({
        ...hivraSource,
        agent: { ...hivraSource.agent, type: "future-agent" as never },
      }),
    ).toBeNull();
    expect(resolveWorkspaceSurfaceAdapter({ ...hermesSource, uid: "h-someone-else" })).toBeNull();

    const stopped = resolveWorkspaceSurfaceAdapter({
      ...hivraSource,
      agent: { ...hivraSource.agent, status: "stopped" },
    });
    expect(stopped?.descriptors).toEqual([]);
    expect(stopped?.renderSurface("terminal", jest.fn())).toBeNull();

    const noBrowser = resolveWorkspaceSurfaceAdapter({
      ...hivraSource,
      browserEnabled: false,
    });
    expect(noBrowser?.descriptors).not.toContainEqual(
      expect.objectContaining({ surface: "browser" }),
    );
    expect(noBrowser?.renderSurface("browser", jest.fn())).toBeNull();
  });
});

describe("SurfaceFrame", () => {
  it("bounds a safe iframe with specific identity and no duplicate surface chrome", () => {
    render(
      <SurfaceFrame
        agentName="Hermes One"
        surfaceLabel="Workspace"
        accessLabel="Observed: running"
        frameSrc="/dashboard/instances/hermes-one"
        destinationHref="/dashboard/instances/hermes-one"
      />,
    );

    expect(screen.getByTitle("Hermes One — Workspace")).toHaveAttribute(
      "src",
      "/dashboard/instances/hermes-one",
    );
    // The tab strip names the surface. The frame used to repeat it as a 20px
    // display-serif heading and offer a "Back to conversation" button, so the
    // word "Workspace" appeared twice and the only way out was a second control
    // undoing the tab the user had just chosen.
    expect(
      screen.queryByRole("button", { name: "Back to conversation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Workspace" }),
    ).not.toBeInTheDocument();
  });

  it("strips fragments and denies external, credential-shaped, and non-allowlisted destinations", () => {
    const { rerender } = render(
      <SurfaceFrame
        agentName="Codex One"
        surfaceLabel="Terminal"
        accessLabel="Observed: running"
        destinationHref="/dashboard/agent/codex-one?tab=terminal&token=SECRET_SURFACE_TOKEN#SECRET_FRAGMENT"
      />,
    );

    // Only the allowlisted tab survives; the token and fragment are dropped.
    const link = screen.getByRole("link", { name: /Open Terminal/ });
    expect(link).toHaveAttribute(
      "href",
      "/dashboard/agent/codex-one?tab=terminal",
    );
    expectNoSecret(document.body.innerHTML);

    rerender(
      <SurfaceFrame
        agentName="Codex One"
        surfaceLabel="Terminal"
        accessLabel="Observed: running"
        destinationHref={SECRET_BOX_URL}
        frameSrc="javascript:alert(1)"
      />,
    );
    // Neither a hostile destination nor a javascript: frame may render.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Codex One — Terminal")).not.toBeInTheDocument();
    expectNoSecret(document.body.innerHTML);
  });
});
