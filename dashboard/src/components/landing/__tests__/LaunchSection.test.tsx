/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import LaunchSection from "../LaunchSection";
import ChooseAgentSection from "../ChooseAgentSection";
import ComputersSection from "../ComputersSection";

beforeEach(() => { window.history.replaceState(null, "", "/"); });
const renderChooser = () => render(<><a href="#computers">Computers navigation</a><LaunchSection agents={<ChooseAgentSection embedded />} computers={<ComputersSection embedded />} /></>);

test("both starts remain accessible and OS selection survives a tab round trip", () => {
  renderChooser();
  const agents = screen.getByRole("tab", { name: /Start with an agent/ });
  const computers = screen.getByRole("tab", { name: /Start with a computer/ });
  expect(agents).toHaveAttribute("aria-selected", "true");
  expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
  expect(within(screen.getByRole("tabpanel")).getByRole("heading", {name:"Codex"})).toBeVisible();
  fireEvent.click(computers);
  expect(window.location.hash).toBe("#computers");
  expect(screen.queryByRole("heading",{name:"Codex"})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:/^Windows/}));
  expect(screen.getByRole("link",{name:"Launch Windows"})).toHaveAttribute("href","/dashboard/launch?kind=computer&start=1&profile=windows");
  fireEvent.click(agents);
  fireEvent.click(computers);
  expect(screen.getByRole("img",{name:"Windows workspace illustration"})).toBeVisible();
});

test("keyboard tabs use roving focus and automatic activation", () => {
  renderChooser();
  const agents=screen.getByRole("tab",{name:/Start with an agent/});
  const computers=screen.getByRole("tab",{name:/Start with a computer/});
  agents.focus();
  fireEvent.keyDown(agents,{key:"ArrowRight"});
  expect(computers).toHaveFocus();
  expect(computers).toHaveAttribute("aria-selected","true");
  expect(agents).toHaveAttribute("tabindex","-1");
  fireEvent.keyDown(computers,{key:"Home"});
  expect(agents).toHaveFocus();
  expect(agents).toHaveAttribute("aria-selected","true");
  fireEvent.keyDown(agents,{key:"End"});
  expect(computers).toHaveFocus();
});

test("browser Back to the initial homepage restores the agent starting point", async () => {
  renderChooser();
  fireEvent.click(screen.getByRole("tab", { name: /Start with a computer/ }));
  expect(window.location.hash).toBe("#computers");
  window.history.back();
  await waitFor(() => expect(window.location.hash).toBe(""));
  await waitFor(() => expect(screen.getByRole("tab", { name: /Start with an agent/ })).toHaveAttribute("aria-selected", "true"));
});

test("initial links, navigation links and browser history select the matching panel", async () => {
  window.history.replaceState(null,"","/#computers");
  renderChooser();
  await waitFor(()=>expect(screen.getByRole("tab",{name:/Start with a computer/})).toHaveAttribute("aria-selected","true"));
  window.history.replaceState(null,"","/#agents");
  fireEvent.popState(window);
  expect(screen.getByRole("tab",{name:/Start with an agent/})).toHaveAttribute("aria-selected","true");
  fireEvent.click(screen.getByRole("link",{name:"Computers navigation"}));
  expect(screen.getByRole("tab",{name:/Start with a computer/})).toHaveAttribute("aria-selected","true");
});
