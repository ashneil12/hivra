/** @jest-environment jsdom */
import React, { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ChatComposer } from "../ChatComposer";

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
    think: false,
    onToggleThink: jest.fn(),
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

  it("swaps the send button for a stop square while the agent works", () => {
    const { props } = composer({ busy: true, input: "next" });
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    const stop = screen.getByRole("button", { name: "Stop response" });
    expect(stop).toHaveAttribute("type", "button");
    fireEvent.click(stop);
    expect(props.onStop).toHaveBeenCalledTimes(1);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it("shows the model quietly above the input and no hint below it", () => {
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

  it("keeps attach and think as icon buttons, the think switch reporting its state", () => {
    const { props, rerender } = composer();
    expect(screen.getByRole("button", { name: "Attach a file" })).toBeEnabled();
    const think = screen.getByRole("switch", { name: "Toggle extended reasoning" });
    expect(think).toHaveAttribute("aria-checked", "false");
    fireEvent.click(think);
    expect(props.onToggleThink).toHaveBeenCalledTimes(1);
    rerender(<ChatComposer {...props} think />);
    expect(screen.getByRole("switch", { name: "Toggle extended reasoning" })).toHaveAttribute("aria-checked", "true");
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
});
