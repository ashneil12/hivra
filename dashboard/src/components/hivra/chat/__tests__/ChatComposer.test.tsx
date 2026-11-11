/** @jest-environment jsdom */
import React, { createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ChatComposer } from "../ChatComposer";
import type { BoxChatControls } from "../useBoxChatControls";

jest.mock("@/components/ui/ThinkingOrb", () => ({ ThinkingOrb: () => <span data-testid="orb" /> }));

type Props = React.ComponentProps<typeof ChatComposer>;

function composer(patch: Partial<Props> = {}) {
  const props: Props = {
    agentName: "Atlas",
    input: "",
    onInputChange: jest.fn(),
    onSend: jest.fn(),
    onStop: jest.fn(),
    busy: false,
    coarsePointer: false,
    composerCap: 160,
    modelLabel: "Claude Code (default)",
    canUpload: true,
    attachments: [],
    onRemoveAttachment: jest.fn(),
    uploading: false,
    attachError: null,
    onUploadFile: jest.fn(),
    textareaRef: createRef<HTMLTextAreaElement>(),
    dockRef: createRef<HTMLDivElement>(),
    ...patch,
  };
  return { props, ...render(<ChatComposer {...props} />) };
}

describe("ChatComposer", () => {
  it("has one icon button in the input that sends, and it waits for something to send", () => {
    const { props, rerender } = composer();
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("type", "submit");
    expect(send).not.toHaveTextContent(/\S/);
    expect(screen.queryByRole("button", { name: "Stop response" })).not.toBeInTheDocument();

    rerender(<ChatComposer {...props} input="ship it" />);
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(props.onSend).toHaveBeenCalledWith("ship it");
  });

  it("swaps the send button for a stop square while the agent works with nothing typed", () => {
    const { props } = composer({ busy: true, input: "" });
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    const stop = screen.getByRole("button", { name: "Stop response" });
    expect(stop).toHaveAttribute("type", "button");
    fireEvent.click(stop);
    expect(props.onStop).toHaveBeenCalledTimes(1);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("queues what is typed while the agent works, instead of stopping it", () => {
    const { props } = composer({ busy: true, input: "next" });
    expect(screen.queryByRole("button", { name: "Stop response" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
    expect(props.onSend).toHaveBeenCalledWith("next");
    expect(props.onStop).not.toHaveBeenCalled();
  });

  it("names the model quietly in the toolbar, with no hint below the input", () => {
    composer();
    expect(screen.getByText("Claude Code (default)")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Atlas" })).toHaveAttribute("placeholder", "Message Atlas");
    expect(screen.queryByText(/Enter to send/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Runs the official agent CLI/i)).not.toBeInTheDocument();
  });

  it("sends on Enter, keeps Shift+Enter and IME composition as newlines, and leaves Return alone on touch", () => {
    const { props } = composer({ input: "hello" });
    const box = screen.getByRole("textbox", { name: "Message Atlas" });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(props.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(props.onSend).toHaveBeenCalledWith("hello");
  });

  it("does not send on Enter with a touch keyboard", () => {
    const { props } = composer({ input: "hello", coarsePointer: true });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message Atlas" }), { key: "Enter" });
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("has no Think switch: the effort is picked from the model pill", () => {
    composer();
    expect(screen.getByRole("button", { name: "Attach a file" })).toBeEnabled();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText(/think/i)).not.toBeInTheDocument();
  });

  it("stops at five attachments, lists them as chips and reports an upload error", () => {
    const attachments = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, path: `/box/f${i}.txt` }));
    const { props } = composer({ attachments, attachError: "Upload failed — try again" });
    expect(screen.getByRole("button", { name: "Attach a file" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove f2.txt" }));
    expect(props.onRemoveAttachment).toHaveBeenCalledWith("/box/f2.txt");
    expect(screen.getByRole("alert")).toHaveTextContent("Upload failed — try again");
  });

  it("offers no attach button, and ignores a pasted image, without a token", () => {
    const { props } = composer({ canUpload: false });
    expect(screen.queryByRole("button", { name: "Attach a file" })).not.toBeInTheDocument();
    const file = new File(["x"], "p.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("textbox", { name: "Message Atlas" }), { clipboardData: { items: [{ type: "image/png", getAsFile: () => file }] } });
    expect(props.onUploadFile).not.toHaveBeenCalled();
  });

  it("uploads a pasted image", () => {
    const { props } = composer();
    const file = new File(["x"], "p.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("textbox", { name: "Message Atlas" }), { clipboardData: { items: [{ type: "image/png", getAsFile: () => file }] } });
    expect(props.onUploadFile).toHaveBeenCalledWith(file);
  });

  describe("the model, effort and access pickers", () => {
    function controls(patch: Partial<BoxChatControls> = {}): BoxChatControls {
      return {
        agentKind: "claude",
        models: [{ value: "", label: "Default" }, { value: "opus", label: "Opus" }, { value: "sonnet", label: "Sonnet" }],
        model: "",
        modelName: "Default",
        changeModel: jest.fn(),
        effortLevels: ["low", "medium", "high"],
        effort: null,
        changeEffort: jest.fn(),
        restrict: "",
        changeRestrict: jest.fn(),
        pending: false,
        error: null,
        ...patch,
      };
    }

    it("lists the models and only the effort levels the computer takes, and applies a pick", () => {
      const c = controls();
      composer({ controls: c });
      fireEvent.click(screen.getByRole("button", { name: "Model: Default" }));
      const menu = screen.getByRole("menu", { name: "Model and effort" });
      expect(within(menu).getAllByRole("menuitemradio").map((el) => el.textContent)).toEqual(["Default", "Opus", "Sonnet", "Default", "Low", "Medium", "High"]);
      expect(within(menu).queryByText("Max")).not.toBeInTheDocument();
      fireEvent.click(within(menu).getByRole("menuitemradio", { name: "High" }));
      expect(c.changeEffort).toHaveBeenCalledWith("high");
      expect(screen.queryByRole("menu", { name: "Model and effort" })).not.toBeInTheDocument();
    });

    it("changes the model from the menu and shows the effort picked on the pill", () => {
      const c = controls({ effort: "medium", model: "opus", modelName: "Opus" });
      composer({ controls: c });
      expect(screen.getByRole("button", { name: "Model: Opus, Medium effort" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Model: Opus, Medium effort" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Sonnet" }));
      expect(c.changeModel).toHaveBeenCalledWith("sonnet");
    });

    it("clears the effort with Default, back to the agent's own", () => {
      const c = controls({ effort: "high" });
      composer({ controls: c });
      fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
      const items = screen.getAllByRole("menuitemradio", { name: "Default" });
      fireEvent.click(items[1]);
      expect(c.changeEffort).toHaveBeenCalledWith(null);
    });

    it("has no effort section when the computer offers no levels", () => {
      composer({ controls: controls({ effortLevels: [] }) });
      fireEvent.click(screen.getByRole("button", { name: "Model: Default" }));
      expect(screen.queryByText("Effort")).not.toBeInTheDocument();
      expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    });

    it("shows the model as a quiet label when there is nothing to change", () => {
      composer({ controls: controls({ models: [], effortLevels: [], modelName: "Default" }) });
      expect(screen.queryByRole("button", { name: /^Model:/ })).not.toBeInTheDocument();
      expect(screen.getByText("Claude Code (default)")).toBeInTheDocument();
    });

    it("changes access from its own pill, and has none on a computer without the setting", () => {
      const c = controls();
      const { rerender, props } = composer({ controls: c });
      fireEvent.click(screen.getByRole("button", { name: "Access: Full access" }));
      fireEvent.click(screen.getByRole("option", { name: /Read-only/ }));
      expect(c.changeRestrict).toHaveBeenCalledWith("readonly");
      rerender(<ChatComposer {...props} controls={controls({ restrict: null })} />);
      expect(screen.queryByRole("button", { name: /^Access:/ })).not.toBeInTheDocument();
    });

    it("says a model or access change failed", () => {
      composer({ controls: controls({ error: "Couldn't change the model" }) });
      expect(screen.getByRole("alert")).toHaveTextContent("Couldn't change the model");
    });
  });

  describe("the context meter", () => {
    it("shows a ring only once the agent has reported both the level and the window", () => {
      const { props, rerender } = composer();
      expect(screen.queryByRole("img", { name: /context/i })).not.toBeInTheDocument();
      rerender(<ChatComposer {...props} context={{ used: 40_000 }} />);
      expect(screen.queryByRole("img", { name: /context/i })).not.toBeInTheDocument();
      rerender(<ChatComposer {...props} context={{ used: 40_000, window: 200_000 }} />);
      expect(screen.getByRole("img", { name: /20%/ })).toBeInTheDocument();
    });
  });

  describe("the message queue", () => {
    const queued = [
      { id: "q1", text: "then run the tests", attachments: [] },
      { id: "q2", text: "and summarise", attachments: [] },
    ];

    it("lists what is queued, with edit and remove for each", () => {
      const onQueueDelete = jest.fn();
      const onQueueEdit = jest.fn();
      composer({ busy: true, queued, onQueueDelete, onQueueEdit });
      expect(screen.getByText("then run the tests")).toBeInTheDocument();
      expect(screen.getByText("and summarise")).toBeInTheDocument();
      fireEvent.click(screen.getAllByRole("button", { name: "Remove queued message" })[1]);
      expect(onQueueDelete).toHaveBeenCalledWith("q2");
      fireEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[0]);
      const box = screen.getByRole("textbox", { name: "Edit queued message" });
      fireEvent.change(box, { target: { value: "then run the linter" } });
      fireEvent.click(screen.getByRole("button", { name: "Save queued message" }));
      expect(onQueueEdit).toHaveBeenCalledWith("q1", "then run the linter");
    });

    it("says the queue is paused after a stop, and resumes it", () => {
      const onQueueResume = jest.fn();
      composer({ queued, queuePaused: true, onQueueResume });
      expect(screen.getByText("Queue paused because you stopped the reply")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
      expect(onQueueResume).toHaveBeenCalledTimes(1);
    });

    it("shows nothing for an empty queue", () => {
      composer({ queued: [] });
      expect(screen.queryByText(/Queue paused/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove queued message" })).not.toBeInTheDocument();
    });
  });

  it("shows an attached image as a small picture and a text file as a chip, and the drop hint while dragging", () => {
    const attachments = [
      { name: "shot.png", path: "/box/shot.png", preview: "blob:shot" },
      { name: "notes.txt", path: "/box/notes.txt" },
    ];
    const { props, rerender } = composer({ attachments });
    expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
    rerender(<ChatComposer {...props} fileDrag />);
    expect(screen.getByText("Drop files to attach")).toBeInTheDocument();
  });
});
