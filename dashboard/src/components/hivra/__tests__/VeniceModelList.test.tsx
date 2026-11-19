/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { VeniceModelList } from "../VeniceModelList";

const setup = (props: Partial<React.ComponentProps<typeof VeniceModelList>> = {}) => {
  const onChange = jest.fn();
  render(<VeniceModelList label="Model" value="deepseek-v4-1-flash" onChange={onChange} {...props} />);
  return onChange;
};

it("shows a Suggested group first and marks the selected and current rows", () => {
  setup({ current: "deepseek-v4-pro" });
  const groups = screen.getAllByRole("group");
  expect(groups[0]).toHaveAccessibleName("Suggested");
  expect(within(groups[0]).getAllByRole("option")).toHaveLength(4);
  expect(screen.getByRole("option", { selected: true })).toHaveTextContent("✓");
  expect(screen.getAllByText("Current")).toHaveLength(1);
});

it("filters by name or id, drops Suggested, and explains an empty result", () => {
  setup();
  const search = screen.getByRole("combobox", { name: "Search models" });
  fireEvent.change(search, { target: { value: "KIMI" } });
  expect(screen.queryByRole("group", { name: "Suggested" })).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Kimi" })).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "zzzz-nothing" } });
  expect(screen.getByText("No model matches. Try another name.")).toBeInTheDocument();
});

it("selects with the keyboard and by click", () => {
  const onChange = setup();
  const search = screen.getByRole("combobox", { name: "Search models" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(onChange).toHaveBeenLastCalledWith("deepseek-v4-pro");
  fireEvent.click(screen.getAllByRole("option")[2]);
  expect(onChange).toHaveBeenCalledTimes(2);
});

it("shows an id outside the catalogue at the top", () => {
  setup({ current: "my-private-model", value: "my-private-model" });
  const first = screen.getAllByRole("option")[0];
  expect(first).toHaveTextContent("my-private-model");
  expect(first).toHaveTextContent("Not in Hivra's Venice list");
  expect(first).toHaveTextContent("Current");
});

it("does not select while disabled", () => {
  const onChange = setup({ disabled: true });
  fireEvent.click(screen.getAllByRole("option")[1]);
  expect(onChange).not.toHaveBeenCalled();
});

it("lists only private models when asked to, and says how many", () => {
  setup({ privateOnly: true, current: "claude-opus-4-8", value: "claude-opus-4-8" });
  expect(screen.queryByText("Anonymized")).not.toBeInTheDocument();
  expect(screen.getAllByText("Private").length).toBeGreaterThan(5);
  // An anonymized or unlisted current model is not offered either.
  expect(screen.queryByRole("group", { name: "Not in the list" })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "Claude" })).not.toBeInTheDocument();
  const search = screen.getByRole("combobox", { name: "Search models" });
  expect(search.getAttribute("placeholder")).toMatch(/^Search \d+ private Venice models$/);
  fireEvent.change(search, { target: { value: "claude" } });
  expect(screen.getByText("No model matches. Try another name.")).toBeInTheDocument();
});

it("lists every model, anonymized ones included, by default", () => {
  setup();
  expect(screen.getAllByText("Anonymized").length).toBeGreaterThan(5);
  expect(screen.getByRole("group", { name: "Claude" })).toBeInTheDocument();
});
