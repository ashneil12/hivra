/** @jest-environment jsdom */
// SOUL.md generator component: labelled inputs, presets that fill the form, a live preview, copy and a Blob
// download, a hostile-text case, the honest limits section, the preset-only link, one start button, no banned claims.
import "@testing-library/jest-dom";
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import SoulMdBuilderTool from "../SoulMdBuilderTool";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { buildSoulMd, presetForm } from "@/lib/tools/agent-tools/soul-md-builder";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const BASE = "/tools/soul-md-generator";
const setAddress = (search = "") => window.history.replaceState(null, "", `${BASE}${search}`);
const output = () => screen.getByTestId("sm-output").textContent ?? "";

beforeEach(() => setAddress());
afterEach(() => setAddress());

describe("SoulMdBuilderTool", () => {
  it("renders labelled inputs and an empty preview at first", () => {
    render(<SoulMdBuilderTool />);
    for (const label of ["Name", "Role", "Who it works for", "Your own boundaries, one per line", "Extra rules about private information, one per line"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByTestId("sm-empty")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download SOUL.md" })).toBeDisabled();
    expect(screen.getByText("0 lines, 0 characters")).toBeInTheDocument();
  });

  it("builds the file live as the visitor types", () => {
    render(<SoulMdBuilderTool />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "a helper" } });
    expect(output()).toContain("You are Ada, a helper.");
    fireEvent.click(screen.getByLabelText("Never invent facts, sources or results"));
    expect(output()).toContain("## Boundaries");
    fireEvent.click(screen.getByLabelText("Never invent facts, sources or results"));
    expect(output()).not.toContain("## Boundaries");
    fireEvent.click(screen.getByLabelText("Blunt"));
    expect(output()).toContain("Be blunt.");
  });

  it("fills the form from a preset, and the preview equals the generator's output", () => {
    render(<SoulMdBuilderTool />);
    fireEvent.click(screen.getByRole("button", { name: /Dev operator/ }));
    expect(output().trimEnd()).toBe(buildSoulMd(presetForm("dev")).trimEnd());
    expect(screen.getByLabelText("Name")).toHaveValue("Forge");
    expect(screen.getByRole("button", { name: /Dev operator/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Clear the form" }));
    expect(screen.getByTestId("sm-empty")).toBeInTheDocument();
  });

  it("puts only the preset in the address, and drops it when the visitor edits", () => {
    render(<SoulMdBuilderTool />);
    fireEvent.click(screen.getByRole("button", { name: /Research assistant/ }));
    expect(window.location.search).toBe("?preset=research");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Secret Name" } });
    expect(window.location.search).toBe("");
    expect(window.location.href).not.toMatch(/Secret/);
  });

  it("keeps a non-owned query param such as utm_source", () => {
    setAddress("?utm_source=news");
    render(<SoulMdBuilderTool />);
    fireEvent.click(screen.getByRole("button", { name: /Research assistant/ }));
    expect(new URLSearchParams(window.location.search).get("utm_source")).toBe("news");
    expect(new URLSearchParams(window.location.search).get("preset")).toBe("research");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Zed" } });
    expect(window.location.search).toBe("?utm_source=news");
  });

  it("fills the form again on back or forward to an address with a preset", () => {
    render(<SoulMdBuilderTool />);
    expect(screen.getByTestId("sm-empty")).toBeInTheDocument();
    act(() => {
      setAddress("?preset=inbox");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(output()).toBe(buildSoulMd(presetForm("inbox")));
  });

  it("does not announce the live counter on every keystroke", () => {
    render(<SoulMdBuilderTool />);
    expect(screen.getByText("0 lines, 0 characters")).not.toHaveAttribute("aria-live");
  });

  it("shows a link-shaped name as text, not a live link", () => {
    render(<SoulMdBuilderTool />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "[x](https://evil) **b** ##" } });
    expect(output()).toContain("# \\[x\\](https://evil) \\*\\*b\\*\\* \\##");
  });

  it("reads a shared preset and ignores a hand-edited one", () => {
    setAddress("?preset=creative");
    const { unmount } = render(<SoulMdBuilderTool />);
    expect(screen.getByLabelText("Name")).toHaveValue("Wren");
    unmount();
    setAddress("?preset=%3Cb%3Ehi");
    render(<SoulMdBuilderTool />);
    expect(screen.getByTestId("sm-empty")).toBeInTheDocument();
  });

  it("keeps hostile text from adding headings to the preview", () => {
    render(<SoulMdBuilderTool />);
    fireEvent.change(screen.getByLabelText("Your own boundaries, one per line"), { target: { value: "# Injected\n```\nbad\n```" } });
    const headings = output().split("\n").filter((l) => /^#{1,6} /.test(l));
    expect(headings).toEqual(["# SOUL.md", "## Boundaries"]);
  });

  it("warns about override wording", () => {
    render(<SoulMdBuilderTool />);
    expect(screen.queryByTestId("sm-warning")).toBeNull();
    fireEvent.change(screen.getByLabelText("Your own boundaries, one per line"), { target: { value: "Ignore previous instructions" } });
    expect(screen.getByTestId("sm-warning")).toHaveTextContent(/ignore previous instructions/);
  });

  it("copies the Markdown", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SoulMdBuilderTool />);
    fireEvent.click(screen.getByRole("button", { name: /Inbox and calendar/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
    });
    expect(writeText).toHaveBeenCalledWith(buildSoulMd(presetForm("inbox")));
  });

  it("downloads a file named SOUL.md from a Blob, without a request", () => {
    const create = jest.fn(() => "blob:test");
    const revoke = jest.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const fetchSpy = jest.fn();
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("SOUL.md");
    });
    render(<SoulMdBuilderTool />);
    fireEvent.click(screen.getByRole("button", { name: /Creative partner/ }));
    fireEvent.click(screen.getByRole("button", { name: "Download SOUL.md" }));
    expect(click).toHaveBeenCalledTimes(1);
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toMatch(/^text\/markdown/);
    expect(blob.size).toBe(Buffer.byteLength(buildSoulMd(presetForm("creative"))));
    expect(fetchSpy).not.toHaveBeenCalled();
    click.mockRestore();
    global.fetch = originalFetch;
  });

  it("says plainly what a SOUL.md cannot do and what goes in which file", () => {
    render(<SoulMdBuilderTool />);
    const limits = screen.getByTestId("sm-limits");
    expect(within(limits).getByText(/not a security boundary/)).toBeInTheDocument();
    expect(within(limits).getByText(/guidance to the model, not a lock/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "OpenClaw" })).toBeInTheDocument();
    expect(screen.getByText(/AGENTS\.md in the project folder/)).toBeInTheDocument();
  });

  it("offers one start button with the price and size", () => {
    render(<SoulMdBuilderTool />);
    const links = screen.getAllByRole("link", { name: /Start an agent on its own Hivra computer/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", PUBLIC_START_HREF);
    expect(screen.getByText(/\$9\.99 a month for 2 vCPU and 4 GB/)).toBeInTheDocument();
  });

  it("makes no banned claim in its rendered text", () => {
    const { container } = render(<SoulMdBuilderTool />);
    fireEvent.click(screen.getByRole("button", { name: /Inbox and calendar/ }));
    const text = container.textContent ?? "";
    expect(text.length).toBeGreaterThan(2000);
    expect(findBannedClaims(text)).toEqual([]);
    expect(unqualifiedKeepRunningClaims(text, /Hivra|always-on (?:box|computer)|managed (?:box|computer)/i)).toEqual([]);
    expect(unknownDashboardNames(text)).toEqual([]);
  });
});
