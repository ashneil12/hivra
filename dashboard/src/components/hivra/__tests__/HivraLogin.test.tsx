/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { HivraLogin } from "../HivraLogin";
import { boxLoginStartRaw } from "@/lib/hivra/agent-api";

jest.mock("@/lib/hivra/agent-api", () => ({
  boxLoginStartRaw: jest.fn(),
  boxLoginComplete: jest.fn(),
  boxLoginStatus: jest.fn(async () => ({ loggedIn: false })),
}));

const start = boxLoginStartRaw as jest.MockedFunction<typeof boxLoginStartRaw>;

function setPointer(coarse: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({ matches: coarse && query.includes("coarse"), media: query }) as MediaQueryList,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setPointer(false);
  jest.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it("accurately explains native credential storage without claiming zero operator access", () => {
  render(<HivraLogin boxUrl="https://box.test" onDone={jest.fn()} agentKind="codex" />);
  expect(screen.getByText(/session is stored on this computer/)).toHaveTextContent("Administrators of its host may have infrastructure access");
  expect(screen.queryByText(/never sees your credentials/)).not.toBeInTheDocument();
});

it("uses touch-neutral copy for the only action", () => {
  render(<HivraLogin boxUrl="https://box.test" onDone={jest.fn()} agentKind="codex" />);
  expect(screen.queryByText(/Click below/)).not.toBeInTheDocument();
  expect(screen.getByText(/Use the button below to open the ChatGPT sign-in page/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Sign in with ChatGPT/ })).toHaveClass("hivra-login__cta");
});

it("always offers the sign-in page and a copy button for the Codex device code, since a popup may be blocked", async () => {
  start.mockResolvedValue({ url: "https://auth.openai.test/device", code: "ABCD-1234", deviceAuth: true });
  const writeText = jest.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<HivraLogin boxUrl="https://box.test" onDone={jest.fn()} agentKind="codex" />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sign in with ChatGPT/ })); });
  expect(screen.queryByText(/sign-in tab opened/)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Open sign-in page/ })).toHaveAttribute("href", "https://auth.openai.test/device");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Copy code/ })); });
  expect(writeText).toHaveBeenCalledWith("ABCD-1234");
  expect(screen.getByRole("button", { name: /Copied/ })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Code copied");
});

it("announces a failed copy with the manual fallback", async () => {
  start.mockResolvedValue({ url: "https://auth.openai.test/device", code: "ABCD-1234", deviceAuth: true });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: jest.fn(async () => { throw new Error("denied"); }) } });
  render(<HivraLogin boxUrl="https://box.test" onDone={jest.fn()} agentKind="codex" />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sign in with ChatGPT/ })); });
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Copy code/ })); });
  expect(screen.getByRole("button", { name: /Select code to copy/ })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Copy failed. Select the code to copy it.");
});

it("keeps a pasted Claude code verbatim and leaves the keyboard down on touch", async () => {
  setPointer(true);
  start.mockResolvedValue({ url: "https://claude.test/oauth", code: null, deviceAuth: false });
  render(<HivraLogin boxUrl="https://box.test" onDone={jest.fn()} agentKind="claude" />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sign in with Claude/ })); });
  const input = screen.getByRole("textbox", { name: "Authorization code" });
  expect(input).toHaveAttribute("autocapitalize", "off");
  expect(input).toHaveAttribute("autocorrect", "off");
  expect(input).toHaveAttribute("spellcheck", "false");
  expect(input).toHaveAttribute("autocomplete", "one-time-code");
  expect(input).toHaveAttribute("enterkeyhint", "go");
  expect(input).not.toHaveFocus();
  expect(screen.getByRole("link", { name: /Open sign-in page/ })).toHaveAttribute("href", "https://claude.test/oauth");
});

it("focuses the Claude code field for a mouse and keyboard", async () => {
  start.mockResolvedValue({ url: "https://claude.test/oauth", code: null, deviceAuth: false });
  render(<HivraLogin boxUrl="https://box.test" onDone={jest.fn()} agentKind="claude" />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sign in with Claude/ })); });
  expect(screen.getByRole("textbox", { name: "Authorization code" })).toHaveFocus();
});

describe("a sign-in link from an agent added to a computer (T28)", () => {
  it.each([
    "https://auth.openai.com/codex/device",
    "https://chatgpt.com/auth/device",
  ])("opens %s, an OpenAI or ChatGPT sign-in host", async (link) => {
    start.mockResolvedValue({ url: link, code: "ABCD-1234", deviceAuth: true });
    render(<HivraLogin boxUrl="https://box.test/agents/x" onDone={jest.fn()} agentKind="codex" untrustedLinks />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sign in with ChatGPT/ })); });
    expect(window.open).toHaveBeenCalledWith(link, "_blank", "noopener,noreferrer");
    expect(screen.getByRole("link", { name: /Open sign-in page/ })).toHaveAttribute("href", link);
  });

  it.each([
    "https://auth.openai.com.evil.test/device",
    "http://auth.openai.com/device",
    "https://user:pass@auth.openai.com/device",
    "https://evil.test/?next=https://chatgpt.com",
    "javascript:alert(1)",
  ])("never opens or links %s, and warns instead", async (link) => {
    start.mockResolvedValue({ url: link, code: "ABCD-1234", deviceAuth: true });
    render(<HivraLogin boxUrl="https://box.test/agents/x" onDone={jest.fn()} agentKind="codex" untrustedLinks />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sign in with ChatGPT/ })); });
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /Open sign-in page/ })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("isn't an OpenAI or ChatGPT page, so Hivra won't open it");
  });

  it("leaves an agent's own computer as it was", async () => {
    start.mockResolvedValue({ url: "https://auth.openai.test/device", code: "ABCD-1234", deviceAuth: true });
    render(<HivraLogin boxUrl="https://box.test" onDone={jest.fn()} agentKind="codex" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sign in with ChatGPT/ })); });
    expect(window.open).toHaveBeenCalled();
  });
});
