/** @jest-environment jsdom */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { copyTextToClipboard } from "@/lib/client/clipboard";
import { CodeBlock } from "../CodeBlock";

// The browser gets the ES module build, which jest cannot parse. Highlighting
// is not what this suite exercises: a stand-in shows the code it was given.
jest.mock("react-syntax-highlighter/dist/esm/prism-async-light", () => ({
  __esModule: true,
  default: ({ children, language, showLineNumbers }: { children: string; language: string; showLineNumbers?: boolean }) => (
    <div data-testid="highlighter" data-language={language} data-line-numbers={String(Boolean(showLineNumbers))}>{children}</div>
  ),
}));
jest.mock("@/components/markdown/prism-languages", () => ({ prismLanguage: (name: string) => name }));
jest.mock("@/lib/client/clipboard", () => ({ copyTextToClipboard: jest.fn() }));

describe("chat CodeBlock", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (copyTextToClipboard as jest.Mock).mockResolvedValue(true);
  });
  afterEach(() => jest.useRealTimers());

  it("shows the language in a header with numbered lines below it", () => {
    render(<CodeBlock language="TS" value={"export const SAVE_VERSION = 3;\n"} />);
    expect(screen.getByText("ts")).toBeInTheDocument();
    const body = screen.getByTestId("highlighter");
    expect(body).toHaveAttribute("data-line-numbers", "true");
    expect(body).toHaveAttribute("data-language", "ts");
    expect(body).toHaveTextContent("export const SAVE_VERSION = 3;");
  });

  it("copies the code, says so for a moment, then goes back to the copy icon", async () => {
    render(<CodeBlock language="sh" value={"npm test\n"} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy code" })); });
    expect(copyTextToClipboard).toHaveBeenCalledWith("npm test\n");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
    act(() => { jest.advanceTimersByTime(2100); });
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });

  it("stays on the copy icon when the browser refuses the copy", async () => {
    (copyTextToClipboard as jest.Mock).mockResolvedValue(false);
    render(<CodeBlock language="sh" value="ls" />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy code" })); });
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });
});
