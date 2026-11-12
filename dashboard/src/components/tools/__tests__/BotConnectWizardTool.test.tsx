/** @jest-environment jsdom */
// Bot connect wizard component: renders the platform choice and steps, builds the Discord invite link from
// the Application ID and ticked permissions, checks token shape locally without storing or linking it, shares
// only allow-listed answers through the address, offers one start button, and makes no banned claim.
import "@testing-library/jest-dom";
import React from "react";
import fs from "fs";
import path from "path";
import { fireEvent, render, screen, within } from "@testing-library/react";

import BotConnectWizardTool from "../BotConnectWizardTool";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const FAKE_TELEGRAM = `${"1".repeat(10)}:${"A".repeat(35)}`;
const FAKE_DISCORD = `${Buffer.from("123456789012345678").toString("base64url")}.AbCdEf.${"x".repeat(27)}`;

const goToStep = (name: RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const choose = (label: string) => fireEvent.click(within(screen.getByRole("group", { name: /Where do you want to talk/ })).getByLabelText(label));

beforeEach(() => {
  window.history.replaceState(null, "", "/tools/telegram-discord-bot-setup");
  window.localStorage.clear();
});

describe("BotConnectWizardTool", () => {
  it("opens on Telegram step 1 with BotFather instructions and a leak panel", () => {
    render(<BotConnectWizardTool />);
    expect(screen.getByRole("group", { name: /Where do you want to talk/ })).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 5: Create the bot/)).toBeInTheDocument();
    expect(screen.getByText("/newbot")).toBeInTheDocument();
    expect(screen.getByTestId("leak-panel")).toHaveTextContent(/\/revoke/);
  });

  it("moves with Back and Next and marks the current step", () => {
    render(<BotConnectWizardTool />);
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(screen.getByText(/Step 2 of 5: Check the token/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2\. Check the token/ })).toHaveAttribute("aria-current", "step");
    goToStep(/5\. Paste it into your agent/);
    expect(screen.getByRole("button", { name: "Next step" })).toBeDisabled();
  });

  it("switches to Discord, restarts at step 1 and shows the Discord leak guidance", () => {
    render(<BotConnectWizardTool />);
    goToStep(/3\. Find your user id/);
    choose("Discord");
    expect(screen.getByText(/Step 1 of 6: Create the application/)).toBeInTheDocument();
    expect(screen.getByTestId("leak-panel")).toHaveTextContent(/Bot page and reset the token/);
    expect(window.location.search).toBe("?platform=discord");
  });

  it("explains the Message Content intent", () => {
    render(<BotConnectWizardTool />);
    choose("Discord");
    goToStep(/2\. Turn on intents/);
    expect(screen.getByText(/Message Content: required/)).toBeInTheDocument();
  });

  it("builds the invite link from the Application ID and the ticked permissions", () => {
    render(<BotConnectWizardTool />);
    choose("Discord");
    goToStep(/3\. Build the invite link/);
    expect(screen.queryByTestId("invite-url")).toBeNull();
    expect(screen.getByTestId("perm-integer")).toHaveTextContent("117760");
    fireEvent.change(screen.getByLabelText("Application ID"), { target: { value: "123456789012345678" } });
    expect(screen.getByTestId("invite-url")).toHaveTextContent(
      "https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot%20applications.commands&permissions=117760",
    );
    fireEvent.click(screen.getByLabelText("Add reactions"));
    expect(screen.getByTestId("perm-integer")).toHaveTextContent("117824");
    fireEvent.click(screen.getByRole("button", { name: "Chat, reactions and threads" }));
    expect(screen.getByTestId("perm-integer")).toHaveTextContent("309237763136");
    expect(screen.getByRole("link", { name: "Open the link" })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("warns on Administrator and says what is wrong with a bad Application ID", () => {
    render(<BotConnectWizardTool />);
    choose("Discord");
    goToStep(/3\. Build the invite link/);
    fireEvent.change(screen.getByLabelText("Application ID"), { target: { value: "hello" } });
    expect(screen.getByText(/17 to 20 digits/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/^Administrator/));
    expect(screen.getByText(/gives the bot every permission/)).toBeInTheDocument();
  });

  it("puts only the platform and permissions in the address, never the Application ID", () => {
    render(<BotConnectWizardTool />);
    choose("Discord");
    goToStep(/3\. Build the invite link/);
    fireEvent.change(screen.getByLabelText("Application ID"), { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByLabelText("Add reactions"));
    expect(decodeURIComponent(window.location.search)).toBe("?platform=discord&perms=viewChannel,sendMessages,readMessageHistory,embedLinks,attachFiles,addReactions");
    expect(window.location.href).not.toContain("123456789012345678");
  });

  it("keeps a typed token and Application ID out of the address", () => {
    render(<BotConnectWizardTool />);
    choose("Discord");
    goToStep(/3\. Build the invite link/);
    fireEvent.change(screen.getByLabelText("Application ID"), { target: { value: "123456789012345678" } });
    goToStep(/4\. Copy and check the token/);
    fireEvent.change(screen.getByLabelText(/Discord bot token/), { target: { value: FAKE_DISCORD } });
    const where = decodeURIComponent(window.location.search + window.location.hash + window.location.pathname);
    expect(where).not.toContain("123456789012345678");
    expect(where).not.toContain(FAKE_DISCORD);
    expect(where).not.toContain("AbCdEf");
  });

  it("keeps the Application ID across steps, clears the token, and moves focus to the heading", () => {
    render(<BotConnectWizardTool />);
    choose("Discord");
    goToStep(/3\. Build the invite link/);
    fireEvent.change(screen.getByLabelText("Application ID"), { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(screen.getByRole("heading", { level: 3 })).toHaveFocus();
    fireEvent.change(screen.getByLabelText(/Discord bot token/), { target: { value: FAKE_DISCORD } });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByLabelText("Application ID")).toHaveValue("123456789012345678");
    expect(screen.getByTestId("invite-url")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next step" }));
    expect(screen.getByLabelText(/Discord bot token/)).toHaveValue("");
  });

  it("does not steal focus on first render", () => {
    render(<BotConnectWizardTool />);
    expect(screen.getByRole("heading", { level: 3 })).not.toHaveFocus();
  });

  it("reads a shared link on load", () => {
    window.history.replaceState(null, "", "/tools/telegram-discord-bot-setup?platform=discord&perms=viewChannel,sendMessages");
    render(<BotConnectWizardTool />);
    expect(screen.getByRole("radio", { name: "Discord" })).toBeChecked();
    goToStep(/3\. Build the invite link/);
    expect(screen.getByTestId("perm-integer")).toHaveTextContent("3072");
  });

  it("checks a Telegram token's shape without echoing, storing or linking it", () => {
    render(<BotConnectWizardTool />);
    goToStep(/2\. Check the token/);
    const input = screen.getByLabelText(/Telegram bot token/);
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    fireEvent.change(input, { target: { value: FAKE_TELEGRAM } });
    expect(screen.getByTestId("token-result")).toHaveTextContent("The shape is right.");
    expect(screen.getByTestId("token-result")).not.toHaveTextContent(FAKE_TELEGRAM);
    expect(window.location.href).not.toContain("AAAA");
    expect(JSON.stringify({ ...window.localStorage })).not.toContain("AAAA");
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain("AAAA");
    fireEvent.change(input, { target: { value: "12345:short" } });
    expect(screen.getByTestId("token-result")).toHaveTextContent(/not the usual 35/);
    fireEvent.change(input, { target: { value: "nonsense" } });
    expect(screen.getByTestId("token-result")).toHaveTextContent(/no colon/i);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("token-result")).toBeEmptyDOMElement();
  });

  it("can show what was typed, only when asked", () => {
    render(<BotConnectWizardTool />);
    goToStep(/2\. Check the token/);
    fireEvent.click(screen.getByLabelText("Show what I typed"));
    expect(screen.getByLabelText(/Telegram bot token/)).toHaveAttribute("type", "text");
  });

  it("checks a Discord token's shape and tells an ID from a token", () => {
    render(<BotConnectWizardTool />);
    choose("Discord");
    goToStep(/4\. Copy and check the token/);
    const input = screen.getByLabelText(/Discord bot token/);
    fireEvent.change(input, { target: { value: FAKE_DISCORD } });
    expect(screen.getByTestId("token-result")).toHaveTextContent("The shape is right.");
    fireEvent.change(input, { target: { value: "123456789012345678" } });
    expect(screen.getByTestId("token-result")).toHaveTextContent(/ID, not a token/);
  });

  it("shows where each agent takes the token, with a source link and a copy button per command", () => {
    render(<BotConnectWizardTool />);
    goToStep(/5\. Paste it into your agent/);
    const placement = screen.getByTestId("placement");
    expect(placement).toHaveTextContent("TELEGRAM_BOT_TOKEN");
    expect(within(placement).getByRole("link", { name: "Hermes: Telegram setup" })).toHaveAttribute(
      "href",
      "https://hermes-agent.nousresearch.com/docs/user-guide/messaging/telegram",
    );
    fireEvent.click(screen.getByLabelText("OpenClaw"));
    expect(screen.getByTestId("placement")).toHaveTextContent("openclaw channels add --channel telegram --token");
    expect(screen.getAllByRole("button", { name: /^Copy: / }).length).toBeGreaterThan(0);
  });

  it("is honest where OpenClaw's Discord details are not confirmed", () => {
    render(<BotConnectWizardTool />);
    choose("Discord");
    goToStep(/6\. Paste it into your agent/);
    fireEvent.click(screen.getByLabelText("OpenClaw"));
    expect(screen.getByTestId("placement")).toHaveTextContent(/see the agent's own docs/i);
  });

  it("offers one start button at the last step, for the agent chosen", () => {
    render(<BotConnectWizardTool />);
    expect(screen.queryByRole("link", { name: /Start .* on Hivra/ })).toBeNull();
    goToStep(/5\. Paste it into your agent/);
    expect(screen.getByRole("link", { name: /Start Hermes on Hivra/ })).toHaveAttribute("href", `${PUBLIC_START_HREF}?agentType=general`);
    fireEvent.click(screen.getByLabelText("OpenClaw"));
    expect(screen.getAllByRole("link", { name: /Start .* on Hivra/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Start OpenClaw on Hivra/ })).toHaveAttribute("href", `${PUBLIC_START_HREF}?agentType=openclaw`);
  });

  it("makes no banned claim in any step on either platform", () => {
    const { container } = render(<BotConnectWizardTool />);
    for (const platform of ["Telegram", "Discord"]) {
      choose(platform);
      const count = screen.getAllByRole("listitem").length;
      expect(count).toBeGreaterThan(0);
      const buttons = screen.getAllByRole("button", { name: /^\d\. / });
      for (const b of buttons) {
        fireEvent.click(b);
        const text = container.textContent ?? "";
        expect({ platform, step: b.textContent, hits: findBannedClaims(text) }).toEqual({ platform, step: b.textContent, hits: [] });
        expect(unqualifiedKeepRunningClaims(text)).toEqual([]);
        expect(unknownDashboardNames(text)).toEqual([]);
        expect(text).not.toMatch(/[–—]/);
      }
    }
  });
});

describe("source file", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "BotConnectWizardTool.tsx"), "utf8");
  it("makes no network call and keeps nothing in browser storage", () => {
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB|document\.cookie/);
  });
});
