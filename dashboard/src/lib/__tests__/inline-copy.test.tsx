/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import { Inline, inlineHrefs, parseInline, plainInline } from "../inline-copy";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} data-next-link="" {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

describe("parseInline", () => {
  it("reads bold, code and links, and leaves bare brackets alone", () => {
    expect(parseInline("a **b** [c](/d) `e` [Hivra security]")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", text: "b" },
      { kind: "text", text: " " },
      { kind: "link", label: "c", href: "/d" },
      { kind: "text", text: " " },
      { kind: "code", text: "e" },
      { kind: "text", text: " [Hivra security]" },
    ]);
  });

  it("keeps a code span inside a link label and bold around brackets", () => {
    expect(parseInline("[Security policy (`SECURITY.md`)](https://x.test/a)")).toEqual([
      { kind: "link", label: "Security policy (`SECURITY.md`)", href: "https://x.test/a" },
    ]);
    expect(parseInline("with **[Hivra security]** in")).toEqual([
      { kind: "text", text: "with " },
      { kind: "strong", text: "[Hivra security]" },
      { kind: "text", text: " in" },
    ]);
  });

  it("returns plain text and the link addresses", () => {
    const source = "Email [**info@hivra.cloud**](mailto:info@hivra.cloud). See [`security.txt`](/.well-known/security.txt).";
    expect(plainInline(source)).toBe("Email info@hivra.cloud. See security.txt.");
    expect(inlineHrefs(source)).toEqual(["mailto:info@hivra.cloud", "/.well-known/security.txt"]);
  });
});

describe("Inline", () => {
  it("routes links by kind: app routes through next/link, others as plain anchors, external in a new tab", () => {
    render(
      <p>
        <Inline text="[app](/changelog) [doc](/docs/litepaper/index.html) [txt](/.well-known/security.txt) [mail](mailto:a@b.test) [out](https://github.com/ashneil12/hivra)" />
      </p>,
    );
    expect(screen.getByRole("link", { name: "app" })).toHaveAttribute("data-next-link");
    expect(screen.getByRole("link", { name: "doc" })).not.toHaveAttribute("data-next-link");
    expect(screen.getByRole("link", { name: "txt" })).not.toHaveAttribute("data-next-link");
    expect(screen.getByRole("link", { name: "mail" })).not.toHaveAttribute("target");
    const external = screen.getByRole("link", { name: "out" });
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("resolves {name} placeholders and leaves an unknown one visible so a test can catch it", () => {
    render(
      <p>
        <Inline text="[a]({known}) [b]({unknown})" hrefs={{ known: "/docs/x.html" }} />
      </p>,
    );
    expect(screen.getByRole("link", { name: "a" })).toHaveAttribute("href", "/docs/x.html");
    expect(screen.getByRole("link", { name: "b" })).toHaveAttribute("href", "{unknown}");
  });

  it("renders bold and code as elements", () => {
    const { container } = render(
      <p>
        <Inline text="**not** a `thing`" />
      </p>,
    );
    expect(container.querySelector("strong")?.textContent).toBe("not");
    expect(container.querySelector("code")?.textContent).toBe("thing");
  });
});
