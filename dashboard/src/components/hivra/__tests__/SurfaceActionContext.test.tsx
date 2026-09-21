/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useState } from "react";

import {
  SurfaceActionProvider,
  createSurfaceActionStore,
  useSurfaceAction,
  useSurfaceActionStoreInstance,
  type SurfaceAction,
} from "../SurfaceActionContext";
import { SurfaceActions } from "../SurfaceActions";

function publisher(surfaceId: string | undefined, active: boolean, onClick = () => {}) {
  const actions: SurfaceAction[] = [
    { id: "open-in-new-tab", label: "Open in new tab", icon: "external-link", onSelect: onClick },
  ];
  return function Publisher() {
    useSurfaceAction(surfaceId, active, actions);
    return null;
  };
}

describe("SurfaceActionContext", () => {
  it("publishes from the active surface and reaches the bar", () => {
    const store = createSurfaceActionStore();
    const Publisher = publisher("terminal", true, () => {});
    render(
      <SurfaceActionProvider store={store}>
        <Publisher />
        <SurfaceActions surfaceId="terminal" />
      </SurfaceActionProvider>,
    );
    expect(screen.getByRole("button", { name: "Open in new tab" })).toBeInTheDocument();
  });

  it("runs the surface's own closure, so the behaviour does not move", () => {
    const store = createSurfaceActionStore();
    const onClick = jest.fn();
    const Publisher = publisher("terminal", true, onClick);
    render(
      <SurfaceActionProvider store={store}>
        <Publisher />
        <SurfaceActions surfaceId="terminal" />
      </SurfaceActionProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open in new tab" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // The naive bug this whole mechanism exists to prevent: the remote desktop
  // stays MOUNTED while you look at another surface. If a hidden surface could
  // publish, its action would appear over Files.
  it("never publishes from a surface that is mounted but not active", () => {
    const store = createSurfaceActionStore();
    const Hidden = publisher("desktop", false);
    render(
      <SurfaceActionProvider store={store}>
        <Hidden />
        <SurfaceActions surfaceId="desktop" />
      </SurfaceActionProvider>,
    );
    expect(screen.queryByRole("button", { name: "Open in new tab" })).not.toBeInTheDocument();
  });

  it("shows only the active surface's action while a hidden one stays mounted", () => {
    const store = createSurfaceActionStore();
    const Hidden = publisher("desktop", false);
    const Visible = publisher("files", true);
    const { rerender } = render(
      <SurfaceActionProvider store={store}>
        <Hidden />
        <Visible />
        <SurfaceActions surfaceId="files" />
      </SurfaceActionProvider>,
    );
    expect(screen.getAllByRole("button", { name: "Open in new tab" })).toHaveLength(1);

    // Flip which one is active — the hidden one now publishes, the other does not.
    const Hidden2 = publisher("files", false);
    const Visible2 = publisher("desktop", true);
    rerender(
      <SurfaceActionProvider store={store}>
        <Hidden2 />
        <Visible2 />
        <SurfaceActions surfaceId="desktop" />
      </SurfaceActionProvider>,
    );
    expect(screen.getAllByRole("button", { name: "Open in new tab" })).toHaveLength(1);
  });

  it("clears the slot when the surface stops being active", () => {
    const store = createSurfaceActionStore();
    const Active = publisher("terminal", true);
    const { rerender } = render(
      <SurfaceActionProvider store={store}>
        <Active />
        <SurfaceActions surfaceId="terminal" />
      </SurfaceActionProvider>,
    );
    expect(screen.getByRole("button", { name: "Open in new tab" })).toBeInTheDocument();

    const Inactive = publisher("terminal", false);
    rerender(
      <SurfaceActionProvider store={store}>
        <Inactive />
        <SurfaceActions surfaceId="terminal" />
      </SurfaceActionProvider>,
    );
    expect(screen.queryByRole("button", { name: "Open in new tab" })).not.toBeInTheDocument();
  });

  // The fallback that keeps standalone renders (component specs, surfaces mounted
  // outside this page) behaving exactly as before this existed.
  it("does not report as published when there is no store", () => {
    function Probe() {
      const { published } = useSurfaceAction("terminal", true, []);
      return <span data-testid="published">{String(published)}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId("published")).toHaveTextContent("false");
  });

  it("renders nothing without a store", () => {
    const { container } = render(<SurfaceActions surfaceId="terminal" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the disabled state in lockstep with the surface", () => {
    const store = createSurfaceActionStore();
    function DisabledPublisher() {
      useSurfaceAction("terminal", true, [
        { id: "open-in-new-tab", label: "Open in new tab", icon: "external-link", onSelect: () => {}, disabled: true },
      ]);
      return null;
    }
    render(
      <SurfaceActionProvider store={store}>
        <DisabledPublisher />
        <SurfaceActions surfaceId="terminal" />
      </SurfaceActionProvider>,
    );
    expect(screen.getByRole("button", { name: "Open in new tab" })).toBeDisabled();
  });

  // useSyncExternalStore compares snapshots by identity: a fresh object per read
  // would spin forever. This asserts the store hands back a stable reference.
  it("returns a stable snapshot across reads", () => {
    const store = createSurfaceActionStore();
    store.publish("terminal", []);
    expect(store.getSnapshot("terminal")).toBe(store.getSnapshot("terminal"));
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
  });

  // A new closure and a new array every render is what a real component has. If
  // the store treated that as a change, the bar would re-render forever; React
  // surfaces that as "Maximum update depth exceeded".
  it("does not loop when a surface re-renders with new closures but the same actions", () => {
    const store = createSurfaceActionStore();
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    function Churn() {
      const [count, set] = useState(0);
      useSurfaceAction("terminal", true, [
        { id: "open-in-new-tab", label: "Open in new tab", icon: "external-link", onSelect: () => set((n: number) => n + 1) },
      ]);
      // A re-render of this component (not of the bar) is what would loop.
      return <span data-testid="count">{count}</span>;
    }
    render(
      <SurfaceActionProvider store={store}>
        <Churn />
        <SurfaceActions surfaceId="terminal" />
      </SurfaceActionProvider>,
    );
    expect(screen.getByRole("button", { name: "Open in new tab" })).toBeInTheDocument();
    expect(screen.getByTestId("count")).toHaveTextContent("0");
    const complaints = spy.mock.calls
      .map((call) => String(call[0]))
      .filter((text) => /Maximum update depth|Too many re-renders/.test(text));
    spy.mockRestore();
    expect(complaints).toEqual([]);
  });

  it("gives each page its own store", () => {
    const stores = new Set<unknown>();
    function Probe() {
      stores.add(useSurfaceActionStoreInstance());
      return null;
    }
    const first = render(<Probe />);
    first.unmount();
    render(<Probe />);
    expect(stores.size).toBe(2);
  });

  it("releases a slot on unmount rather than leaking it", () => {
    const store = createSurfaceActionStore();
    const Active = publisher("terminal", true);
    const view = render(
      <SurfaceActionProvider store={store}>
        <Active />
        <SurfaceActions surfaceId="terminal" />
      </SurfaceActionProvider>,
    );
    expect(screen.getByRole("button", { name: "Open in new tab" })).toBeInTheDocument();
    act(() => view.unmount());
    expect(store.getSnapshot("terminal").actions).toHaveLength(0);
  });
});
