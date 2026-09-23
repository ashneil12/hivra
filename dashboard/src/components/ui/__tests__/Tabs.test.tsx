/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { TabPanel, Tabs, tabDomId, tabPanelDomId } from "../Tabs";

const ITEMS = [
  { id: "one", label: "One" },
  { id: "two", label: "Two" },
  { id: "three", label: "Three" },
] as const;

type Id = (typeof ITEMS)[number]["id"];

function Harness({ initial = "one", onChange }: { initial?: Id; onChange?: (id: Id) => void }) {
  const [value, setValue] = useState<Id>(initial);
  return (
    <>
      <Tabs
        idPrefix="t"
        label="Example sections"
        items={ITEMS}
        value={value}
        onChange={(id) => {
          setValue(id);
          onChange?.(id);
        }}
      />
      {ITEMS.map((item) => (
        <TabPanel key={item.id} idPrefix="t" id={item.id} active={item.id === value}>
          <p>{item.label} content</p>
        </TabPanel>
      ))}
    </>
  );
}

describe("Tabs", () => {
  it("wires tabs and panels with WAI-ARIA roles and ids", () => {
    render(<Harness />);

    expect(screen.getByRole("tablist", { name: "Example sections" })).toBeInTheDocument();
    const tab = screen.getByRole("tab", { name: "Two" });
    expect(tab).toHaveAttribute("id", tabDomId("t", "two"));
    expect(tab).toHaveAttribute("aria-controls", tabPanelDomId("t", "two"));
    expect(tab).toHaveAttribute("aria-selected", "false");

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", tabPanelDomId("t", "one"));
    expect(panel).toHaveAttribute("aria-labelledby", tabDomId("t", "one"));
    expect(panel).toHaveTextContent("One content");
  });

  it("renders only the active panel's content and hides the rest", () => {
    render(<Harness />);

    expect(screen.getByText("One content")).toBeInTheDocument();
    expect(screen.queryByText("Two content")).not.toBeInTheDocument();
    expect(document.getElementById(tabPanelDomId("t", "two"))).toHaveAttribute("hidden");
  });

  it("uses a roving tabindex so only the selected tab is tabbable", () => {
    render(<Harness initial="two" />);

    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Three" })).toHaveAttribute("tabindex", "-1");
  });

  it("selects on click", () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByRole("tab", { name: "Three" }));

    expect(onChange).toHaveBeenCalledWith("three");
    expect(screen.getByRole("tab", { name: "Three" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Three content")).toBeInTheDocument();
  });

  it("moves focus and selection with ArrowRight/ArrowLeft (wrapping), Home and End", () => {
    render(<Harness />);
    const one = screen.getByRole("tab", { name: "One" });
    one.focus();

    fireEvent.keyDown(one, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Two" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Two" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Three" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Three" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "One" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("tab", { name: "One" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Three" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Three" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "One" })).toHaveFocus();
    expect(screen.getByText("One content")).toBeInTheDocument();
  });

  it("ignores other keys", () => {
    const onChange = jest.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole("tab", { name: "One" }), { key: "a" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "One" }), { key: "ArrowDown" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the first tab tabbable when the value matches no tab", () => {
    render(
      <Tabs
        idPrefix="x"
        label="Loose"
        items={ITEMS}
        value={"missing" as Id}
        onChange={() => undefined}
      />
    );

    expect(screen.getByRole("tab", { name: "One" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute("tabindex", "-1");
  });
});
