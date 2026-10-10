/** @jest-environment jsdom */
import { nativeDashboardHref, nativeWorkspaceHandler, postNativeWorkspace, workspaceMetadata } from "../native-workspace";
import type { DashboardResource } from "@/components/layout/dashboard-resources";

type HostWindow = Window & { __HIVRA_NATIVE_WORKSPACE__?: unknown; webkit?: unknown };
const host = window as HostWindow;
const origin = "https://hivra.example";

afterEach(() => { delete host.__HIVRA_NATIVE_WORKSPACE__; delete host.webkit; });

it("requires both the versioned native marker and a callable message handler", () => {
  const postMessage = jest.fn();
  expect(nativeWorkspaceHandler()).toBeNull();
  host.__HIVRA_NATIVE_WORKSPACE__ = { version: 1 };
  expect(nativeWorkspaceHandler()).toBeNull();
  host.webkit = { messageHandlers: { hivraWorkspace: { postMessage } } };
  expect(nativeWorkspaceHandler()).not.toBeNull();
  host.__HIVRA_NATIVE_WORKSPACE__ = { version: 2 };
  expect(nativeWorkspaceHandler()).toBeNull();
  delete host.__HIVRA_NATIVE_WORKSPACE__;
  expect(nativeWorkspaceHandler()).toBeNull();
  host.__HIVRA_NATIVE_WORKSPACE__ = { version: 1 };
  host.webkit = { messageHandlers: { hivraWorkspace: { postMessage: true } } };
  expect(nativeWorkspaceHandler()).toBeNull();
});

it("does not let a detached native receiver break the web surface", () => {
  host.__HIVRA_NATIVE_WORKSPACE__ = { version: 1 };
  host.webkit = { messageHandlers: { hivraWorkspace: { postMessage() { throw new Error("detached"); } } } };
  expect(() => postNativeWorkspace({ version: 1, kind: "surfaces", pathname: "/dashboard", active: "", surfaces: [] })).not.toThrow();
});

// Route families, arrival parameters and security rejections are shared with the
// Mac app in apps/shared/native-contract (native-route-grammar.test.ts).
it.each([
  ["/dashboard/agent/%69tem?tab=%66iles", "/dashboard/agent/item?tab=files"],
  ["/dashboard/launch?start=1&kind=computer", "/dashboard/launch?kind=computer&start=1"],
])("accepts and canonicalizes the app-owned dashboard route %s", (input, expected) => {
  expect(nativeDashboardHref(input)).toBe(expected);
});

it.each([
  // A native shell sends root-relative routes; an origin is never part of one.
  `${origin}/dashboard/computers`, "https://elsewhere.example/dashboard", "https://user:password@hivra.example/dashboard",
  "//hivra.example/dashboard", "javascript:alert(1)", "/dashboard/../api", "/dashboard?token=secret",
])("rejects unsafe or unsupported navigation %s", input => {
  expect(nativeDashboardHref(input)).toBeNull();
});

it("copies only the eight catalog metadata fields", () => {
  const resource = { uid: "x-item", id: "item", source: "hivra", kind: "computer", name: "Desktop",
    description: "Ubuntu Desktop", status: "running", href: "/dashboard/agent/item?tab=desktop",
    api_token: "secret", chat_url: "https://guest.example", config: { credentials: "secret" } };
  const result = workspaceMetadata([resource as DashboardResource]);
  expect(Object.keys(result[0])).toEqual(["uid", "id", "source", "kind", "name", "description", "status", "href"]);
  expect(JSON.stringify(result)).not.toMatch(/secret|guest\.example/);
  expect(result[0]).not.toBe(resource);
});
