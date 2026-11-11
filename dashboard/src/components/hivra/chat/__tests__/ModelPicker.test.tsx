/** @jest-environment jsdom */
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ModelControlPills, ModelPicker, nextModel, type ModelPickerProps } from "../ModelPicker";

jest.mock("@/components/ui/ThinkingOrb", () => ({ ThinkingOrb: () => <span data-testid="orb" /> }));

const CLAUDE_MODELS = [{ value: "", label: "Default" }, { value: "fable", label: "Fable" }, { value: "opus", label: "Opus" }, { value: "sonnet", label: "Sonnet" }, { value: "haiku", label: "Haiku" }];
const ALL = ["low", "medium", "high", "xhigh", "max"] as const;

function picker(patch: Partial<ModelPickerProps> = {}) {
  const props: ModelPickerProps = {
    cliKind: "claude",
    modelName: "Default",
    model: "",
    models: CLAUDE_MODELS,
    onModelChange: jest.fn(),
    effortLevels: ALL,
    effort: null,
    onEffortChange: jest.fn(),
    effortReady: true,
    effortUpdate: { state: "idle", message: null, available: true },
    onEffortUpdate: jest.fn(),
    onClose: jest.fn(),
    ...patch,
  };
  return { props, ...render(<ModelPicker {...props} />) };
}

const open = () => fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
const rootMenu = () => screen.getByRole("menu", { name: "Model and effort" });
const levelsIn = (menu: HTMLElement) => within(menu).getAllByRole("menuitemradio").map((el) => el.textContent);

beforeEach(() => window.localStorage.clear());

describe("ModelPicker", () => {
  describe("the trigger", () => {
    it("names the model and the effort picked", () => {
      picker({ model: "opus", modelName: "Opus", effort: "xhigh" });
      const trigger = screen.getByRole("button", { name: "Model: Opus, Extra high effort" });
      expect(trigger).toHaveTextContent("OpusExtra high");
      expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    });

    it("shows an effort mark, not a level, while the agent's own default is in use", () => {
      const { container } = picker();
      expect(screen.getByRole("button", { name: "Model: Default" })).toHaveAttribute("title", expect.stringContaining("Effort: Default"));
      expect(container.querySelector("[data-pill-effort-default]")).toBeInTheDocument();
    });

    it("is a plain label when there is nothing to choose", () => {
      picker({ models: [], effortLevels: [], modelName: "Venice Large" });
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.getByText("Venice Large")).toBeInTheDocument();
    });

    it("is disabled while a change is being applied", () => {
      picker({ pending: true });
      expect(screen.getByRole("button", { name: /^Model:/ })).toBeDisabled();
    });
  });

  describe("effort levels", () => {
    it("lists all five for Claude Code, Default first, from the Effort row", () => {
      picker();
      open();
      expect(within(rootMenu()).getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["EffortDefault", "ModelDefault"]);
      fireEvent.click(screen.getByRole("menuitem", { name: /^Effort/ }));
      expect(levelsIn(screen.getByRole("menu", { name: "Effort" }))).toEqual(["Default", "Low", "Medium", "High", "Extra high", "Max"]);
    });

    it("lists low to extra high for Codex", () => {
      picker({ cliKind: "codex", effortLevels: ["low", "medium", "high", "xhigh"], models: [{ value: "", label: "Default" }, { value: "gpt-5.5", label: "GPT-5.5" }] });
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Effort/ }));
      expect(levelsIn(screen.getByRole("menu", { name: "Effort" }))).toEqual(["Default", "Low", "Medium", "High", "Extra high"]);
    });

    it("marks the level in use and lights the strongest levels with the tile shimmer", () => {
      picker({ effort: "max" });
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Effort/ }));
      const submenu = screen.getByRole("menu", { name: "Effort" });
      expect(within(submenu).getByRole("menuitemradio", { name: "Max" })).toHaveAttribute("aria-checked", "true");
      expect(within(submenu).getByRole("menuitemradio", { name: "Max" })).toHaveAttribute("data-effort-tone", "max");
      expect(within(submenu).getByRole("menuitemradio", { name: "Extra high" })).toHaveAttribute("data-effort-tone", "strong");
      expect(within(submenu).getByRole("menuitemradio", { name: "Low" })).not.toHaveAttribute("data-effort-tone");
      expect(within(submenu).getByRole("menuitemradio", { name: "Max" }).querySelectorAll("span[aria-hidden] > span")).toHaveLength(160);
    });

    it("applies a level and closes the menu, handing focus back", () => {
      const { props } = picker();
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Effort/ }));
      fireEvent.click(within(screen.getByRole("menu", { name: "Effort" })).getByRole("menuitemradio", { name: "Low" }));
      expect(props.onEffortChange).toHaveBeenCalledWith("low");
      expect(props.onClose).toHaveBeenCalled();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  describe("a computer whose chat service does not take effort yet", () => {
    const old = { effortReady: false } as const;

    it("still lists the levels, and says it needs a quick update when one is picked", () => {
      const { props } = picker(old);
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Effort/ }));
      const submenu = screen.getByRole("menu", { name: "Effort" });
      expect(levelsIn(submenu)).toEqual(["Default", "Low", "Medium", "High", "Extra high", "Max"]);
      expect(screen.queryByText(/quick update/)).not.toBeInTheDocument();
      fireEvent.click(within(submenu).getByRole("menuitemradio", { name: "High" }));
      expect(screen.getByText("This computer needs a quick update to use effort levels.")).toBeInTheDocument();
      // The menu stays open for the note, and the level is only handed on to be held.
      expect(rootMenu()).toBeInTheDocument();
      expect(props.onEffortChange).toHaveBeenCalledWith("high");
    });

    it("starts the update from the Update now button", () => {
      const { props } = picker(old);
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Effort/ }));
      fireEvent.click(within(screen.getByRole("menu", { name: "Effort" })).getByRole("menuitemradio", { name: "Max" }));
      fireEvent.click(screen.getByRole("button", { name: "Update now" }));
      expect(props.onEffortUpdate).toHaveBeenCalledTimes(1);
    });

    it("does not call picking the agent's own default an update matter", () => {
      const { props } = picker(old);
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Effort/ }));
      fireEvent.click(within(screen.getByRole("menu", { name: "Effort" })).getByRole("menuitemradio", { name: "Default" }));
      expect(screen.queryByText(/quick update/)).not.toBeInTheDocument();
      expect(props.onClose).toHaveBeenCalled();
    });

    it("shows progress while updating, then the outcome", () => {
      const { props, rerender } = picker({ ...old, effortUpdate: { state: "updating", message: null, available: true } });
      open();
      expect(screen.getByRole("status")).toHaveTextContent("Updating this computer. Effort levels turn on as soon as it is back.");
      expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();

      rerender(<ModelPicker {...props} {...old} effortUpdate={{ state: "failed", message: "Start this computer first.", available: true }} />);
      expect(screen.getByRole("status")).toHaveTextContent("Start this computer first.");
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();

      rerender(<ModelPicker {...props} effortReady effortUpdate={{ state: "ready", message: null, available: true }} />);
      expect(screen.getByRole("status")).toHaveTextContent("Effort levels are on for this computer.");
    });

    it("points to Manage when no update can be started from here", () => {
      picker({ ...old, effortUpdate: { state: "idle", message: null, available: false } });
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Effort/ }));
      fireEvent.click(within(screen.getByRole("menu", { name: "Effort" })).getByRole("menuitemradio", { name: "Low" }));
      expect(screen.getByText(/Open Manage and choose Update connection service/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
    });

    it("holds a pick quietly while the computer has not answered yet", () => {
      const { props } = picker({ ...old, effortUpdate: { state: "checking", message: null, available: true } });
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Effort/ }));
      fireEvent.click(within(screen.getByRole("menu", { name: "Effort" })).getByRole("menuitemradio", { name: "Low" }));
      expect(props.onEffortChange).toHaveBeenCalledWith("low");
      expect(screen.queryByText(/quick update/)).not.toBeInTheDocument();
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  describe("the keyboard", () => {
    it("moves through the rows, opens a submenu with Right, picks with Enter and closes with Escape", () => {
      const { props } = picker();
      open();
      const menu = rootMenu();
      // Effort is the first row: Right opens its levels, Down moves to Low, Enter picks it.
      fireEvent.keyDown(menu, { key: "ArrowRight" });
      expect(screen.getByRole("menu", { name: "Effort" })).toBeInTheDocument();
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      fireEvent.keyDown(menu, { key: "Enter" });
      expect(props.onEffortChange).toHaveBeenCalledWith("low");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      open();
      fireEvent.keyDown(rootMenu(), { key: "Escape" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("walks the effort levels with the arrows and goes back with Left", () => {
      picker({ effort: "medium" });
      open();
      const menu = rootMenu();
      fireEvent.keyDown(menu, { key: "ArrowRight" });
      const submenu = screen.getByRole("menu", { name: "Effort" });
      // It opens on the level in use; Up goes to Low.
      fireEvent.keyDown(menu, { key: "ArrowUp" });
      expect(within(submenu).getByRole("menuitemradio", { name: "Low" })).toHaveAttribute("data-active");
      fireEvent.keyDown(menu, { key: "ArrowLeft" });
      expect(screen.queryByRole("menu", { name: "Effort" })).not.toBeInTheDocument();
      // With no submenu open the arrows move between the two rows.
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(screen.getByRole("menuitem", { name: /^Model/ })).toHaveAttribute("data-active");
    });

    it("chooses a model from the flyout with the keys, searching first", async () => {
      const { props } = picker();
      open();
      fireEvent.keyDown(rootMenu(), { key: "ArrowDown" });
      fireEvent.keyDown(rootMenu(), { key: "ArrowRight" });
      const flyout = screen.getByRole("dialog", { name: "Models" });
      const search = within(flyout).getByRole("textbox", { name: "Search models" });
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); });
      expect(search).toHaveFocus();
      fireEvent.change(search, { target: { value: "on" } });
      expect(within(flyout).getAllByRole("option").map((el) => el.textContent)).toEqual(["Sonnet"]);
      fireEvent.keyDown(search, { key: "Enter" });
      expect(props.onModelChange).toHaveBeenCalledWith("sonnet");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("moves the highlight in the flyout with the arrows", () => {
      const { props } = picker();
      open();
      fireEvent.keyDown(rootMenu(), { key: "ArrowDown" });
      fireEvent.keyDown(rootMenu(), { key: "ArrowRight" });
      const search = screen.getByRole("textbox", { name: "Search models" });
      fireEvent.keyDown(search, { key: "ArrowDown" });
      fireEvent.keyDown(search, { key: "ArrowDown" });
      fireEvent.keyDown(search, { key: "Enter" });
      // The list opens on the model in use (Default); two steps down is Opus.
      expect(props.onModelChange).toHaveBeenCalledWith("opus");
    });
  });

  describe("the model flyout", () => {
    const openModels = () => {
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Model/ }));
      return screen.getByRole("dialog", { name: "Models" });
    };

    it("changes the model and says nothing when the same one is picked", () => {
      const { props } = picker({ model: "opus", modelName: "Opus" });
      const flyout = openModels();
      expect(within(flyout).getByRole("option", { name: /^Opus/ })).toHaveAttribute("aria-selected", "true");
      fireEvent.click(within(flyout).getByRole("option", { name: /^Opus/ }));
      expect(props.onModelChange).not.toHaveBeenCalled();
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Model/ }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Models" })).getByRole("option", { name: /^Haiku/ }));
      expect(props.onModelChange).toHaveBeenCalledWith("haiku");
    });

    it("has a rail with Favorites and the agent, and keeps stars on this device", () => {
      picker();
      const flyout = openModels();
      expect(within(flyout).getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Favorites", "Claude Code"]);
      fireEvent.click(within(flyout).getAllByRole("button", { name: "Add to favorites" })[2]);
      expect(JSON.parse(window.localStorage.getItem("hivra_model_favorites") || "[]")).toEqual(["claude:opus"]);
      fireEvent.click(within(flyout).getByRole("tab", { name: "Favorites" }));
      expect(within(flyout).getAllByRole("option").map((el) => el.getAttribute("aria-label"))).toEqual(["Opus, Claude Code"]);
      fireEvent.click(within(flyout).getByRole("tab", { name: "Claude Code" }));
      expect(within(flyout).getAllByRole("option")).toHaveLength(5);
    });

    it("says so when a search matches nothing, and when there are no favorites", () => {
      picker();
      const flyout = openModels();
      fireEvent.change(within(flyout).getByRole("textbox", { name: "Search models" }), { target: { value: "zzz" } });
      expect(within(flyout).getByText("No matching models")).toBeInTheDocument();
      fireEvent.click(within(flyout).getByRole("tab", { name: "Favorites" }));
      fireEvent.change(within(flyout).getByRole("textbox", { name: "Search models" }), { target: { value: "" } });
      expect(within(flyout).getByText("No favorite models")).toBeInTheDocument();
    });

    it("shows a custom model id Settings holds as the one in use", () => {
      picker({ model: "my-model", modelName: "my-model" });
      const flyout = openModels();
      expect(within(flyout).getByRole("option", { name: /^my-model/ })).toHaveAttribute("aria-selected", "true");
    });
  });

  describe("recent models", () => {
    it("remembers picks and lists them on a right-click, current model included", () => {
      const { props, rerender } = picker();
      open();
      fireEvent.click(screen.getByRole("menuitem", { name: /^Model/ }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "Models" })).getByRole("option", { name: /^Sonnet/ }));
      rerender(<ModelPicker {...props} model="sonnet" modelName="Sonnet" />);
      fireEvent.contextMenu(screen.getByRole("button", { name: /^Model:/ }));
      const menu = screen.getByRole("menu", { name: "Recently used models" });
      expect(within(menu).getAllByRole("menuitemradio").map((el) => el.textContent)).toEqual(["SonnetClaude Code"]);
      expect(within(menu).getByRole("menuitemradio", { name: /Sonnet/ })).toHaveAttribute("aria-checked", "true");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("opens the recents with Mod+. from inside the composer only", () => {
      render(
        <>
          <form data-testid="mine"><ModelPicker {...({ cliKind: "claude", modelName: "Default", model: "", models: CLAUDE_MODELS, onModelChange: jest.fn(), effortLevels: ALL, effort: null, onEffortChange: jest.fn(), hotkeys: true } as ModelPickerProps)} /><textarea aria-label="mine" /></form>
          <textarea aria-label="elsewhere" />
        </>,
      );
      fireEvent.keyDown(screen.getByLabelText("elsewhere"), { key: ".", ctrlKey: true });
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      fireEvent.keyDown(screen.getByLabelText("mine"), { key: ".", ctrlKey: true });
      expect(screen.getByRole("menu", { name: "Recently used models" })).toBeInTheDocument();
    });
  });

  describe("beside the picker", () => {
    function beside(patch: Partial<ModelPickerProps> = {}) {
      const props: ModelPickerProps = { cliKind: "claude", modelName: "Default", model: "", models: CLAUDE_MODELS, onModelChange: jest.fn(), effortLevels: ALL, effort: null, onEffortChange: jest.fn(), controlsBeside: true, ...patch };
      render(<><ModelPicker {...props} /><ModelControlPills effortLevels={props.effortLevels} effort={props.effort} onEffortChange={props.onEffortChange} effortReady={props.effortReady} effortUpdate={props.effortUpdate} onEffortUpdate={props.onEffortUpdate} /></>);
      return props;
    }

    it("opens the models straight from the trigger, with no settings in a menu", () => {
      const props = beside();
      fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      fireEvent.click(within(screen.getByRole("dialog", { name: "Models" })).getByRole("option", { name: /^Fable/ }));
      expect(props.onModelChange).toHaveBeenCalledWith("fable");
    });

    it("puts the effort on a pill of its own, effort first", () => {
      const props = beside({ effort: "high" });
      const pill = screen.getByRole("button", { name: "Effort: High" });
      fireEvent.click(pill);
      expect(levelsIn(screen.getByRole("menu", { name: "Effort" }))).toEqual(["Default", "Low", "Medium", "High", "Extra high", "Max"]);
      fireEvent.keyDown(screen.getByRole("menu", { name: "Effort" }), { key: "ArrowDown" });
      fireEvent.keyDown(screen.getByRole("menu", { name: "Effort" }), { key: "Enter" });
      expect(props.onEffortChange).toHaveBeenCalledWith("xhigh");
    });

    it("says the computer needs an update from the pill too", () => {
      const props = beside({ effortReady: false, effortUpdate: { state: "idle", message: null, available: true }, onEffortUpdate: jest.fn() });
      fireEvent.click(screen.getByRole("button", { name: "Effort: Default" }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Low" }));
      expect(screen.getByText("This computer needs a quick update to use effort levels.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Update now" }));
      expect(props.onEffortUpdate).toHaveBeenCalled();
    });

    it("has no effort pill for an agent without effort", () => {
      beside({ effortLevels: [] });
      expect(screen.queryByRole("button", { name: /^Effort/ })).not.toBeInTheDocument();
    });
  });

  it("steps to the next model, wrapping round", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(nextModel(list, "a")).toEqual({ id: "b" });
    expect(nextModel(list, "c")).toEqual({ id: "a" });
    expect(nextModel([], "a")).toBeUndefined();
  });
});
