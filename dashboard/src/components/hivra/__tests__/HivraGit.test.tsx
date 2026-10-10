/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HivraGit } from "../HivraGit";
import { gitCheckout, gitDiff, gitStatus, type GitStatus } from "@/lib/hivra/agent-api";

jest.mock("@/lib/hivra/agent-api", () => ({
  gitStatus: jest.fn(),
  gitDiff: jest.fn(),
  gitCommit: jest.fn(),
  gitCheckout: jest.fn(),
}));

const status = gitStatus as jest.MockedFunction<typeof gitStatus>;
const diff = gitDiff as jest.MockedFunction<typeof gitDiff>;
const checkout = gitCheckout as jest.MockedFunction<typeof gitCheckout>;

function repo(entries: GitStatus["entries"] = []): GitStatus {
  return { repo: true, root: ".", branch: "main", branches: ["main", "fix-login"], entries, lastCommit: "abc123 init", error: null };
}

describe("HivraGit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    diff.mockResolvedValue({ diff: "+added line", untracked: false, error: null });
    checkout.mockResolvedValue({ ok: true, error: null });
  });

  it("stages a branch pick and checks out only on Switch when the tree is clean", async () => {
    status.mockResolvedValue(repo());
    render(<HivraGit boxUrl="https://box.test" />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Branch" }), { target: { value: "fix-login" } });
    expect(checkout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(checkout).toHaveBeenCalledWith("https://box.test", ".", "fix-login", false, undefined));
  });

  it("confirms before switching branches with uncommitted changes, and Cancel restores the pick", async () => {
    status.mockResolvedValue(repo([{ x: " ", y: "M", path: "src/app.ts" }]));
    render(<HivraGit boxUrl="https://box.test" />);
    const select = await screen.findByRole("combobox", { name: "Branch" });
    fireEvent.change(select, { target: { value: "fix-login" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    const confirm = screen.getByRole("group", { name: "Confirm branch switch" });
    expect(confirm).toHaveTextContent("Switch to fix-login with 1 uncommitted change?");
    expect(checkout).not.toHaveBeenCalled();
    // Focus starts on the safe choice, so a repeated Enter cannot run the checkout.
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(select).toHaveValue("main");
    expect(select).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Confirm branch switch" })).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: "fix-login" } });
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    const buttons = screen.getAllByRole("button", { name: "Switch" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(checkout).toHaveBeenCalledWith("https://box.test", ".", "fix-login", false, undefined));
  });

  it("keeps a typed branch name exactly as entered on phones", async () => {
    status.mockResolvedValue(repo());
    render(<HivraGit boxUrl="https://box.test" />);
    const input = await screen.findByRole("textbox", { name: "New branch name" });
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("enterkeyhint", "go");
  });

  it("gives the stage box its own label hit area and shows the diff with a way back", async () => {
    status.mockResolvedValue(repo([{ x: " ", y: "M", path: "src/app.ts" }]));
    const { container } = render(<HivraGit boxUrl="https://box.test" />);
    const checkbox = await screen.findByRole("checkbox", { name: "Select src/app.ts" });
    expect(checkbox.closest("label")).not.toBeNull();
    fireEvent.click(checkbox.closest("label")!);
    expect(checkbox).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveAttribute("enterkeyhint", "done");

    const split = container.querySelector("[data-open]")!;
    expect(split).toHaveAttribute("data-open", "false");
    fireEvent.click(screen.getByRole("button", { name: /src\/app\.ts/ }));
    expect(await screen.findByText("+added line")).toBeInTheDocument();
    expect(split).toHaveAttribute("data-open", "true");
    fireEvent.click(screen.getByRole("button", { name: "Back to changes" }));
    expect(split).toHaveAttribute("data-open", "false");
    expect(screen.queryByText("+added line")).not.toBeInTheDocument();
  });

  it("moves focus to Back when the diff replaces the list, and back to the row after", async () => {
    status.mockResolvedValue(repo([{ x: " ", y: "M", path: "src/app.ts" }]));
    const real = window.getComputedStyle.bind(window);
    const style = jest.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const parent = element.parentElement;
      if (parent?.getAttribute("data-open") === "true" && parent.firstElementChild === element) {
        return { display: "none" } as CSSStyleDeclaration;
      }
      return real(element, pseudo);
    });
    try {
      render(<HivraGit boxUrl="https://box.test" />);
      const row = await screen.findByRole("button", { name: /src\/app\.ts/ });
      row.focus();
      fireEvent.click(row);
      expect(screen.getByRole("button", { name: "Back to changes" })).toHaveFocus();
      await screen.findByText("+added line");
      fireEvent.click(screen.getByRole("button", { name: "Back to changes" }));
      expect(screen.getByRole("button", { name: /src\/app\.ts/ })).toHaveFocus();
    } finally {
      style.mockRestore();
    }
  });

  it("keeps focus on the row when the list stays beside the diff", async () => {
    status.mockResolvedValue(repo([{ x: " ", y: "M", path: "src/app.ts" }]));
    render(<HivraGit boxUrl="https://box.test" />);
    const row = await screen.findByRole("button", { name: /src\/app\.ts/ });
    row.focus();
    fireEvent.click(row);
    await screen.findByText("+added line");
    expect(row).toHaveFocus();
  });
});
