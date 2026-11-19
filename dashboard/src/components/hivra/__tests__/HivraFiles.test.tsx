/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { HivraFiles } from "../HivraFiles";
import type { WorkspaceFilesAccess } from "@/lib/hivra/workspace-browser-bridge";

jest.mock("@/lib/hivra/agent-api", () => ({
  listBoxFiles: jest.fn(), readBoxFile: jest.fn(), writeBoxFile: jest.fn(),
  gitStatus: jest.fn(), gitDiff: jest.fn(), gitCommit: jest.fn(), gitCheckout: jest.fn(),
}));
import { gitStatus, listBoxFiles } from "@/lib/hivra/agent-api";

function access(): WorkspaceFilesAccess & { list: jest.Mock; read: jest.Mock; write: jest.Mock } {
  return {
    list: jest.fn(async (path: string) => ({
      path,
      entries: path === "."
        ? [{ name: "docs", type: "dir", size: 0, mtime: 1 }, { name: "README.md", type: "file", size: 5, mtime: 1 }, { name: "notes.txt", type: "file", size: 3, mtime: 1 }]
        : [{ name: "guide.md", type: "file", size: 4, mtime: 1 }],
      error: null,
    })),
    read: jest.fn(async (path: string) => ({ content: `contents of ${path}`, error: null })),
    write: jest.fn(async () => ({ ok: true, error: null })),
  } as unknown as WorkspaceFilesAccess & { list: jest.Mock; read: jest.Mock; write: jest.Mock };
}

/** Narrow pane: the module's container query hides the list while a file is open. */
function narrowPane() {
  const real = window.getComputedStyle.bind(window);
  return jest.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const parent = element.parentElement;
    if (parent?.getAttribute("data-open") === "true" && parent.firstElementChild === element) {
      return { display: "none" } as CSSStyleDeclaration;
    }
    return real(element, pseudo);
  });
}

async function openAndEdit(files: ReturnType<typeof access>, name = "README.md") {
  render(<HivraFiles boxUrl="https://box.test" access={files} />);
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: `Edit ${name}` }), { target: { value: "my draft" } });
}

describe("HivraFiles", () => {
  it("shows an agent-planted .html or .svg with script as text, never as a page (T10)", async () => {
    const planted: Record<string, string> = {
      "page.html": '<html><body><script>window.__hivraPlanted = 1</script><img src="x" onerror="window.__hivraPlanted = 2"></body></html>',
      "logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__hivraPlanted = 3"><script>window.__hivraPlanted = 4</script></svg>',
    };
    const files = access();
    files.list.mockImplementation(async (path: string) => ({ path, error: null,
      entries: Object.keys(planted).map((name) => ({ name, type: "file", size: planted[name].length, mtime: 1 })) }));
    files.read.mockImplementation(async (path: string) => ({ content: planted[path.replace(/^\.\//, "")], error: null }));
    const { container } = render(<HivraFiles boxUrl="https://box.test" access={files} />);
    for (const name of Object.keys(planted)) {
      fireEvent.click(await screen.findByRole("button", { name: new RegExp(name.replace(".", "\\.")) }));
      const shown = await screen.findByText(planted[name]);
      expect(shown.tagName).toBe("PRE");
      expect(container.querySelector("script, iframe, object, embed, img, [onerror], [onload]")).toBeNull();
      // The only SVGs on the page are the view's own icons.
      expect([...container.querySelectorAll("svg")].every((icon) => icon.classList.contains("lucide"))).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    }
    expect((window as unknown as { __hivraPlanted?: number }).__hivraPlanted).toBeUndefined();
  });

  it("marks the split open with a file so narrow panes show the viewer alone, with a way back", async () => {
    const files = access();
    const { container } = render(<HivraFiles boxUrl="https://box.test" access={files} />);
    await screen.findByRole("button", { name: /README.md/ });
    const split = container.querySelector("[data-open]")!;
    expect(split).toHaveAttribute("data-open", "false");
    fireEvent.click(screen.getByRole("button", { name: /README.md/ }));
    expect(await screen.findByText("contents of README.md")).toBeInTheDocument();
    expect(split).toHaveAttribute("data-open", "true");
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    expect(split).toHaveAttribute("data-open", "false");
    expect(screen.queryByText("contents of README.md")).not.toBeInTheDocument();
  });

  it("keeps iOS from capitalizing or correcting code in the editor", async () => {
    await openAndEdit(access());
    const editor = screen.getByRole("textbox", { name: "Edit README.md" });
    expect(editor).toHaveAttribute("autocapitalize", "off");
    expect(editor).toHaveAttribute("autocorrect", "off");
    expect(editor).toHaveAttribute("autocomplete", "off");
    expect(editor).toHaveAttribute("spellcheck", "false");
  });

  it("hides Close while editing and asks before Back drops a changed draft", async () => {
    await openAndEdit(access());
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    const prompt = screen.getByRole("group", { name: "Unsaved changes" });
    expect(prompt).toHaveTextContent("Discard changes?");
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.getByRole("textbox", { name: "Edit README.md" })).toHaveValue("my draft");
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("contents of README.md")).not.toBeInTheDocument();
  });

  it("asks before opening another file over a changed draft, then opens it on Discard", async () => {
    const files = access();
    await openAndEdit(files);
    fireEvent.click(screen.getByRole("button", { name: /notes.txt/ }));
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(files.read).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("contents of notes.txt")).toBeInTheDocument();
    expect(files.read).toHaveBeenCalledTimes(2);
  });

  it("guards navigating up a folder while a changed draft is open", async () => {
    const files = access();
    render(<HivraFiles boxUrl="https://box.test" access={files} />);
    fireEvent.click(await screen.findByRole("button", { name: /docs/ }));
    fireEvent.click(await screen.findByRole("button", { name: /guide.md/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: /Up/ }));
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    expect(files.list).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(files.list).toHaveBeenCalledTimes(3));
  });

  it("moves focus into the viewer when the list is hidden, and back to the row on Back", async () => {
    const style = narrowPane();
    try {
      render(<HivraFiles boxUrl="https://box.test" access={access()} />);
      const row = await screen.findByRole("button", { name: /README.md/ });
      row.focus();
      fireEvent.click(row);
      await screen.findByText("contents of README.md");
      expect(screen.getByRole("button", { name: "Back to files" })).toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
      expect(screen.getByRole("button", { name: /README.md/ })).toHaveFocus();
    } finally {
      style.mockRestore();
    }
  });

  it("leaves focus on the row when the list stays beside the viewer", async () => {
    render(<HivraFiles boxUrl="https://box.test" access={access()} />);
    const row = await screen.findByRole("button", { name: /README.md/ });
    row.focus();
    fireEvent.click(row);
    await screen.findByText("contents of README.md");
    expect(row).toHaveFocus();
    screen.getByRole("button", { name: "Close" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(row).toHaveFocus();
  });

  it("returns focus to the editor on Keep and to the opening row on Discard", async () => {
    const style = narrowPane();
    try {
      await openAndEdit(access());
      fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
      fireEvent.click(screen.getByRole("button", { name: "Keep" }));
      expect(screen.getByRole("textbox", { name: "Edit README.md" })).toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
      expect(screen.getByRole("button", { name: /README.md/ })).toHaveFocus();
    } finally {
      style.mockRestore();
    }
  });

  it("does not ask when the draft is unchanged", async () => {
    render(<HivraFiles boxUrl="https://box.test" access={access()} />);
    fireEvent.click(await screen.findByRole("button", { name: /README.md/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to files" }));
    expect(screen.queryByText("Discard changes?")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("Changes view (the old Git tab, inside Files)", () => {
  beforeEach(() => {
    (listBoxFiles as jest.Mock).mockReset().mockResolvedValue({ path: ".", entries: [{ name: "app", type: "dir", size: 0, mtime: 1 }], error: null });
    (gitStatus as jest.Mock).mockReset().mockResolvedValue({ repo: true, root: ".", branch: "main", branches: ["main"], lastCommit: "abc first", entries: [{ x: " ", y: "M", path: "src/app.ts" }] });
  });

  it("offers no switch unless the host asks for Changes", async () => {
    render(<HivraFiles boxUrl="https://box.test" token="t" />);
    await screen.findByRole("button", { name: /app/ });
    expect(screen.queryByRole("button", { name: "Changes" })).not.toBeInTheDocument();
    expect(gitStatus).not.toHaveBeenCalled();
  });

  it("never offers it on a shared-folder adapter, which has no git behind it", async () => {
    render(<HivraFiles boxUrl="https://box.test" access={access()} showChanges />);
    await screen.findByRole("button", { name: /README.md/ });
    expect(screen.queryByRole("button", { name: "Changes" })).not.toBeInTheDocument();
  });

  it("switches to Changes with a plain line on what it shows, and back without reloading the folder", async () => {
    render(<HivraFiles boxUrl="https://box.test" token="t" showChanges />);
    await screen.findByRole("button", { name: /app/ });
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Code changes in this computer’s projects")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    expect(screen.getByText("Code changes in this computer’s projects")).toBeVisible();
    expect(await screen.findByText("src/app.ts")).toBeVisible();
    expect(screen.getByRole("button", { name: "Changes" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(screen.getByRole("button", { name: /app/ })).toBeVisible();
    expect(screen.queryByText("src/app.ts")).not.toBeInTheDocument();
    expect(listBoxFiles).toHaveBeenCalledTimes(1);
  });

  it("follows a host that controls the view, and reports the owner's choice", async () => {
    const onViewChange = jest.fn();
    const { rerender } = render(<HivraFiles boxUrl="https://box.test" token="t" showChanges view="changes" onViewChange={onViewChange} />);
    expect(await screen.findByText("src/app.ts")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(onViewChange).toHaveBeenCalledWith("files");
    rerender(<HivraFiles boxUrl="https://box.test" token="t" showChanges view="files" onViewChange={onViewChange} />);
    expect(screen.queryByText("src/app.ts")).not.toBeInTheDocument();
  });

  it("explains an empty Changes view in plain words", async () => {
    (gitStatus as jest.Mock).mockResolvedValue({ repo: false, root: null, branch: null, branches: [], lastCommit: null, entries: [] });
    render(<HivraFiles boxUrl="https://box.test" token="t" showChanges view="changes" />);
    expect(await screen.findByText("No code changes to show yet.")).toBeVisible();
    expect(document.body).not.toHaveTextContent(/git repo|box home/i);
  });
});
