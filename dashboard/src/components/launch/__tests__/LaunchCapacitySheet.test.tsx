/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { LaunchCapacitySheet } from "../LaunchCapacitySheet";

// A Capacity page that can open one of its own dialogs, as creating a server does.
jest.mock("@/components/infrastructure/InfrastructureConnectionsPage", () => ({
  InfrastructureConnectionsPage: () => {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <h1 id="launch-capacity-sheet-heading">Add capacity for your launch</h1>
        <button type="button" onClick={() => setOpen(true)}>Create cloud server</button>
        {open ? <div role="dialog" aria-label="Choose a Hetzner server"><button type="button" onClick={() => setOpen(false)}>Cancel</button></div> : null}
      </div>
    );
  },
}));

it("is a dialog over the launch that Escape closes, but not while one of its own dialogs is open", () => {
  const onClose = jest.fn();
  render(<LaunchCapacitySheet launchResourceId="codex" onLaunchTarget={jest.fn()} onClose={onClose} />);
  expect(screen.getByRole("dialog", { name: "Add capacity for your launch" })).toHaveAttribute("aria-modal", "true");

  fireEvent.click(screen.getByRole("button", { name: "Create cloud server" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole("button", { name: "Back to your launch" }));
  expect(onClose).toHaveBeenCalledTimes(2);
});
