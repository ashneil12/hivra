/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import * as Clerk from "@clerk/nextjs";
import { NativeWorkspaceProvider, useNativeWorkspaceEnabled } from "../NativeWorkspaceBridge";
import { useDashboardResources } from "../useDashboardResources";
import { ResourceSurfaceNavigation } from "@/components/hivra/ResourceSurfaceNavigation";
import type { NativeWorkspaceMessage } from "@/lib/native-workspace";

const push = jest.fn();
const router = { push };
jest.mock("next/navigation", () => ({ useRouter: () => router }));
jest.mock("../useDashboardResources", () => ({ useDashboardResources: jest.fn() }));

const host = window as Window & { __HIVRA_NATIVE_WORKSPACE__?: unknown; webkit?: unknown };
const postMessage = jest.fn<void, [NativeWorkspaceMessage]>();
const refresh = jest.fn();
const resource = { uid: "x-item", id: "item", source: "hivra", kind: "computer", name: "Desktop", description: "Ubuntu Desktop", status: "running", href: "/dashboard/agent/item?tab=desktop" };
const surfaces = [{ id: "desktop", label: "Desktop", icon: <span /> }, { id: "files", label: "Files", icon: <span /> }, { id: "manage", label: "Manage", icon: <span /> }];
const workspaceMessages = () => postMessage.mock.calls.map(([message]) => message).filter(message => message.kind === "workspace");
const surfaceMessages = () => postMessage.mock.calls.map(([message]) => message).filter(message => message.kind === "surfaces");
const send = (name: string, detail?: unknown) => {
  let accepted = false;
  act(() => { accepted = !window.dispatchEvent(new CustomEvent(name, { detail, cancelable: true })); });
  return accepted;
};

beforeEach(() => {
  host.__HIVRA_NATIVE_WORKSPACE__ = { version: 1 };
  host.webkit = { messageHandlers: { hivraWorkspace: { postMessage } } };
  jest.spyOn(jest.requireMock("@clerk/nextjs"), "useAuth").mockReturnValue({ isLoaded: true, isSignedIn: true, userId: "user_123" } as ReturnType<typeof Clerk.useAuth>);
  jest.mocked(useDashboardResources).mockReturnValue({ resources: [resource as never], loading: false, errors: { hermes: "Hermes agents could not be refreshed.", hivra: null }, refresh });
});
afterEach(() => { jest.restoreAllMocks(); delete host.__HIVRA_NATIVE_WORKSPACE__; delete host.webkit; });

function Shell({ pathname = "/dashboard/agent/item", ownerKey = "user_123", onSelect = jest.fn(), showSurfaces = true, active = "desktop" }) {
  const enabled = useNativeWorkspaceEnabled();
  return <NativeWorkspaceProvider enabled={enabled} pathname={pathname} ownerKey={ownerKey}>
    <textarea aria-label="Work draft" defaultValue="Keep this work" />
    {showSurfaces && <ResourceSurfaceNavigation surfaces={surfaces} active={active} onSelect={onSelect} exportHref="/api/hivra/agents/item/export" />}
  </NativeWorkspaceProvider>;
}

it("leaves ordinary web surface controls and data ownership unchanged", () => {
  delete host.__HIVRA_NATIVE_WORKSPACE__;
  render(<Shell />);
  expect(screen.getByRole("navigation", { name: "Resource surfaces" })).toBeInTheDocument();
  expect(useDashboardResources).not.toHaveBeenCalled();
  expect(postMessage).not.toHaveBeenCalled();
  send("hivra:navigate", { href: "/dashboard/computers" });
  send("hivra:refresh");
  expect(push).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it("publishes metadata and the actual surface list while preserving the guarded export", () => {
  render(<Shell />);
  expect(useDashboardResources).toHaveBeenCalledWith("user_123", "/dashboard/agent/item");
  expect(workspaceMessages().at(-1)).toEqual({ version: 1, kind: "workspace", ownerKey: "user_123", resources: [resource], loading: false,
    errors: { hermes: "Hermes agents could not be refreshed.", hivra: null } });
  expect(surfaceMessages().at(-1)).toEqual({ version: 1, kind: "surfaces", pathname: "/dashboard/agent/item", active: "desktop", surfaces: surfaces.map(({ id, label }) => ({ id, label })) });
  expect(screen.queryByRole("navigation", { name: "Resource surfaces" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Export data" })).toHaveAttribute("href", "/api/hivra/agents/item/export");
  send("hivra:refresh");
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("accepts only current advertised surface selections without replacing the work pane", () => {
  const onSelect = jest.fn();
  const view = render(<Shell onSelect={onSelect} />);
  const work = screen.getByRole("textbox", { name: "Work draft" });
  send("hivra:select-surface", { pathname: "/dashboard/agent/other", id: "files" });
  send("hivra:select-surface", { pathname: "/dashboard/agent/item", id: "unknown" });
  expect(onSelect).not.toHaveBeenCalled();
  send("hivra:select-surface", { pathname: "/dashboard/agent/item", id: "files" });
  expect(onSelect).toHaveBeenCalledWith("files");
  view.rerender(<Shell onSelect={onSelect} active="files" />);
  expect(screen.getByRole("textbox", { name: "Work draft" })).toBe(work);
  expect(surfaceMessages().at(-1)).toMatchObject({ active: "files" });
});

it("clears stale surfaces on route changes and on same-route removal", () => {
  const view = render(<Shell />);
  view.rerender(<Shell pathname="/dashboard/settings" showSurfaces={false} />);
  expect(surfaceMessages().at(-1)).toEqual({ version: 1, kind: "surfaces", pathname: "/dashboard/settings", active: "", surfaces: [] });
  view.rerender(<Shell pathname="/dashboard/agent/item" />);
  expect(surfaceMessages().at(-1)).toMatchObject({ active: "desktop" });
  view.rerender(<Shell showSurfaces={false} />);
  expect(surfaceMessages().at(-1)).toMatchObject({ pathname: "/dashboard/agent/item", active: "", surfaces: [] });
});

it("validates same-origin dashboard navigation before router.push", () => {
  render(<Shell />);
  for (const href of ["https://guest.example/dashboard", "/api/instances", "/dashboard/../api", "//guest.example/dashboard", "/dashboard?token=secret"]) send("hivra:navigate", { href });
  send("hivra:navigate", null);
  expect(push).not.toHaveBeenCalled();
  send("hivra:navigate", { href: `${window.location.origin}/dashboard/computers` });
  expect(push).toHaveBeenLastCalledWith("/dashboard/computers");
  send("hivra:navigate", { href: "/dashboard/launch?kind=agent&start=1" });
  expect(push).toHaveBeenLastCalledWith("/dashboard/launch?kind=agent&start=1");
  delete host.__HIVRA_NATIVE_WORKSPACE__;
  send("hivra:navigate", { href: "/dashboard/settings" });
  expect(push).toHaveBeenCalledTimes(2);
});

it("acknowledges only handled navigation, refresh, and current advertised surface events", () => {
  expect(send("hivra:navigate", { href: "/dashboard" })).toBe(false);
  expect(send("hivra:refresh")).toBe(false);
  const view = render(<Shell />);
  expect(send("hivra:navigate", { href: "https://guest.example/dashboard" })).toBe(false);
  expect(send("hivra:navigate", { href: "/dashboard" })).toBe(true);
  expect(send("hivra:refresh")).toBe(true);
  expect(send("hivra:select-surface", { pathname: "/dashboard/agent/other", id: "files" })).toBe(false);
  expect(send("hivra:select-surface", { pathname: "/dashboard/agent/item", id: "missing" })).toBe(false);
  expect(send("hivra:select-surface", { pathname: "/dashboard/agent/item", id: "files" })).toBe(true);
  jest.mocked(Clerk.useAuth).mockReturnValue({ isLoaded: true, isSignedIn: false, userId: null } as ReturnType<typeof Clerk.useAuth>);
  view.rerender(<Shell />);
  expect(send("hivra:navigate", { href: "/dashboard" })).toBe(false);
  expect(send("hivra:refresh")).toBe(false);
  expect(send("hivra:select-surface", { pathname: "/dashboard/agent/item", id: "files" })).toBe(false);
  view.unmount();
  expect(send("hivra:navigate", { href: "/dashboard" })).toBe(false);
});

it("does not publish a false signout during initial auth loading", () => {
  jest.mocked(Clerk.useAuth).mockReturnValue({ isLoaded: false, isSignedIn: undefined, userId: undefined } as ReturnType<typeof Clerk.useAuth>);
  const view = render(<Shell />);
  expect(workspaceMessages()).toEqual([]);
  expect(useDashboardResources).not.toHaveBeenCalled();
  expect(send("hivra:navigate", { href: "/dashboard/computers" })).toBe(false);
  expect(send("hivra:refresh")).toBe(false);
  jest.mocked(Clerk.useAuth).mockReturnValue({ isLoaded: true, isSignedIn: true, userId: "user_123" } as ReturnType<typeof Clerk.useAuth>);
  view.rerender(<Shell />);
  expect(workspaceMessages().at(-1)).toMatchObject({ ownerKey: "user_123", resources: [resource] });
});

it("invalidates the old owner immediately on auth changes and waits for matching server identity", () => {
  const view = render(<Shell />);
  jest.mocked(Clerk.useAuth).mockReturnValue({ isLoaded: true, isSignedIn: true, userId: "user_456" } as ReturnType<typeof Clerk.useAuth>);
  postMessage.mockClear();
  jest.mocked(useDashboardResources).mockClear();
  view.rerender(<Shell />);
  expect(workspaceMessages()).toEqual([{ version: 1, kind: "workspace", ownerKey: null, resources: [], loading: false, errors: { hermes: null, hivra: null } }]);
  expect(useDashboardResources).not.toHaveBeenCalled();
  send("hivra:navigate", { href: "/dashboard/computers" });
  expect(push).not.toHaveBeenCalled();
  jest.mocked(useDashboardResources).mockReturnValue({ resources: [], loading: true, errors: { hermes: null, hivra: null }, refresh });
  view.rerender(<Shell ownerKey="user_456" />);
  expect(workspaceMessages().at(-1)).toMatchObject({ ownerKey: "user_456", resources: [], loading: true });
  jest.mocked(Clerk.useAuth).mockReturnValue({ isLoaded: true, isSignedIn: false, userId: null } as ReturnType<typeof Clerk.useAuth>);
  view.rerender(<Shell ownerKey="user_456" />);
  expect(workspaceMessages().at(-1)).toMatchObject({ ownerKey: null, resources: [], loading: false });
});

it("clears transient surfaces without signing out the native workspace on pagehide or unmount", () => {
  const onSelect = jest.fn();
  const view = render(<Shell onSelect={onSelect} />);
  postMessage.mockClear();
  send("pagehide");
  expect(workspaceMessages()).toEqual([]);
  expect(surfaceMessages().at(-1)).toMatchObject({ active: "", surfaces: [] });
  send("pageshow");
  expect(surfaceMessages().at(-1)).toMatchObject({ active: "desktop" });
  expect(refresh).toHaveBeenCalledTimes(1);
  refresh.mockClear();
  view.unmount();
  expect(workspaceMessages()).toEqual([]);
  const count = postMessage.mock.calls.length;
  send("hivra:navigate", { href: "/dashboard" });
  send("hivra:select-surface", { pathname: "/dashboard/agent/item", id: "files" });
  send("hivra:refresh");
  send("pagehide");
  send("pageshow");
  expect(push).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledTimes(count);
});
