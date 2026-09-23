/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const mockRouter = { push: jest.fn(), replace: jest.fn() };
const mockSearch = { get: () => null };
jest.mock("next/navigation", () => ({ useParams: () => ({ id: "narrow-fixture" }), useRouter: () => mockRouter, useSearchParams: () => mockSearch }));
jest.mock("posthog-js", () => ({ capture: jest.fn() }));
jest.mock("@/lib/telemetry/posthog-client", () => ({ captureClient: jest.fn() }));
jest.mock("@/lib/client/logger", () => ({ clientLog: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/components/ShellTerminalWorkspace", () => ({ ShellTerminalWorkspace: () => null }));
jest.mock("@/components/TerminalPanel", () => ({ TerminalPanel: () => null }));
jest.mock("@/components/console/CodexOAuthModal", () => ({ CodexOAuthModal: () => null }));
jest.mock("@/components/explorer/FileExplorer", () => ({ FileExplorer: () => null }));
jest.mock("@/components/instances/AgentSwitcher", () => {
  const { createPortal } = jest.requireActual("react-dom");
  return {
    AgentSwitcher: ({ handleHost, showConsole }: { handleHost?: HTMLElement | null; showConsole?: boolean }) => (
      <>
        <div data-testid="agent-switcher" data-show-console={String(showConsole ?? true)} />
        {handleHost ? createPortal(<button type="button">Agents handle</button>, handleHost) : null}
      </>
    ),
  };
});
jest.mock("@/components/ui/SafePortal", () => ({ SafePortal: ({ children }: { children: ReactNode }) => <>{children}</> }));
jest.mock("@/components/support/ReportProblemLink", () => ({ ReportProblemLink: () => null }));
jest.mock("@/components/webui/WebuiIframe", () => ({ WebuiIframe: () => <div>Native interface</div> }));
jest.mock("@/components/instances/InstanceTelegramConnect", () => ({ InstanceTelegramConnect: () => null }));
jest.mock("@/components/instances/InstanceChannelsPanel", () => ({ InstanceChannelsPanel: () => <div>Channel grid</div> }));
jest.mock("@/components/instances/CommandPanel", () => {
  const { useState } = jest.requireActual("react");
  const { createPortal } = jest.requireActual("react-dom");
  return {
    CommandPanel: function MockCommandPanel(props: { variant?: string; consoleHref?: string; onCollapse?: () => void; onOpenChannels?: (channel?: string) => void }) {
      // Stands in for the Composio app picker: a portaled modal that does not take focus.
      const [pickerOpen, setPickerOpen] = useState(false);
      return (
        <div data-testid={`command-panel-${props.variant ?? "dock"}`} data-console-href={props.consoleHref ?? ""}>
          <button type="button" onClick={props.onCollapse}>Close command panel</button>
          <button type="button" onClick={() => props.onOpenChannels?.()}>View all channels</button>
          <button type="button" onClick={() => setPickerOpen(true)}>Connect apps</button>
          {pickerOpen ? createPortal(
            <div role="dialog" aria-modal="true" aria-label="Connect an app">
              <button type="button" onClick={() => setPickerOpen(false)}>Close picker</button>
            </div>,
            document.body,
          ) : null}
        </div>
      );
    },
  };
});
jest.mock("@/components/storage/StorageUsageBanner", () => ({ StorageUsageBanner: () => null }));
jest.mock("@/components/billing/SleepWakeUpgradePrompt", () => ({ SleepWakeUpgradePrompt: () => null }));
jest.mock("@/components/billing/ArchiveUpgradeWall", () => ({ ArchiveUpgradeWall: () => null }));
jest.mock("@/lib/hivra/agent-api", () => ({ fetchPlanStrict: jest.fn().mockResolvedValue(null), isFreePlanInfo: () => false }));

import InstancePage from "../page";

const fixture = { id: "narrow-fixture", name: "Fixture", status: "running", lifecycle_state: "active", paused_reason: null, ram_limit: 2048, backend: "gateway", gateway_url: "https://fixture.invalid", provider: "hermes", api_key_preview: null, config: {}, created_at: "2026-08-28T00:00:00Z", updated_at: "2026-08-28T00:00:00Z" };
const originalMatchMedia = window.matchMedia;

function setViewport(narrow: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => ({
      matches: narrow && query === "(max-width: 1100px)",
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })),
  });
}

async function renderPage() {
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<InstancePage />); });
  return view;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { ...fixture } }) })) as jest.Mock;
});
afterEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: originalMatchMedia });
});

it("replaces the dock with a toolbar, a console link and a command-panel sheet on narrow viewports", async () => {
  setViewport(true);
  const { container } = await renderPage();

  const toolbar = screen.getByTestId("instance-chat-toolbar");
  expect(within(toolbar).getByRole("link", { name: "Open console" })).toHaveAttribute("href", "/dashboard/instances/narrow-fixture/console");
  // Only the collapsed handle lives in the toolbar. The switcher itself (and
  // so its expanded row) stays in the chat column, after the banner stack.
  expect(within(screen.getByTestId("instance-chat-toolbar-switcher")).getByRole("button", { name: "Agents handle" })).toBeInTheDocument();
  const switcher = screen.getByTestId("agent-switcher");
  expect(toolbar).not.toContainElement(switcher);
  expect(screen.getByTestId("instance-chat-column")).toContainElement(switcher);
  expect(switcher).toHaveAttribute("data-show-console", "false");
  const bannerStack = container.querySelector(".instance-chat-banner-stack") as HTMLElement;
  expect(bannerStack.compareDocumentPosition(switcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(bannerStack).not.toContainElement(switcher);
  expect(screen.queryByTestId("instance-command-panel-dock")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Command panel" })).not.toBeInTheDocument();

  const trigger = screen.getByRole("button", { name: "Open command panel" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);

  const sheet = screen.getByRole("dialog", { name: "Command panel" });
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(within(sheet).getByTestId("command-panel-sheet")).toHaveAttribute("data-console-href", "/dashboard/instances/narrow-fixture/console");

  // Escape with focus inside the sheet closes it and returns focus to the trigger.
  within(sheet).getByRole("button", { name: "Close command panel" }).focus();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Command panel" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();

  // The backdrop and the panel's own close control dismiss it too.
  fireEvent.click(trigger);
  fireEvent.click(screen.getByTestId("instance-command-panel-sheet-backdrop"));
  expect(screen.queryByRole("dialog", { name: "Command panel" })).not.toBeInTheDocument();
  fireEvent.click(trigger);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Command panel" })).getByRole("button", { name: "Close command panel" }));
  expect(screen.queryByRole("dialog", { name: "Command panel" })).not.toBeInTheDocument();
});

it("keeps the channels modal reachable from the sheet with a pinned close control", async () => {
  setViewport(true);
  await act(async () => { render(<InstancePage />); });

  fireEvent.click(screen.getByRole("button", { name: "Open command panel" }));
  fireEvent.click(screen.getByRole("button", { name: "View all channels" }));

  const channels = screen.getByRole("dialog", { name: "Connect channels" });
  expect(within(channels).getByText("Channel grid")).toBeInTheDocument();
  // Escape inside the channels modal must not also close the sheet underneath.
  const close = within(channels).getByRole("button", { name: "Close" });
  expect(close).toHaveFocus();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "Command panel" })).toBeInTheDocument();
  fireEvent.click(close);
  expect(screen.queryByRole("dialog", { name: "Connect channels" })).not.toBeInTheDocument();
});

it("keeps the docked panel and no toolbar on wide viewports", async () => {
  setViewport(false);
  await act(async () => { render(<InstancePage />); });

  expect(screen.getByTestId("instance-command-panel-dock")).toBeInTheDocument();
  expect(screen.getByTestId("command-panel-dock")).toBeInTheDocument();
  expect(screen.queryByTestId("instance-chat-toolbar")).not.toBeInTheDocument();
  expect(screen.getByTestId("agent-switcher")).toHaveAttribute("data-show-console", "true");
  expect(screen.queryByRole("button", { name: "Agents handle" })).not.toBeInTheDocument();
});

it("leaves keys to a modal opened from the sheet even when that modal never takes focus", async () => {
  setViewport(true);
  await renderPage();

  fireEvent.click(screen.getByRole("button", { name: "Open command panel" }));
  const sheet = screen.getByRole("dialog", { name: "Command panel" });
  const connect = within(sheet).getByRole("button", { name: "Connect apps" });
  connect.focus();
  fireEvent.click(connect);
  expect(screen.getByRole("dialog", { name: "Connect an app" })).toBeInTheDocument();
  expect(connect).toHaveFocus();

  // Neither Escape nor Tab is handled by the sheet while the picker is open.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "Command panel" })).toBeInTheDocument();
  const last = Array.from(sheet.querySelectorAll("button")).at(-1) as HTMLElement;
  last.focus();
  expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(true);
  expect(last).toHaveFocus();

  // Once it closes, the sheet owns Escape again.
  fireEvent.click(screen.getByRole("button", { name: "Close picker" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Command panel" })).not.toBeInTheDocument();
});

it("pulls focus back into the sheet on Tab when it has dropped to the page", async () => {
  setViewport(true);
  await renderPage();

  fireEvent.click(screen.getByRole("button", { name: "Open command panel" }));
  const sheet = screen.getByRole("dialog", { name: "Command panel" });
  (document.activeElement as HTMLElement | null)?.blur();
  expect(fireEvent.keyDown(document, { key: "Tab" })).toBe(false);
  expect(sheet).toContainElement(document.activeElement as HTMLElement);
});

it("marks activation nudges so the capped phone stack lists system alerts first", async () => {
  setViewport(true);
  (global.fetch as jest.Mock).mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      success: true,
      data: {
        ...fixture,
        failureAlert: { owner: "hivra", ownerLabel: "Hivra", phase: "update", phaseLabel: "Update", recoveryAction: "repair", recoveryLabel: "Repair runtime", title: "Runtime update failed", message: "Gateway did not return.", lastSeenAt: "2026-09-20T00:00:00Z" },
      },
    }),
  }));
  const { container } = await renderPage();

  expect(screen.getByTestId("instance-standing-tasks-banner")).toHaveClass("instance-chat-banner-nudge");
  expect(screen.getByTestId("instance-failure-alert")).not.toHaveClass("instance-chat-banner-nudge");
  const css = Array.from(container.querySelectorAll("style")).map((style) => style.textContent).join("");
  expect(css).toMatch(/@media \(max-width: 640px\)[^@]*\.instance-chat-banner-nudge \{ order: 1; \}/);
});

it("offers retry and a way back when the instance fails to load", async () => {
  setViewport(true);
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ success: false, error: "Upstream timeout" }) });
  await act(async () => { render(<InstancePage />); });

  expect(screen.getByText("Upstream timeout")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to agents" }));
  expect(mockRouter.push).toHaveBeenCalledWith("/dashboard/agents");

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
  expect((fetch as jest.Mock).mock.calls.map(([url]) => url)).toContain("/api/instances/narrow-fixture");
  expect(screen.getByTestId("instance-chat-toolbar")).toBeInTheDocument();
});
